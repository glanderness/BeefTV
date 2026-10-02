package handler

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantruntime"
	httptransport "infinite-canvas/backend/internal/transport/http"
)

// agentProxyMaxBody 限制转发体积；解析失败或超限都按真实失败返回。
const agentProxyMaxBody = 64 << 10

// hostStartGrace 是宿主从拉起到健康的宽限期：这段时间里状态是「正在启动」而不是「不可达」。
const hostStartGrace = 20 * time.Second

// agentHostClient 不跟随重定向：避免宿主凭据被转发到其他地址。
func agentHostClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

// newTurnID 是一轮对话的稳定标识：按轮撤销与历史都用它对齐。
func newTurnID() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format("20060102150405.000000000")))
	}
	return hex.EncodeToString(buf)
}

// RegisterAgentProxyRoutes 让浏览器通过同源后端使用内置创作助手：
// 页面只发业务消息，宿主凭据由后端注入；宿主不可用时返回明确状态而不是空回复。
func RegisterAgentProxyRoutes(r gin.IRouter, svc *app.Service, clients *agentops.ClientRegistry, ui *uiSessionStore, host *assistantruntime.Host) {
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

	// hostOpsURL 用请求自身的 Host 推导操作层基址：桌面形态监听随机端口，猜端口会指向别处。
	hostOpsURL := func(c *gin.Context) string { return "http://" + c.Request.Host + "/api" }
	launchToken := func(c *gin.Context) string { return strings.TrimSpace(c.GetHeader(httptransport.LaunchTokenHeader)) }

	unavailable := func(c *gin.Context, reason string) {
		ok(c, gin.H{"available": false, "reason": reason})
	}

	status := func(c *gin.Context) {
		if host == nil {
			unavailable(c, "host_unreachable")
			return
		}
		provider, reason := host.ResolveProvider()
		if reason != "" {
			unavailable(c, reason)
			return
		}
		modelInfo := gin.H{"id": provider.Model, "channelId": provider.ChannelID, "channelName": provider.ChannelName}
		health := host.Probe(c.Request.Context())
		state := host.State()
		if health.OK {
			if state.Fingerprint != "" && state.Fingerprint != provider.Fingerprint() {
				if health.Busy {
					ok(c, gin.H{"available": false, "reason": "host_busy", "model": gin.H{"id": health.Model}})
					return
				}
				if err := host.Restart(provider, hostOpsURL(c), launchToken(c)); err != nil {
					unavailable(c, "host_start_failed")
					return
				}
				ok(c, gin.H{"available": false, "reason": "host_starting", "model": modelInfo})
				return
			}
			ok(c, gin.H{"available": true, "model": modelInfo})
			return
		}
		if state.Running {
			// 探测超时或失败不是空闲证据，不能授权杀掉仍在跑的子进程。
			// 用户显式 POST /assistant/host/restart 才是重试。
			if time.Since(state.LaunchedAt) < hostStartGrace {
				ok(c, gin.H{"available": false, "reason": "host_starting", "model": modelInfo})
				return
			}
			ok(c, gin.H{"available": false, "reason": "host_unreachable", "model": modelInfo})
			return
		}
		launched, err := host.Ensure(provider, hostOpsURL(c), launchToken(c), true)
		if err != nil {
			ok(c, gin.H{"available": false, "reason": "host_start_failed", "model": modelInfo})
			return
		}
		if launched || (state.Running && time.Since(state.LaunchedAt) < hostStartGrace) {
			ok(c, gin.H{"available": false, "reason": "host_starting", "model": modelInfo})
			return
		}
		ok(c, gin.H{"available": false, "reason": "host_unreachable", "model": modelInfo})
	}
	guardedStatus := func(c *gin.Context) {
		// 状态查询不含任何凭据，只做本机同源校验：面板需要它在未签发会话时也能显示"未就绪"。
		if !isLoopbackRequest(c.Request) {
			c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "reason": "forbidden"})
			return
		}
		status(c)
	}
	r.GET("/assistant/status", guardedStatus)
	r.GET("/assistant/health", guardedStatus)

	r.POST("/assistant/host/restart", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		if missingAssistantHost(c, host) {
			return
		}
		provider, reason := host.ResolveProvider()
		if reason != "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": reason,
				"msg": "助手模型或凭据还没准备好"})
			return
		}
		if err := host.Restart(provider, hostOpsURL(c), launchToken(c)); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_start_failed", "msg": err.Error()})
			return
		}
		ok(c, gin.H{"restarted": true})
	})

	// hostJSON 把一次 JSON 请求转给宿主并原样回传业务结果；宿主凭据只在这里注入。
	hostJSON := func(c *gin.Context, method, path string, body []byte) {
		if host == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable",
				"msg": "内置创作助手宿主未运行"})
			return
		}
		var reader io.Reader
		if body != nil {
			reader = strings.NewReader(string(body))
		}
		upstream, err := host.NewChildRequest(c.Request.Context(), method, path, reader)
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable",
				"msg": "内置创作助手宿主未运行"})
			return
		}
		upstream.Header.Set("Content-Type", "application/json")
		resp, err := agentHostClient(30 * time.Second).Do(upstream)
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable",
				"msg": "内置创作助手宿主未运行"})
			return
		}
		defer resp.Body.Close()
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		var decoded any
		if err := json.Unmarshal(payload, &decoded); err != nil {
			fail(c, http.StatusBadGateway, app.BadAuthRequest("宿主返回的不是合法 JSON"))
			return
		}
		if resp.StatusCode/100 != 2 {
			reason := "host_unreachable"
			if body, isObject := decoded.(map[string]any); isObject {
				if value, found := body["reason"].(string); found && value != "" {
					reason = value
				}
			}
			c.JSON(resp.StatusCode, gin.H{"code": resp.StatusCode, "reason": reason, "msg": "内置创作助手宿主拒绝了该请求"})
			return
		}
		if strings.HasPrefix(path, "/history?") {
			if history, ok := decoded.(map[string]any); ok {
				turns, _ := history["turns"].([]any)
				for _, value := range turns {
					if turn, ok := value.(map[string]any); ok {
						turnID, _ := turn["turnId"].(string)
						state, err := svc.ReadAssistantTurnHistoryState(c.GetString("agentUserId"), strings.TrimSpace(c.Query("canvasId")), turnID)
						if err != nil {
							failService(c, err)
							return
						}
						if state != nil {
							turn["undone"] = state.Undone
							turn["change"] = state.Change
						}
					}
				}
			}
		}
		ok(c, decoded)
	}

	// requireOwnedCanvas 先验证 scope：只能操作当前用户确实拥有的画布，再转发给宿主。
	requireOwnedCanvas := func(c *gin.Context, canvasID string) (json.RawMessage, bool) {
		if strings.TrimSpace(canvasID) == "" {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("canvasId 必填"))
			return nil, false
		}
		raw, err := svc.UserCanvasProject(c.GetString("agentUserId"), canvasID)
		if err != nil {
			fail(c, http.StatusNotFound, app.BadAuthRequest("画布不存在或不属于当前工作区"))
			return nil, false
		}
		return raw, true
	}

	r.GET("/assistant/sessions", func(c *gin.Context) {
		if !guard(c, false) {
			return
		}
		canvasID := strings.TrimSpace(c.Query("canvasId"))
		if _, allowed := requireOwnedCanvas(c, canvasID); !allowed {
			return
		}
		hostJSON(c, http.MethodGet, "/sessions?canvasId="+url.QueryEscape(canvasID), nil)
	})

	r.POST("/assistant/sessions", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		body, payload, valid := readAssistantBody(c, struct {
			CanvasID string `json:"canvasId"`
		}{})
		if !valid {
			return
		}
		if _, allowed := requireOwnedCanvas(c, payload.CanvasID); !allowed {
			return
		}
		hostJSON(c, http.MethodPost, "/sessions", body)
	})

	r.POST("/assistant/sessions/activate", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		body, payload, valid := readAssistantBody(c, struct {
			CanvasID  string `json:"canvasId"`
			SessionID string `json:"sessionId"`
		}{})
		if !valid {
			return
		}
		if _, allowed := requireOwnedCanvas(c, payload.CanvasID); !allowed {
			return
		}
		hostJSON(c, http.MethodPost, "/sessions/activate", body)
	})

	r.GET("/assistant/history", func(c *gin.Context) {
		if !guard(c, false) {
			return
		}
		canvasID := strings.TrimSpace(c.Query("canvasId"))
		if _, allowed := requireOwnedCanvas(c, canvasID); !allowed {
			return
		}
		query := "/history?canvasId=" + url.QueryEscape(canvasID)
		if sessionID := strings.TrimSpace(c.Query("sessionId")); sessionID != "" {
			query += "&sessionId=" + url.QueryEscape(sessionID)
		}
		hostJSON(c, http.MethodGet, query, nil)
	})

	r.POST("/assistant/turns/:turnId/undo", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		_, payload, valid := readAssistantBody(c, struct {
			CanvasID string `json:"canvasId"`
		}{})
		if !valid {
			return
		}
		if _, allowed := requireOwnedCanvas(c, payload.CanvasID); !allowed {
			return
		}
		revision, err := svc.UndoAssistantTurn(c.GetString("agentUserId"), payload.CanvasID, c.Param("turnId"))
		if err != nil {
			var turnErr *app.AssistantTurnError
			if errors.As(err, &turnErr) {
				status := http.StatusConflict
				if turnErr.Reason == app.AssistantTurnReasonNotFound {
					status = http.StatusNotFound
				}
				c.JSON(status, gin.H{"code": status, "reason": turnErr.Reason, "msg": turnErr.Error()})
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"revision": revision})
	})

	r.POST("/assistant/chat", func(c *gin.Context) {
		// Only failures before BeginAssistantTurn prove no business turn was admitted.
		c.Header("X-Beeftv-Turn-Admission", "rejected")
		if !guard(c, true) {
			return
		}
		if host == nil || host.Endpoint() == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable",
				"msg": "内置创作助手宿主未运行"})
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
			CanvasID        string               `json:"canvasId"`
			Message         string               `json:"message"`
			SelectedNodeIDs []string             `json:"selectedNodeIds"`
			SessionID       string               `json:"sessionId"`
			References      []assistantReference `json:"references"`
		}
		if err := json.Unmarshal(body, &payload); err != nil || strings.TrimSpace(payload.CanvasID) == "" || strings.TrimSpace(payload.Message) == "" {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("canvasId 与 message 必填"))
			return
		}
		canvasRaw, allowed := requireOwnedCanvas(c, payload.CanvasID)
		if !allowed {
			return
		}
		// 额外素材/画布引用必须由界面明确请求：这里校验归属，校验不过就整轮拒绝，
		// 不把「模型说可以读」当成授权。
		references, refErr := normalizeAssistantReferences(svc, c.GetString("agentUserId"), payload.References)
		if refErr != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest(refErr.Error()))
			return
		}
		// 选中对象必须真的属于该画布，否则拒绝（不能借选中绕过 scope）。
		if len(payload.SelectedNodeIDs) > 0 {
			var canvasDoc struct {
				Nodes []struct {
					ID string `json:"id"`
				} `json:"nodes"`
			}
			if err := json.Unmarshal(canvasRaw, &canvasDoc); err != nil {
				fail(c, http.StatusInternalServerError, app.BadAuthRequest("画布内容无法解析"))
				return
			}
			owned := make(map[string]bool, len(canvasDoc.Nodes))
			for _, node := range canvasDoc.Nodes {
				owned[node.ID] = true
			}
			for _, id := range payload.SelectedNodeIDs {
				if !owned[id] {
					fail(c, http.StatusBadRequest, app.BadAuthRequest("选中的对象不属于当前画布: "+id))
					return
				}
			}
		}
		// 轮前快照在转发之前就落盘：宿主没有画布持久化通道，这个前提只能由后端建立，
		// 否则撤销会拿不到「这轮开始之前」的文档。范围也只在这里验证并持久化：
		// 之后的操作入口按这条记录读授权，宿主与模型都无法自报。
		turnID := newTurnID()
		c.Header("X-Beeftv-Turn-Admission", "unknown")
		revisionBefore, snapshotErr := svc.BeginAssistantTurn(c.GetString("agentUserId"), payload.CanvasID, turnID,
			assistantTurnInput(payload.SelectedNodeIDs, references))
		if snapshotErr != nil {
			failService(c, snapshotErr)
			return
		}
		c.Header("X-Beeftv-Turn-Admission", "admitted")
		// 回合状态由自己的回执结算，和浏览器流是两件事：无论下面走哪条返回路径
		// （宿主不可达、宿主拒绝、浏览器中途断开、正常结束），都已经落地的操作都要可追溯。
		defer settleAssistantTurn(turnID, svc)
		forwarded, err := withTurnEnvelope(body, turnID, revisionBefore, references)
		if err != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体不是合法 JSON"))
			return
		}
		// 上游请求与浏览器连接解耦：用户中途关页面/点停止不能让已经落地的写入丢掉回合归属。
		upstream, err := host.NewChildRequest(context.WithoutCancel(c.Request.Context()), http.MethodPost, "/chat",
			strings.NewReader(string(forwarded)))
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable",
				"msg": "内置创作助手宿主未运行"})
			return
		}
		upstream.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(upstream)
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable",
				"msg": "内置创作助手宿主未运行"})
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			// 宿主拒绝这次对话时没有流可转：按统一失败信封回，reason 保持宿主给的机器可读原因。
			payload, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
			var rejection struct {
				Reason string `json:"reason"`
			}
			_ = json.Unmarshal(payload, &rejection)
			reason := strings.TrimSpace(rejection.Reason)
			if reason == "" {
				reason = "host_unreachable"
			}
			c.JSON(resp.StatusCode, gin.H{"code": resp.StatusCode, "reason": reason, "msg": "内置创作助手宿主拒绝了这次对话"})
			return
		}
		c.Status(resp.StatusCode)
		c.Header("Content-Type", resp.Header.Get("Content-Type"))
		c.Writer.WriteHeaderNow()
		// 按行转发 NDJSON：写不回浏览器只停止转发，不停止读取与回合结算。
		reader := bufio.NewReaderSize(resp.Body, 32<<10)
		clientGone := false
		for {
			line, readErr := reader.ReadBytes('\n')
			if len(line) > 0 && !clientGone {
				if _, writeErr := c.Writer.Write(line); writeErr != nil {
					clientGone = true
				} else {
					c.Writer.Flush()
				}
			}
			if readErr != nil {
				return
			}
		}
	})

	r.POST("/assistant/cancel", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		body, payload, valid := readAssistantBody(c, struct {
			CanvasID string `json:"canvasId"`
		}{})
		if !valid {
			return
		}
		if _, allowed := requireOwnedCanvas(c, payload.CanvasID); !allowed {
			return
		}
		hostJSON(c, http.MethodPost, "/cancel", body)
	})
}

