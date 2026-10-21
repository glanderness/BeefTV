package handler

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/generation"
)

type mediaUpscaleAPI interface {
	MediaUpscaleCapabilities(context.Context) (map[string]any, error)
	EstimateMediaUpscale(context.Context, string, generation.Input) (generation.UpscaleEstimate, error)
}

func registerMediaUpscaleRoutes(r *gin.RouterGroup, svc *app.Service, api mediaUpscaleAPI) {
	r.GET("/media-upscale/capabilities", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, svc); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
		defer cancel()
		result, err := api.MediaUpscaleCapabilities(ctx)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.POST("/media-upscale/estimate", func(c *gin.Context) {
		if !requireTrustedDesktopWritePrincipal(c, "超分费用只能由当前桌面界面预估") {
			return
		}
		owner, err := workspaceForLocalRequest(c, svc)
		if err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		if !enforceRateLimit(c, "media-upscale-estimate", 20, time.Minute) {
			return
		}
		var input generation.Input
		if err := c.ShouldBindJSON(&input); err != nil {
			failService(c, app.BadAuthRequest("超分参数无效"))
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Minute)
		defer cancel()
		result, err := api.EstimateMediaUpscale(ctx, owner.ID, input)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
}
