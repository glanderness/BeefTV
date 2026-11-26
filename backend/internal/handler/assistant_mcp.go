package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantmcp"
	"infinite-canvas/backend/internal/assistantruntime"
)

// RegisterAssistantMCPRoutes exposes external MCP server configuration for BeefTV's
// built-in assistant. Secrets are encrypted at rest in assistant-mcp-servers.json
// and never sent back to browser APIs; only the local agent-host process can read
// decrypted credentials via /assistant/runtime/mcp-servers.
func RegisterAssistantMCPRoutes(
	r gin.IRouter,
	svc ownerCredentialDirs,
	host *assistantruntime.Host,
	guard func(*gin.Context, bool) bool,
) {
	var store *assistantmcp.Store
	if !isNilService(svc) {
		store = assistantmcp.NewStore(svc.DataDir())
	}
	requireStore := func(c *gin.Context) bool {
		if store == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "service_unavailable", "msg": "工作区存储暂不可用"})
			return false
		}
		return true
	}

	fetchHostMCPStatus := func(ctx context.Context, method, path string, body []byte, timeout time.Duration) (map[string]any, int, error) {
		if host == nil {
			return nil, http.StatusServiceUnavailable, nil
		}
		var reader io.Reader
		if body != nil {
			reader = strings.NewReader(string(body))
		}
		req, err := host.NewChildRequest(ctx, method, path, reader)
		if err != nil {
			return nil, http.StatusServiceUnavailable, err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := agentHostClient(host, timeout).Do(req)
		if err != nil {
			return nil, http.StatusServiceUnavailable, err
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			return nil, resp.StatusCode, err
		}
		return decoded, resp.StatusCode, nil
	}

	// Runtime endpoint strictly for the local agent-host process.
	r.GET("/assistant/runtime/mcp-servers", func(c *gin.Context) {
		if !requireStore(c) {
			return
		}
		if !isLoopbackRequest(c.Request) || !isAssistantHostRequest(c, svc) {
			fail(c, http.StatusForbidden, app.Forbidden("仅内置助手宿主可以读取外部 MCP 运行时配置"))
			return
		}
		servers, fingerprint, err := store.ListEnabledRuntime()
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{
			"fingerprint": fingerprint,
			"servers":     servers,
		})
	})

	// UI endpoint: list configured servers (redacted) + best-effort live status from host.
	r.GET("/assistant/mcp-servers", func(c *gin.Context) {
		if !guard(c, false) || !requireStore(c) {
			return
		}
		views, err := store.ListViews()
		if err != nil {
			failService(c, err)
			return
		}
		runtimeAvailable := false
		runtimeByName := map[string]any{}
		if host != nil {
			decoded, statusCode, reqErr := fetchHostMCPStatus(c.Request.Context(), http.MethodGet, "/mcp-servers", nil, 2500*time.Millisecond)
			if reqErr == nil && statusCode/100 == 2 && decoded != nil {
				runtimeAvailable = true
				if items, okList := decoded["servers"].([]any); okList {
					for _, item := range items {
						if m, isMap := item.(map[string]any); isMap {
							if name, _ := m["name"].(string); name != "" {
								runtimeByName[name] = m
							}
						}
					}
				}
			}
		}
		ok(c, gin.H{
			"servers":          views,
			"runtimeAvailable": runtimeAvailable,
			"runtime":          runtimeByName,
		})
	})

	upsertHandler := func(c *gin.Context, pathName string) {
		if !guard(c, true) || !requireStore(c) {
			return
		}
		_, input, valid := readAssistantBodyLimit(c, assistantmcp.UpsertInput{}, 128<<10)
		if !valid {
			return
		}
		if pathName != "" {
			input.Name = pathName
		}
		view, err := store.Upsert(input)
		if err != nil {
			failService(c, err)
			return
		}
		var runtimeResult any
		if host != nil {
			if decoded, statusCode, reqErr := fetchHostMCPStatus(c.Request.Context(), http.MethodPost, "/mcp-servers/reload", []byte("{}"), 15*time.Second); reqErr == nil && statusCode/100 == 2 {
				runtimeResult = decoded
			}
		}
		ok(c, gin.H{
			"server":  view,
			"runtime": runtimeResult,
		})
	}

	r.POST("/assistant/mcp-servers", func(c *gin.Context) {
		upsertHandler(c, "")
	})

	r.PUT("/assistant/mcp-servers/:name", func(c *gin.Context) {
		upsertHandler(c, strings.TrimSpace(c.Param("name")))
	})

	r.PATCH("/assistant/mcp-servers/:name", func(c *gin.Context) {
		upsertHandler(c, strings.TrimSpace(c.Param("name")))
	})

	r.DELETE("/assistant/mcp-servers/:name", func(c *gin.Context) {
		if !guard(c, true) || !requireStore(c) {
			return
		}
		name := strings.TrimSpace(c.Param("name"))
		if err := store.Delete(name); err != nil {
			failService(c, err)
			return
		}
		if host != nil {
			_, _, _ = fetchHostMCPStatus(c.Request.Context(), http.MethodPost, "/mcp-servers/reload", []byte("{}"), 10*time.Second)
		}
		ok(c, gin.H{"deleted": true, "name": name})
	})

	r.POST("/assistant/mcp-servers/reload", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		if host == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable", "msg": "内置创作助手宿主未运行"})
			return
		}
		decoded, statusCode, reqErr := fetchHostMCPStatus(c.Request.Context(), http.MethodPost, "/mcp-servers/reload", []byte("{}"), 25*time.Second)
		if reqErr != nil || statusCode/100 != 2 {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable", "msg": "内置创作助手宿主未运行，配置会在下次打开助手时自动生效"})
			return
		}
		ok(c, decoded)
	})

	r.POST("/assistant/mcp-servers/:name/test", func(c *gin.Context) {
		if !guard(c, true) || !requireStore(c) {
			return
		}
		name := strings.TrimSpace(c.Param("name"))
		srv, err := store.GetRuntime(name)
		if err != nil {
			failService(c, err)
			return
		}
		if host == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable", "msg": "内置创作助手宿主未运行，请先配置助手模型并打开一次画布助手"})
			return
		}
		payload, _ := json.Marshal(map[string]any{"server": srv})
		decoded, statusCode, reqErr := fetchHostMCPStatus(c.Request.Context(), http.MethodPost, "/mcp-servers/"+url.PathEscape(name)+"/test", payload, 25*time.Second)
		if reqErr != nil || statusCode/100 != 2 {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable", "msg": "内置创作助手宿主未运行，请先打开一次画布助手后再测试连接"})
			return
		}
		ok(c, decoded)
	})
}
