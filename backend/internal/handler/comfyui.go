package handler

import (
	"net/http"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

// RegisterComfyUIRoutes 暴露原生 ComfyUI 的只读元信息代理。
//
// 浏览器不能直接访问用户本机的 ComfyUI：既受 CORS 限制，也无法复用宿主的
// SSRF 策略、大小上限与审计。这里只代理「读取节点定义」，工作流提交与结果
// 轮询仍由任务执行链在服务端完成。
func RegisterComfyUIRoutes(r *gin.RouterGroup, svc *app.Service) {
	r.POST("/comfyui/object-info", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.RequireWorkflowPluginForUser(user.ID, "comfyui-workflow-image"); err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 128<<10)
		var req app.ComfyUIObjectInfoRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		result, err := svc.FetchComfyUIObjectInfo(c.Request.Context(), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
}
