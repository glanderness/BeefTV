package handler

import (
	"net/http"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

// RegisterCanvasAPI is kept as the standalone-development entrypoint. BeefTV
// has one local-only HTTP surface, so development and Wails use the same route
// graph instead of selecting between desktop and SaaS profiles at runtime.
func RegisterCanvasAPI(api *gin.RouterGroup, svc *app.Service) {
	registerDesktopCanvasAPI(api, svc, defaultRuntimeDependencies(svc))
}

// RegisterDesktopCanvasAPI keeps the desktop profile local-first. The server
// profile still exposes hosted routes for backward compatibility.
func RegisterDesktopCanvasAPI(api *gin.RouterGroup, svc *app.Service) {
	RegisterDesktopCanvasAPIWithDependencies(api, svc, defaultRuntimeDependencies(svc))
}

func defaultRuntimeDependencies(svc *app.Service) RuntimeDependencies {
	adapter := newServiceRuntimeAdapter(svc)
	return RuntimeDependencies{RequestCoordinator: adapter, ProviderConfig: adapter, Assets: adapter, Projects: adapter, Tasks: adapter, Generation: adapter}
}

func RegisterDesktopCanvasAPIWithDependencies(api *gin.RouterGroup, svc *app.Service, dependencies RuntimeDependencies) {
	registerDesktopCanvasAPI(api, svc, dependencies)
}

// registerDesktopCanvasAPI is deliberately a separate call graph. Keeping the
// local composition root free of runtime profile branches lets the Go linker
// discard hosted handlers and their SaaS-only service methods from BeefTV.
func registerDesktopCanvasAPI(api *gin.RouterGroup, svc *app.Service, dependencies RuntimeDependencies) {
	api.Use(RuntimeDependenciesMiddleware(dependencies))
	RegisterOpenAPIRoutes(api)
	RegisterWorkspaceRoutes(api, svc)
	RegisterBeefAPIConnectionRoutes(api, svc)
	RegisterDesktopAppearanceRoutes(api, svc)
	RegisterDesktopFeatureAvailabilityRoutes(api, svc)
	// 旧内置 Agent 已从产品运行面退场：这里不再注册 /agent/*，运行、审批和记忆入口
	// 都不能由浏览器或直接 API 触发。历史执行、偏好和记忆数据保留在本地数据库，
	// 不做破坏性迁移；替换内核落地时再设计新的入口契约。
	RegisterCreationRoutes(api, svc)
	RegisterChannelModelRoutes(api, svc)
	RegisterCustomRelayRoutes(api, svc)
	RegisterTaskRoutes(api, svc, false)
	RegisterRunningHubRoutes(api, svc, false)
	RegisterDesktopSkillRoutes(api, svc)
	RegisterDesktopUserDataRoutes(api, svc)
	RegisterChunkedUploadRoutes(api, svc, false)
	RegisterDiagnosticsRoutes(api, svc)
	RegisterPluginRoutes(api, svc, false)
	projectAPI := api.Group("")
	projectAPI.Use(RequireFeature(svc, app.FeatureShortDrama))
	RegisterProjectRoutes(projectAPI, svc)
}

func RegisterOpenAPIRoutes(api *gin.RouterGroup) {
	api.GET("/openapi.yaml", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/yaml; charset=utf-8", openAPISpec)
	})
}
