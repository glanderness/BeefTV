package handler

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
)

// agentOpsMaxBody 限制操作请求体积，避免本机入口被大 payload 拖垮。
const agentOpsMaxBody = 1 << 20

// RegisterAgentOpsRoutes 暴露统一操作层：CLI、MCP 与内置 pi 都调用同一组端点，
// 不各自打开数据库或另起 worker。
func RegisterAgentOpsRoutes(r gin.IRouter, svc *app.Service, store *agentops.Store, clients *agentops.ClientRegistry) *agentops.Registry {
	registry := agentops.NewRegistry(svc, store)
	agentops.RegisterDefaultOps(registry)

	r.GET("/ops", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) {
			fail(c, http.StatusForbidden, app.BadAuthRequest("操作层只接受本机请求"))
			return
		}
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		readOnly, clientLabel, authErr := resolveClientMode(c, svc, clients)
		if authErr != nil {
			fail(c, http.StatusForbidden, app.BadAuthRequest(authErr.Error()))
			return
		}
		ok(c, gin.H{"ops": registry.List(readOnly), "readOnly": readOnly, "client": clientLabel})
	})

	r.POST("/ops/clients", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) {
			fail(c, http.StatusForbidden, app.BadAuthRequest("客户端登记只接受本机请求"))
			return
		}
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		if !requireOwner(c, svc) {
			return
		}
		var req struct {
			Label string `json:"label"`
			Mode  string `json:"mode"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体无效"))
			return
		}
		reg, token, err := clients.Register(req.Label, agentops.ClientMode(req.Mode))
		if err != nil {
			opErr := agentops.AsError(err)
			c.JSON(agentops.HTTPStatus(opErr.Code), gin.H{"code": agentops.HTTPStatus(opErr.Code), "reason": opErr.Reason, "msg": opErr.Message})
			return
		}
		// token 只在本次响应返回一次，服务端只保存哈希。
		ok(c, gin.H{"client": gin.H{"id": reg.ID, "label": reg.Label, "mode": reg.Mode}, "token": token})
	})

	r.GET("/ops/clients", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) {
			fail(c, http.StatusForbidden, app.BadAuthRequest("客户端登记只接受本机请求"))
			return
		}
		if !requireOwner(c, svc) {
			return
		}
		ok(c, gin.H{"clients": clients.List()})
	})

	r.POST("/ops/:op", func(c *gin.Context) {
		// 本机入口：只接受 loopback 来源，避免被浏览器跨站或外部主机调用。
		if !isLoopbackRequest(c.Request) {
			fail(c, http.StatusForbidden, app.BadAuthRequest("操作层只接受本机请求"))
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		body, err := io.ReadAll(io.LimitReader(c.Request.Body, agentOpsMaxBody+1))
		if err != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体读取失败"))
			return
		}
		if int64(len(body)) > agentOpsMaxBody {
			fail(c, http.StatusRequestEntityTooLarge, app.BadAuthRequest("请求体超过 1MB 限制"))
			return
		}
		var req struct {
			OpID     string          `json:"opId"`
			Params   json.RawMessage `json:"params"`
			ReadOnly bool            `json:"readOnly"`
		}
		if len(strings.TrimSpace(string(body))) > 0 {
			if err := json.Unmarshal(body, &req); err != nil {
				fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体不是合法 JSON"))
				return
			}
		}
		readOnly, clientLabel, authErr := resolveClientMode(c, svc, clients)
		if authErr != nil {
			fail(c, http.StatusForbidden, app.BadAuthRequest(authErr.Error()))
			return
		}
		_ = clientLabel
		result, execErr := registry.Execute(agentops.Request{
			Context: c.Request.Context(),
			OpID:    req.OpID, Op: c.Param("op"), UserID: user.ID, ReadOnly: readOnly, Params: req.Params,
		})
		if execErr != nil {
			opErr := agentops.AsError(execErr)
			c.JSON(agentops.HTTPStatus(opErr.Code), gin.H{
				"code": agentops.HTTPStatus(opErr.Code), "reason": opErr.Reason, "msg": opErr.Message,
				"details": opErr.Details,
			})
			return
		}
		ok(c, result)
	})
	return registry
}

// resolveClientMode 决定本次调用的能力模式。
// 已登记的客户端：模式完全由服务端登记决定，请求体/请求头都不能自行提升或改变。
// 未登记的本机调用（桌面/开发）：允许用请求声明的只读标志，但绝不能借它提权成写。
func resolveClientMode(c *gin.Context, svc *app.Service, clients *agentops.ClientRegistry) (bool, string, error) {
	clientID := strings.TrimSpace(c.GetHeader("X-Beeftv-Client"))
	if clientID != "" {
		token := strings.TrimSpace(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "))
		reg, found := clients.Lookup(clientID, token)
		if !found {
			return true, "", errUnknownClient
		}
		// 已登记客户端：能力模式只由服务端登记决定，请求头/请求体不能提升。
		return reg.Mode == agentops.ClientReadOnly, reg.Label, nil
	}
	// 没有客户端身份时必须是 owner 可信通道；不存在“省略 ID 即可写”的回落。
	if agentops.OwnerTokenMatches(svc.DataDir(), strings.TrimSpace(c.GetHeader("X-Beeftv-Owner"))) {
		return false, "owner", nil
	}
	return true, "", errUnidentified
}

type clientAuthError struct{ message string }

func (e clientAuthError) Error() string { return e.message }

var (
	errUnknownClient = clientAuthError{"未登记或凭据无效的 Agent 客户端"}
	errUnidentified  = clientAuthError{"缺少可信身份：需要已登记的客户端凭据或 owner 凭据"}
)

// loopbackHosts 是允许访问本机操作层的主机名；后续 Wails 正式 origin 也在这里登记。
var loopbackHosts = map[string]bool{"127.0.0.1": true, "localhost": true, "::1": true}

func isLoopbackHost(host string) bool {
	name, _, err := net.SplitHostPort(host)
	if err != nil {
		name = host // 无端口时按主机名处理
	}
	name = strings.Trim(name, "[]")
	return loopbackHosts[strings.ToLower(name)]
}

// isLoopbackRequest 精确校验来源：Host、Origin 与 RemoteAddr 都必须是本机。
// 不用子串匹配，避免 localhost.attacker.example 或任意 loopback 端口被误当成同源。
func isLoopbackRequest(r *http.Request) bool {
	if !isLoopbackHost(r.Host) {
		return false
	}
	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		remoteHost = r.RemoteAddr
	}
	if !isLoopbackHost(remoteHost) {
		return false
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	// 同源必须 host 与端口都一致：仅“是 loopback”不够，任意 loopback 端口都不算同源。
	if strings.EqualFold(parsed.Host, r.Host) {
		return true
	}
	for _, allowed := range allowedOrigins() {
		if strings.EqualFold(strings.TrimRight(allowed, "/"), strings.TrimRight(origin, "/")) {
			return true
		}
	}
	return false
}

// allowedOrigins 允许显式配置的正式前端 Origin（例如 Wails 宿主页面）。
func allowedOrigins() []string {
	raw := strings.TrimSpace(os.Getenv("BEEFTV_ALLOWED_ORIGINS"))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, item := range parts {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
