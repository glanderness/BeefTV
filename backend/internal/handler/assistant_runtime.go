package handler

import (
	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/app"
	"net/http"
)

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
	r.GET("/assistant/runtime/turns/:turnId", handle)
	r.POST("/assistant/runtime/turns/:turnId/complete", handle)
}
