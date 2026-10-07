package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/runtimeinfo"
)

// 地址来源标识：resolveBaseURL 返回、client 记录，用于决定是否允许自动切换地址。
const (
	baseSourceEnv     = "BEEFTV_BASE_URL"
	baseSourceRuntime = "运行中的桌面工作区"
	baseSourceMissing = "未发现运行中的工作区"
)

type client struct {
	// mu 只保护 baseURL 与 baseURLSrc：MCP 工具 handler 会被 SDK 并发调用，
	// 多个请求可能同时触发地址重发现。其余字段构造后只读。
	mu           sync.Mutex
	baseURL      string
	baseURLSrc   string
	clientID     string
	token        string
	ownerToken   string
	desktopToken string
	http         *http.Client
}

type opDescriptor struct {
	ID       string          `json:"id"`
	Summary  string          `json:"summary"`
	ReadOnly bool            `json:"readOnly"`
	Scope    string          `json:"scope"`
	Params   json.RawMessage `json:"params"`
}

// resolveBaseURL 决定连哪个工作区，并说明来源（诊断输出用，不含任何凭据）。
//
// 桌面应用监听的是动态端口，所以没有显式 BEEFTV_BASE_URL 时不去猜端口，而是读数据
// 目录对应的运行时描述文件：那是正在运行的桌面后端自己写下的地址。文件里的进程已经退出
// 就当它不存在，绝不拿一个过期端口去连别的进程。
func resolveBaseURL() (string, string) {
	if base := strings.TrimSpace(os.Getenv("BEEFTV_BASE_URL")); base != "" {
		return base, baseSourceEnv
	}
	if info, found := runtimeinfo.Discover(""); found {
		return info.BaseURL, baseSourceRuntime
	}
	return "", baseSourceMissing
}

// validateBaseURL 校验并规范化工作区地址：仅本机 http(s)、不带凭据。
// 启动构造与运行期重发现共用同一套校验，重发现不盲信 runtime.json 的内容。
func validateBaseURL(base string) (string, error) {
	parsed, parseErr := url.Parse(base)
	if parseErr != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", &cliError{code: exitUsage, reason: "invalid_base_url", msg: "工作区地址不是合法 URL"}
	}
	if parsed.User != nil {
		return "", &cliError{code: exitUsage, reason: "credentials_in_url", msg: "拒绝对带凭据的 URL 发请求"}
	}
	host := parsed.Hostname()
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return "", &cliError{code: exitUsage, reason: "base_url_not_local", msg: "首版仅支持连接本机工作区，拒绝 " + host}
	}
	return strings.TrimRight(base, "/"), nil
}

func newClient() (*client, error) {
	base, src := resolveBaseURL()
	// http.Client 与地址无关：base 为空时也要先建好，重发现成功后才能直接发请求。
	c := &client{
		clientID:   strings.TrimSpace(os.Getenv("BEEFTV_CLIENT_ID")),
		token:      strings.TrimSpace(os.Getenv("BEEFTV_CLIENT_TOKEN")),
		ownerToken: strings.TrimSpace(os.Getenv("BEEFTV_OWNER_TOKEN")),
		// 桌面形态整个 API 由桌面启动令牌把关：CLI/MCP 要接同一个桌面工作区就必须出示它。
		// 它只是通过守卫，不改变能力模式——能力仍由 owner/已登记客户端凭据决定。
		desktopToken: strings.TrimSpace(os.Getenv("BEEFTV_DESKTOP_TOKEN")),
		// 凭据头是自定义敏感头，不能依赖标准库只保护 Authorization 的行为：一律不跟随重定向。
		http: &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}
	if base == "" {
		// 没有可用工作区时仍允许构造：--help 离线可用，留待第一次操作时重发现或报错。
		return c, nil
	}
	normalized, err := validateBaseURL(base)
	if err != nil {
		return nil, err
	}
	c.baseURL = normalized
	c.baseURLSrc = src
	return c, nil
}

// do 发一次操作请求；transport 层失败时重新发现工作区地址并最多重试一次。
// 桌面形态每次启动端口都会变：BeefTV 重启换端口后，运行中的 CLI/MCP 进程靠这里
// 跟上新地址，不需要重启会话。写操作的幂等键保证重试安全。
func (c *client) do(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	baseBefore := c.currentBaseURL()
	raw, err := c.doOnce(ctx, method, path, body)
	if !shouldRediscover(ctx, err) {
		return raw, err
	}
	c.refreshBaseURL()
	// 地址有变化才重试：可能是自己刷新的，也可能是并发请求抢先刷新的。
	if c.currentBaseURL() == baseBefore {
		return raw, err
	}
	return c.doOnce(ctx, method, path, body)
}