// readAssistantBody 读取并解析小型 JSON 请求体，返回原文与解析结果（原文用于原样转给宿主）。
func readAssistantBody[T any](c *gin.Context, shape T) ([]byte, T, bool) {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, agentProxyMaxBody+1))
	if err != nil {
		fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体读取失败"))
		return nil, shape, false
	}
	if int64(len(body)) > agentProxyMaxBody {
		fail(c, http.StatusRequestEntityTooLarge, app.BadAuthRequest("请求体超过限制"))
		return nil, shape, false
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		body = []byte("{}")
	}
	if err := json.Unmarshal(body, &shape); err != nil {
		fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体不是合法 JSON"))
		return nil, shape, false
	}
	return body, shape, true
}

// withTurnEnvelope 把后端决定的轮次标识、轮前版本与已校验的额外引用补进转发体：
// 这三个值必须由后端生成/校验，宿主不能自报轮次身份，模型也不能自授引用。
func withTurnEnvelope(body []byte, turnID string, revisionBefore int64, references []assistantReference) ([]byte, error) {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	payload["turnId"] = turnID
	payload["revisionBefore"] = revisionBefore
	if len(references) > 0 {
		payload["references"] = references
	} else {
		delete(payload, "references")
	}
	return json.Marshal(payload)
}

// settleAssistantTurn 结算一轮对话：回合状态完全由后端自己的操作回执重建，
// 因此不依赖浏览器是否还连着、也不依赖宿主最后一条消息是否读到。
func settleAssistantTurn(turnID string, svc *app.Service) {
	if err := svc.FinalizeAssistantTurn(turnID); err != nil {
		log.Printf("assistant_turn_settle_failed turn=%q error_type=%T", turnID, err)
	}
}
