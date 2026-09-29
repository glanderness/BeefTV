package handler

import (
	"testing"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

// ComfyUI 是本地优先能力，必须出现在 desktop 路由面上；它不像 RunningHub
// 那样属于 hosted-only 路由，因此不能受 hostedProfile 守卫影响。
func TestRegisterDesktopCanvasAPIExposesComfyUIObjectInfoRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterDesktopCanvasAPI(router.Group("/api"), &app.Service{})

	for _, route := range router.Routes() {
		if route.Method+" "+route.Path == "POST /api/comfyui/object-info" {
			return
		}
	}
	t.Fatal("desktop API 必须暴露 POST /api/comfyui/object-info")
}
