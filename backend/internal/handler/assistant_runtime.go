package handler

import (
	"encoding/json"
	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/operations"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// assistantMcpServers 从本机模型配置读取用户添加的 MCP 服务器。
// 只给已鉴权的宿主进程：密钥原样返回，不经过浏览器；无效条目直接跳过。
func assistantMcpServers(svc *app.Service, includeDisabled bool) ([]map[string]any, error) {
	body, err := svc.ReadLocalModelConfig()
	if err != nil {
		return nil, err
	}
	if len(body) == 0 {
		return []map[string]any{}, nil
	}
	var snapshot struct {
		McpServers []map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(body, &snapshot); err != nil {
		return nil, app.BadAuthRequest("本地模型配置损坏")
	}
	servers := make([]map[string]any, 0, len(snapshot.McpServers))
	for _, server := range snapshot.McpServers {
		if !includeDisabled && server["enabled"] == false {
			continue
		}
		id, _ := server["id"].(string)
		if strings.TrimSpace(id) == "" {
			continue
		}
		switch transport, _ := server["transport"].(string); transport {
		case "stdio":
			if command, _ := server["command"].(string); strings.TrimSpace(command) == "" {
				continue
			}
		case "http":
			raw, _ := server["url"].(string)
			parsed, parseErr := url.Parse(strings.TrimSpace(raw))
			if parseErr != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
				continue
			}
		default:
			continue
		}
		servers = append(servers, server)
	}
	return servers, nil
}

// Runtime lifecycle is a host capability, never a model-discoverable operation.
func registerAssistantRuntimeRoutes(r gin.IRouter, svc *app.Service) {
	handle := func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) || !isAssistantHostRequest(c, svc) {
			fail(c, http.StatusForbidden, app.Forbidden("仅内置助手宿主可以恢复或结束任务"))
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		state, err := svc.AssistantTurnRuntimeState(user.ID, c.Param("turnId"))
		if err != nil {
			fail(c, http.StatusForbidden, app.Forbidden("任务不可恢复"))
			return
		}
		if c.Request.Method == http.MethodPost {
			if err := svc.FinalizeAssistantTurn(state.TurnID); err != nil {
				failService(c, err)
				return
			}
			state.Open = false
		}
		ok(c, state)
	}

	r.POST("/assistant/runtime/turns/:turnId/bind-session", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) || !isAssistantHostRequest(c, svc) {
			fail(c, http.StatusForbidden, app.Forbidden("仅内置助手宿主可以绑定会话"))
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var body struct {
			SessionID     string                  `json:"sessionId"`
			Historical    bool                    `json:"historical"`
			CurrentTurnID string                  `json:"currentTurnId"`
			Source        *operations.MediaSource `json:"source"`
		}
		decoder := json.NewDecoder(io.LimitReader(c.Request.Body, 8192))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&body) != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("会话绑定参数无效"))
			return
		}
		if err := svc.BindAssistantDurableSession(user.ID, c.Param("turnId"), body.SessionID, body.Historical); err != nil {
			failService(c, err)
			return
		}
		if body.Source != nil {
			if err := svc.RegisterAssistantNativeSource(c.Request.Context(), user.ID, body.CurrentTurnID, c.Param("turnId"), body.SessionID, *body.Source); err != nil {
				failService(c, err)
				return
			}
		}
		ok(c, map[string]any{"bound": true})
	})
	r.POST("/assistant/runtime/turns/:turnId/native-rehydrate", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) || !isAssistantHostRequest(c, svc) {
			fail(c, http.StatusForbidden, app.Forbidden("仅内置助手宿主可以恢复历史素材"))
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var body struct {
			SessionID    string                 `json:"sessionId"`
			OriginTurnID string                 `json:"originTurnId"`
			Source       operations.MediaSource `json:"source"`
		}
		decoder := json.NewDecoder(io.LimitReader(c.Request.Body, 8192))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&body) != nil || body.Source.Version == "" || body.Source.ResourceID == "" {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("历史素材参数无效"))
			return
		}
		result, err := svc.RevalidateAssistantNativeSource(c.Request.Context(), user.ID, c.Param("turnId"), body.OriginTurnID, body.SessionID, body.Source)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.GET("/assistant/runtime/turns/:turnId", handle)
	r.POST("/assistant/runtime/turns/:turnId/complete", handle)
	r.GET("/assistant/runtime/mcp-servers", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) || !isAssistantHostRequest(c, svc) {
			fail(c, http.StatusForbidden, app.Forbidden("仅内置助手宿主可以读取 MCP 服务器"))
			return
		}
		servers, err := assistantMcpServers(svc, c.Query("includeDisabled") == "1")
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"servers": servers})
	})
}
