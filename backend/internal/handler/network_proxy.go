package handler

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/assistantruntime"
	"infinite-canvas/backend/internal/desktopnet"
	"infinite-canvas/backend/internal/kernel"
)

const networkProxySaveProbeTimeout = 500 * time.Millisecond

type networkProxyService interface {
	beefTVConnections
	ownerCredentialDirs
}

func pendingAssistantProxyRestart(host *assistantruntime.Host) bool {
	if host == nil {
		return false
	}
	state := host.State()
	if state.TestOwned || (!state.Running && !state.Starting) {
		return false
	}
	provider, reason := host.ResolveProvider()
	return reason == "" && host.NeedsProxyRestart(provider)
}

// RegisterNetworkProxyRoutes exposes the local workspace network proxy mode
// ("system" vs "direct"). Proxy addresses and credentials are never returned.
func RegisterNetworkProxyRoutes(r *gin.RouterGroup, svc networkProxyService, host *assistantruntime.Host) {
	resolveDataDir := func(c *gin.Context) string {
		if scope, err := CurrentWorkspace(c); err == nil && strings.TrimSpace(scope.DataDir) != "" {
			return strings.TrimSpace(scope.DataDir)
		}
		if svc != nil {
			return strings.TrimSpace(svc.DataDir())
		}
		return ""
	}

	buildResponse := func(restarted, restartPending bool) gin.H {
		status := desktopnet.ConfigurationStatus()
		return gin.H{
			"mode":                    string(status.Preference),
			"effectiveMode":           status.Mode,
			"autoConfigOnly":          status.AutoConfigOnly,
			"assistantRestarted":      restarted,
			"assistantRestartPending": restartPending,
		}
	}

	r.GET("/workspace/network-proxy", func(c *gin.Context) {
		if _, external := externalBusiness(c); external || strings.TrimSpace(c.GetHeader("X-Beeftv-Client")) != "" {
			fail(c, http.StatusForbidden, kernel.BadAuthRequest("外部客户端不允许访问网络代理设置"))
			return
		}
		if !isLoopbackRequest(c.Request) {
			fail(c, http.StatusForbidden, kernel.BadAuthRequest("网络代理设置仅允许本机工作区访问"))
			return
		}
		if _, err := workspaceForLocalRequest(c, svc); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		c.Header("Cache-Control", "private, no-store")
		ok(c, buildResponse(false, pendingAssistantProxyRestart(host)))
	})

	r.PUT("/workspace/network-proxy", func(c *gin.Context) {
		if _, external := externalBusiness(c); external || strings.TrimSpace(c.GetHeader("X-Beeftv-Client")) != "" {
			fail(c, http.StatusForbidden, kernel.BadAuthRequest("外部客户端不允许修改网络代理设置"))
			return
		}
		if !isLoopbackRequest(c.Request) {
			fail(c, http.StatusForbidden, kernel.BadAuthRequest("网络代理设置仅允许本机工作区修改"))
			return
		}
		if _, err := workspaceForLocalRequest(c, svc); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4<<10)
		var req struct {
			Mode string `json:"mode"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, kernel.BadAuthRequest("网络代理设置格式无效"))
			return
		}
		mode, valid := desktopnet.NormalizeMode(req.Mode)
		if !valid {
			fail(c, http.StatusBadRequest, kernel.BadAuthRequest("网络代理模式只支持跟随系统（system）或直连（direct）"))
			return
		}
		if err := desktopnet.SavePreference(resolveDataDir(c), mode); err != nil {
			failService(c, err)
			return
		}
		restarted := false
		restartPending := false
		if host != nil {
			state := host.State()
			if !state.TestOwned {
				if state.Starting {
					restartPending = true
				} else if state.Running {
					if provider, reason := host.ResolveProvider(); reason == "" && host.NeedsRestart(provider) {
						probeCtx, cancel := context.WithTimeout(c.Request.Context(), networkProxySaveProbeTimeout)
						health := host.Probe(probeCtx)
						cancel()
						if health.OK && !health.Busy {
							if err := host.RestartAsync(provider, assistantHostOpsURL(c), assistantLaunchToken(c)); err == nil {
								restarted = true
							} else {
								restartPending = true
							}
						} else {
							restartPending = true
						}
					}
				}
			}
		}
		c.Header("Cache-Control", "private, no-store")
		ok(c, buildResponse(restarted, restartPending))
	})
}
