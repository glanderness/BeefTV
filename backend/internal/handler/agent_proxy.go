package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
)

// agentHostTokenPath 是内置 agent-host 的宿主凭据：只由后端读取并注入到宿主请求，
// 页面与浏览器永不接触该凭据（也不接触模型 key 与 owner 凭据）。
const agentHostTokenPath = "agent_host_token"

// agentProxyMaxBody 限制转发体积；解析失败或超限都按真实失败返回。
const agentProxyMaxBody = 64 << 10

// agentHostBaseURL 只接受本机目标：即使配置被写坏也不允许把宿主凭据发往外部主机。
func agentHostBaseURL() string {
	value := strings.TrimRight(strings.TrimSpace(os.Getenv("BEEFTV_AGENT_HOST_URL")), "/")
	if value == "" {
		return "http://127.0.0.1:18500"
	}
	parsed, err := url.Parse(value)
	if err != nil || !isLoopbackHost(parsed.Host) {
		return "http://127.0.0.1:18500"
	}
	return value
}

// agentHostClient 不跟随重定向：避免宿主凭据被转发到其他地址。
func agentHostClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

func readAgentHostToken(dataDir string) string {
	if value := strings.TrimSpace(os.Getenv("BEEFTV_AGENT_HOST_TOKEN")); value != "" {
		return value
	}
	if dataDir == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(dataDir, agentHostTokenPath))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

// RegisterAgentProxyRoutes 让浏览器通过同源后端使用内置创作助手：
// 页面只发业务消息，宿主凭据由后端注入；宿主不可用时返回明确状态而不是空回复。
func RegisterAgentProxyRoutes(r gin.IRouter, svc *app.Service, clients *agentops.ClientRegistry, ui *uiSessionStore) {
	client := agentHostClient(10 * time.Minute)

	guard := func(c *gin.Context, requireWrite bool) bool {
		// 与 /agent-ops 完全相同的来源校验：Host/RemoteAddr/Origin 都必须是本机且同源。
		if !isLoopbackRequest(c.Request) {
			c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "reason": "forbidden", "msg": "内置助手入口只接受本机同源请求"})
			return false
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return false
		}
		c.Set("agentUserId", user.ID)
		// 身份层：必须是内置 UI 会话或已登记客户端；CSRF 层只是附加约束。
		readOnly, identity, authed, reason := resolveAgentCapability(c, svc, clients, ui, user.ID)
		if !authed {
			c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "reason": "unauthenticated", "msg": reason})
			return false
		}
		c.Set("agentIdentity", identity)
		if requireWrite && readOnly {
			// 已登记的只读客户端（或声明只读的调用）不能借代理拿到宿主写权限。
			c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "reason": "read_only_client", "msg": "只读客户端不能通过内置助手发起写操作"})
			return false
		}
		return true
	}

	status := func(c *gin.Context) {
		token := readAgentHostToken(svc.DataDir())
		state := gin.H{"available": false, "reason": "host_token_missing", "url": agentHostBaseURL()}
		if token != "" {
			req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, agentHostBaseURL()+"/health", nil)
			if err == nil {
				req.Header.Set("X-Beeftv-Agent-Token", token)
				if resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req); err == nil {
					defer resp.Body.Close()
					if resp.StatusCode == http.StatusOK {
						body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
						state = gin.H{"available": true, "url": agentHostBaseURL(), "health": jsonOrString(body)}
					} else {
						state = gin.H{"available": false, "reason": "host_unhealthy", "status": resp.StatusCode, "url": agentHostBaseURL()}
					}
				} else {
					state = gin.H{"available": false, "reason": "host_unreachable", "url": agentHostBaseURL()}
				}
			}
		}
		ok(c, state)
	}
	guardedStatus := func(c *gin.Context) {
		// 状态查询不含任何凭据，只做本机同源校验：面板需要它在未签发会话时也能显示"未就绪"。
		if !isLoopbackRequest(c.Request) {
			c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "reason": "forbidden"})
			return
		}
		status(c)
	}
	r.GET("/agent/status", guardedStatus)
	r.GET("/agent/health", guardedStatus)

	r.POST("/agent/chat", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		token := readAgentHostToken(svc.DataDir())
		if token == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_token_missing",
				"msg": "内置创作助手宿主未配置：请由产品启动链启动 agent-host 并提供宿主凭据"})
			return
		}
		body, err := io.ReadAll(io.LimitReader(c.Request.Body, agentProxyMaxBody+1))
		if err != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体读取失败"))
			return
		}
		if int64(len(body)) > agentProxyMaxBody {
			fail(c, http.StatusRequestEntityTooLarge, app.BadAuthRequest("请求体超过限制"))
			return
		}
		var payload struct {
			CanvasID string `json:"canvasId"`
			Message  string `json:"message"`
		}
		if err := json.Unmarshal(body, &payload); err != nil || strings.TrimSpace(payload.CanvasID) == "" || strings.TrimSpace(payload.Message) == "" {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("canvasId 与 message 必填"))
			return
		}
		// scope 先验证：只能操作当前用户确实拥有的画布，再转发给宿主。
		if _, err := svc.UserCanvasProject(c.GetString("agentUserId"), payload.CanvasID); err != nil {
			fail(c, http.StatusNotFound, app.BadAuthRequest("画布不存在或不属于当前工作区"))
			return
		}
		upstream, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost,
			agentHostBaseURL()+"/chat", strings.NewReader(string(body)))
		if err != nil {
			fail(c, http.StatusInternalServerError, app.BadAuthRequest("无法构造宿主请求"))
			return
		}
		upstream.Header.Set("Content-Type", "application/json")
		upstream.Header.Set("X-Beeftv-Agent-Token", token)
		resp, err := client.Do(upstream)
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable",
				"msg": "内置创作助手宿主未运行"})
			return
		}
		defer resp.Body.Close()
		c.Status(resp.StatusCode)
		c.Header("Content-Type", resp.Header.Get("Content-Type"))
		c.Stream(func(w io.Writer) bool {
			buf := make([]byte, 4096)
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				if _, writeErr := w.Write(buf[:n]); writeErr != nil {
					return false
				}
			}
			return readErr == nil
		})
	})

	r.POST("/agent/cancel", func(c *gin.Context) {
		if !guard(c, false) {
			return
		}
		token := readAgentHostToken(svc.DataDir())
		if token == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_token_missing"})
			return
		}
		body, err := io.ReadAll(io.LimitReader(c.Request.Body, agentProxyMaxBody+1))
		if err != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体读取失败"))
			return
		}
		if int64(len(body)) > agentProxyMaxBody {
			fail(c, http.StatusRequestEntityTooLarge, app.BadAuthRequest("请求体超过限制"))
			return
		}
		upstream, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost,
			agentHostBaseURL()+"/cancel", strings.NewReader(string(body)))
		if err != nil {
			fail(c, http.StatusInternalServerError, app.BadAuthRequest("无法构造宿主请求"))
			return
		}
		upstream.Header.Set("Content-Type", "application/json")
		upstream.Header.Set("X-Beeftv-Agent-Token", token)
		resp, err := client.Do(upstream)
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable"})
			return
		}
		defer resp.Body.Close()
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		c.Data(resp.StatusCode, "application/json", payload)
	})
}

func jsonOrString(raw []byte) any {
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "{") {
		return gin.H{"raw": trimmed}
	}
	return trimmed
}
