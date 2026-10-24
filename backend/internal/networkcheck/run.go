package networkcheck

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/desktopnet"
)

const EgressURL = "https://enterprise.beefapi.com/cdn-cgi/trace"

type Options struct {
	Configuration          Configuration
	Metadata               Metadata
	SessionPath, OutputDir string
	ConsentIP              bool
	Rounds                 int
	Progress               func(string)
}
type Transfer struct {
	Route   string `json:"route"`
	Size    string `json:"size"`
	Bytes   int    `json:"bytes"`
	SHA256  string `json:"synthetic_sha256"`
	Outcome string `json:"outcome"`
	Cleanup string `json:"cleanup"`
}
type Egress struct {
	Route   string `json:"route"`
	IP      string `json:"ip,omitempty"`
	Country string `json:"country,omitempty"`
	Colo    string `json:"cloudflare_colo,omitempty"`
	Outcome string `json:"outcome"`
}
type Report struct {
	Schema            int        `json:"schema"`
	ToolVersion       string     `json:"tool_version"`
	DiagnosticID      string     `json:"diagnostic_id"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
	State             string     `json:"state"`
	Metadata          Metadata   `json:"metadata"`
	OS                string     `json:"os"`
	Architecture      string     `json:"architecture"`
	OSRelease         string     `json:"os_release"`
	ProxyMode         string     `json:"proxy_mode"`
	AutoConfigOnly    bool       `json:"auto_config_only"`
	IPConsent         bool       `json:"public_ip_collection_consented"`
	SessionID         string     `json:"session_id,omitempty"`
	SessionStatus     string     `json:"session_status"`
	PlannedBaseProbes int        `json:"planned_base_probes"`
	TrafficBytes      int64      `json:"application_body_bytes"`
	TrafficLimitBytes int64      `json:"application_body_limit_bytes"`
	Results           []Result   `json:"results"`
	Transfers         []Transfer `json:"transfers"`
	Egress            []Egress   `json:"egress,omitempty"`
	Coverage          []string   `json:"coverage_limits"`
}
type runner struct {
	mu       sync.Mutex
	report   Report
	base     string
	engine   probeEngine
	err      error
	cancel   context.CancelFunc
	progress func(string)
}

func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("secure randomness unavailable")
	}
	return hex.EncodeToString(b)
}
func seconds(d time.Duration) string { return strconv.FormatInt(int64(d/time.Second), 10) }
func intString(n int) string         { return strconv.Itoa(n) }

func Run(parent context.Context, opts Options) (string, error) {
	if err := ValidateMetadata(opts.Metadata); err != nil {
		return "", err
	}
	if opts.Rounds < 1 || opts.Rounds > 5 {
		return "", fmt.Errorf("采样轮数应为 1 到 5")
	}
	for _, t := range opts.Configuration.Targets {
		if err := ValidateTarget(t); err != nil {
			return "", err
		}
	}
	if len(opts.Configuration.Targets) < 1 || len(opts.Configuration.Targets) > 4 {
		return "", fmt.Errorf("检测目标应为 1 到 4 个")
	}
	ctx, cancel := context.WithTimeout(parent, 150*time.Second)
	defer cancel()
	status := desktopnet.ConfigurationStatus()
	now := time.Now().UTC()
	r := &runner{engine: probeEngine{proxy: desktopnet.Proxy}, cancel: cancel, progress: opts.Progress}
	r.report = Report{Schema: 2, ToolVersion: Version, DiagnosticID: randomID(), CreatedAt: now, State: "running", Metadata: opts.Metadata, OS: runtime.GOOS, Architecture: runtime.GOARCH, OSRelease: osRelease(), ProxyMode: status.Mode, AutoConfigOnly: status.AutoConfigOnly, IPConsent: opts.ConsentIP, SessionStatus: "missing; transfer not measured", PlannedBaseProbes: len(opts.Configuration.Targets) * 2 * opts.Rounds, TrafficLimitBytes: TrafficLimit, Coverage: []string{"HTTP 连通不等于登录、生成或素材业务成功；401/403 仍可表示 HTTPS 可达。", "直连仅绕过 HTTP 代理，不绕过 VPN/TUN；系统 PAC/WPAD 未执行。", "深度检测只测客户端到 COS 的合成文件 PUT、HEAD、完整 GET、DELETE；未调用业务上传完成接口。", "未测：API 服务器转存到 COS、广州校验服务、供应商读取 COS、付费生成。需用请求编号和时间继续关联服务端及供应商日志。", "应用层流量上限不含 TLS/HTTP 头及重传，不是云端费用硬封顶。", "报告仅保存在本机；用户检查后手动发送。会话文件含短期签名链接，请勿随报告转发。"}}
	if err := os.MkdirAll(opts.OutputDir, 0700); err != nil {
		return "", fmt.Errorf("无法创建报告目录")
	}
	r.base = reportBase(opts.OutputDir, r.report.DiagnosticID)
	var session *Session
	if opts.SessionPath != "" {
		s, err := LoadSession(opts.SessionPath, now)
		if err != nil {
			r.report.SessionStatus = err.Error()
		} else if opts.Metadata.Case != "" && s.Case != opts.Metadata.Case {
			r.report.SessionStatus = "支持编号与会话不一致；深度检测未执行"
		} else {
			session = s
			r.report.SessionID = s.ID
			r.report.SessionStatus = "valid"
			r.report.Metadata.Case = s.Case
		}
	}
	r.checkpoint()
	baseCtx, baseCancel := context.WithTimeout(ctx, 35*time.Second)
	r.baseRound(baseCtx, opts.Configuration, 1)
	baseCancel()
	if session != nil {
		transferCtx, transferCancel := context.WithTimeout(ctx, 100*time.Second)
		r.transfers(transferCtx, *session)
		transferCancel()
	}
	if opts.ConsentIP && ctx.Err() == nil {
		ipCtx, ipCancel := context.WithTimeout(ctx, 15*time.Second)
		r.egress(ipCtx)
		ipCancel()
	}
	for round := 2; round <= opts.Rounds && ctx.Err() == nil; round++ {
		r.baseRound(ctx, opts.Configuration, round)
	}
	if session != nil {
		// Reserve a separate bounded cleanup window, even after Ctrl+C or work timeout.
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 25*time.Second)
		r.cleanup(cleanupCtx, *session)
		cleanupCancel()
	}
	r.mu.Lock()
	r.report.State = "completed"
	if ctx.Err() != nil {
		r.report.State = "partial"
	}
	r.mu.Unlock()
	r.checkpoint()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return r.base, r.err
	}
	if err := writeBundle(r.base, r.report); err != nil {
		return r.base, err
	}
	return r.base, nil
}
func (r *runner) checkpoint() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.report.UpdatedAt = time.Now().UTC()
	if r.err == nil {
		r.err = writeJSON(r.base+".json", r.report)
		if r.err != nil {
			r.cancel()
		}
	}
}
func (r *runner) say(s string) {
	if r.progress != nil {
		r.progress(s)
	}
}
func (r *runner) request(ctx context.Context, p probeRequest) (Result, []byte) {
	r.mu.Lock()
	index := len(r.report.Results)
	r.report.Results = append(r.report.Results, Result{Target: p.target.Name, Operation: p.operation, Route: p.route, Round: p.round, Phase: "pending"})
	remaining := TrafficLimit - r.report.TrafficBytes
	r.mu.Unlock()
	if int64(len(p.body))+p.readLimit+1 > remaining {
		res := Result{Target: p.target.Name, Operation: p.operation, Route: p.route, Finished: true, Phase: "not_started", ErrorCode: "traffic_budget_exhausted"}
		r.mu.Lock()
		r.report.Results[index] = res
		r.mu.Unlock()
		r.checkpoint()
		return res, nil
	}
	p.consentIP = r.report.IPConsent
	p.diagnosticID = r.report.DiagnosticID
	res, data := r.engine.probe(ctx, p, func(part Result) { r.mu.Lock(); r.report.Results[index] = part; r.mu.Unlock(); r.checkpoint() })
	r.mu.Lock()
	r.report.Results[index] = res
	r.report.TrafficBytes += res.BodyOffered + res.BodyRead
	r.mu.Unlock()
	r.checkpoint()
	return res, data
}
func (r *runner) baseRound(ctx context.Context, c Configuration, round int) {
	for _, t := range c.Targets {
		for _, route := range []string{"beeftv", "direct"} {
			if ctx.Err() != nil {
				return
			}
			r.say(fmt.Sprintf("%s · %s · 第 %d 轮", t.Name, routeName(route), round))
			method := "HEAD"
			u, _ := url.Parse(t.URL)
			if u.Path != "/" {
				method = "GET"
			}
			r.request(ctx, probeRequest{target: t, operation: "https_connectivity", method: method, route: route, round: round, readLimit: 4096})
		}
	}
}
func (r *runner) transfers(ctx context.Context, s Session) {
	for _, o := range s.Objects {
		data := Payload(s.ID, o.Size)
		tr := Transfer{Route: o.Route, Size: o.Size, Bytes: len(data), SHA256: digest(data), Outcome: "not_measured", Cleanup: "operator_final_cleanup_pending"}
		if ctx.Err() == nil && time.Now().Before(s.PutExpiresAt) {
			r.say("合成图片上传与完整回读 · " + routeName(o.Route) + " · " + o.Size)
			put := r.objectRequest(ctx, o, "PUT", data, 4096, "")
			head := r.objectRequest(ctx, o, "HEAD", nil, 4096, "")
			tr.Outcome = "put_not_confirmed"
			if head.ErrorCode == "" && head.HTTPStatus == 200 && head.ContentLength == int64(len(data)) {
				get := r.objectRequest(ctx, o, "GET", nil, int64(len(data)), digest(data))
				tr.Outcome = "read_failed"
				if get.ErrorCode == "" && get.HTTPStatus == 200 && get.SHA256Match {
					tr.Outcome = "verified"
					if put.ErrorCode != "" || put.HTTPStatus != 200 {
						tr.Outcome = "verified_after_unconfirmed_put"
					}
				}
			} else if put.ErrorCode == "" && put.HTTPStatus == 200 {
				tr.Outcome = "head_confirmation_failed"
			}
		}
		r.mu.Lock()
		r.report.Transfers = append(r.report.Transfers, tr)
		r.mu.Unlock()
		r.checkpoint()
	}
}
func (r *runner) objectRequest(ctx context.Context, o Object, method string, body []byte, limit int64, hash string) Result {
	c := o.Requests[method]
	res, _ := r.request(ctx, probeRequest{target: Target{Name: "COS " + o.Size, URL: c.URL}, operation: "cos_" + strings.ToLower(method) + "_" + o.Size, method: method, route: o.Route, round: 1, headers: c.Headers, body: body, readLimit: limit, expectedHash: hash})
	return res
}
func (r *runner) cleanup(ctx context.Context, s Session) {
	for i, o := range s.Objects {
		if ctx.Err() != nil {
			return
		}
		c, cancel := context.WithTimeout(ctx, 6*time.Second)
		del := r.objectRequest(c, o, "DELETE", nil, 4096, "")
		head := r.objectRequest(c, o, "HEAD", nil, 4096, "")
		cancel()
		state := "cleanup_unconfirmed; operator_final_cleanup_pending"
		if del.ErrorCode == "" && (del.HTTPStatus == 204 || del.HTTPStatus == 200) && head.ErrorCode == "" && head.HTTPStatus == 404 {
			state = "absent_now; operator_final_cleanup_pending"
		}
		r.mu.Lock()
		if i < len(r.report.Transfers) {
			r.report.Transfers[i].Cleanup = state
		}
		r.mu.Unlock()
		r.checkpoint()
	}
}
func (r *runner) egress(ctx context.Context) {
	for _, route := range []string{"beeftv", "direct"} {
		if ctx.Err() != nil {
			return
		}
		p := probeRequest{target: Target{Name: "可选出口查询（BeefAPI / Cloudflare）", URL: EgressURL}, operation: "egress_ip", method: "GET", route: route, round: 1, readLimit: 4096, consentIP: true, diagnosticID: r.report.DiagnosticID}
		// The raw trace body exists only in memory, never in any report.
		res, data := r.request(ctx, p)
		e := Egress{Route: route, Outcome: "not_available"}
		if res.ErrorCode == "" && res.HTTPStatus == 200 {
			for _, line := range strings.Split(string(data), "\n") {
				k, v, ok := strings.Cut(line, "=")
				if !ok {
					continue
				}
				switch k {
				case "ip":
					e.IP = publicIP(v)
				case "loc":
					if len(v) == 2 && upperASCII(v) {
						e.Country = v
					}
				case "colo":
					if len(v) == 3 && upperASCII(v) {
						e.Colo = v
					}
				}
			}
			if e.IP != "" {
				e.Outcome = "observed"
			}
		}
		r.mu.Lock()
		r.report.Egress = append(r.report.Egress, e)
		r.mu.Unlock()
		r.checkpoint()
	}
}
func upperASCII(s string) bool {
	for _, r := range s {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}
func routeName(route string) string {
	if route == "direct" {
		return "直连（不使用 HTTP 代理）"
	}
	return "BeefTV 当前线路"
}