// doOnce 用当前地址发一次请求，不做任何重试。
func (c *client) doOnce(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	base := c.currentBaseURL()
	if base == "" {
		return nil, &cliError{code: exitTransportFailure, reason: "runtime_not_found", msg: "未发现运行中的 BeefTV 工作区。请先打开 BeefTV；若使用自定义目录，请检查 BEEFTV_DATA_DIR；独立服务请显式设置 BEEFTV_BASE_URL"}
	}
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, &cliError{code: exitInternal, reason: "encode_failed", msg: err.Error()}
		}
		payload = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, payload)
	if err != nil {
		return nil, &cliError{code: exitUsage, reason: "bad_request", msg: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	if c.clientID != "" {
		req.Header.Set("X-Beeftv-Client", c.clientID)
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if c.ownerToken != "" {
		req.Header.Set("X-Beeftv-Owner", c.ownerToken)
	}
	if c.desktopToken != "" {
		req.Header.Set("X-Desktop-Token", c.desktopToken)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &cliError{code: exitTransportFailure, reason: "transport_failed", msg: fmt.Sprintf("无法连接本地工作区 %s：%v", base, err)}
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if readErr != nil {
		return nil, &cliError{code: exitTransportFailure, reason: "read_failed", msg: readErr.Error()}
	}
	if resp.StatusCode == http.StatusOK {
		var envelope struct {
			Code    int             `json:"code"`
			Data    json.RawMessage `json:"data"`
			Reason  string          `json:"reason"`
			Msg     string          `json:"msg"`
			Details map[string]any  `json:"details"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil || len(envelope.Data) == 0 {
			return nil, &cliError{code: exitInternal, reason: "invalid_envelope", msg: strings.TrimSpace(string(raw[:min(len(raw), 200)]))}
		}
		if envelope.Code != 0 {
			return nil, mapEnvelopeError(envelope.Code, envelope.Reason, envelope.Msg, envelope.Details)
		}
		return envelope.Data, nil
	}
	var failure struct {
		Code    int            `json:"code"`
		Reason  string         `json:"reason"`
		Msg     string         `json:"msg"`
		Details map[string]any `json:"details"`
	}
	_ = json.Unmarshal(raw, &failure)
	return nil, mapEnvelopeError(resp.StatusCode, failure.Reason, failure.Msg, failure.Details)
}

// shouldRediscover 只对「连不上」类失败触发重发现：业务错误（HTTP 有响应）说明地址本身
// 是对的，重新发现没有意义；调用方已取消的请求也不再补发第二次。
func shouldRediscover(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	cliErr, ok := err.(*cliError)
	if !ok {
		return false
	}
	return cliErr.reason == "runtime_not_found" || cliErr.reason == "transport_failed"
}

// refreshBaseURL 尽力把地址跟上最新发现。显式 BEEFTV_BASE_URL 是调用方钉死的配置，
// 永不自动切换；新地址必须通过与启动时相同的校验，失败则保持原地址等下次再试。
func (c *client) refreshBaseURL() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.baseURLSrc == baseSourceEnv {
		return
	}
	base, src := resolveBaseURL()
	if base == "" {
		return
	}
	normalized, err := validateBaseURL(base)
	if err != nil || normalized == c.baseURL {
		return
	}
	c.baseURL = normalized
	c.baseURLSrc = src
}

func (c *client) currentBaseURL() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.baseURL
}

// baseURLInfo 给出地址快照与来源（诊断输出用）：没有可用地址时如实说明。
func (c *client) baseURLInfo() (string, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.baseURL == "" {
		return "", baseSourceMissing
	}
	return c.baseURL, c.baseURLSrc
}

// listOps 拉取操作清单。
//
// 服务端已经按调用者身份（登记客户端权限/owner）返回基础集合；`--read-only` 在这里
// 只做本地收紧：即使服务端因为任何原因返回了写操作，只读模式也绝不把它们交给
// MCP 或调用方。查询参数不能用于放宽权限，所以客户端不再发送它。
func (c *client) listOps(readOnly bool) ([]opDescriptor, error) {
	return c.listOpsCtx(context.Background(), readOnly)
}

func (c *client) listOpsCtx(ctx context.Context, readOnly bool) ([]opDescriptor, error) {
	raw, err := c.do(ctx, http.MethodGet, "/ops", nil)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Ops []opDescriptor `json:"ops"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, &cliError{code: exitInternal, reason: "invalid_ops_payload", msg: err.Error()}
	}
	if !readOnly {
		return payload.Ops, nil
	}
	tightened := make([]opDescriptor, 0, len(payload.Ops))
	for _, op := range payload.Ops {
		if op.ReadOnly {
			tightened = append(tightened, op)
		}
	}
	return tightened, nil
}

func (c *client) callOp(opID, requestID string, params json.RawMessage) (json.RawMessage, error) {
	return c.callOpCtx(context.Background(), opID, requestID, params)
}

func (c *client) callOpCtx(ctx context.Context, opID, requestID string, params json.RawMessage) (json.RawMessage, error) {
	body := map[string]any{"opId": requestID, "params": json.RawMessage(params)}
	return c.do(ctx, http.MethodPost, "/ops/"+opID, body)
}

func mapEnvelopeError(status int, reason, msg string, details map[string]any) error {
	code := exitInternal
	switch status {
	case http.StatusNotFound:
		code = exitNotFound
	case http.StatusConflict:
		code = exitConflict
	case http.StatusPreconditionFailed:
		code = exitPrecondition
	case http.StatusForbidden:
		code = exitForbidden
	case http.StatusUnsupportedMediaType:
		code = exitUnsupported
	case http.StatusBadRequest:
		code = exitBadRequest
	case http.StatusUnauthorized, http.StatusTooManyRequests:
		code = exitForbidden
	}
	if msg == "" {
		msg = http.StatusText(status)
	}
	if len(details) > 0 {
		encoded, _ := json.Marshal(details)
		msg = msg + " " + string(encoded)
	}
	return &cliError{code: code, reason: reason, msg: msg, details: details}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
