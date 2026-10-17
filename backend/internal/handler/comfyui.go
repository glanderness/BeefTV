package handler

import (
	"context"
	"net/http"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

type comfyUIInspector interface {
	InspectComfyUI(context.Context, app.ComfyUIInspectRequest) (map[string]any, error)
}

func RegisterComfyUIRoutes(r *gin.RouterGroup, svc *app.Service, inspector comfyUIInspector) {
	r.POST("/comfyui/workflow-info", func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8<<20)
		var req app.ComfyUIInspectRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		result, err := inspector.InspectComfyUI(c.Request.Context(), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
}
