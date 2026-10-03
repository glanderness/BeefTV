package handler

import (
	"errors"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/chatgptauth"

	"github.com/gin-gonic/gin"
)

// RegisterChatGPTConnectionRoutes 暴露 ChatGPT 订阅的设备码登录入口。
// 所有路由都按当前工作区用户隔离，响应永远不包含令牌本身。
func RegisterChatGPTConnectionRoutes(r *gin.RouterGroup, svc *app.Service) {
	r.GET("/chatgpt/connection", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		service, err := requestChatGPTAuth(svc)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, service.Status(user.ID))
	})
	r.POST("/chatgpt/connection/start", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if !enforceRateLimit(c, "chatgpt-start:"+user.ID, 10, time.Minute) {
			return
		}
		service, err := requestChatGPTAuth(svc)
		if err != nil {
			failService(c, err)
			return
		}
		summary, err := service.Start(c.Request.Context(), user.ID)
		if err != nil {
			failService(c, app.BadAuthRequest(err.Error()))
			return
		}
		ok(c, summary)
	})
	r.POST("/chatgpt/connection/cancel", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		service, err := requestChatGPTAuth(svc)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, service.Cancel(user.ID))
	})
	r.POST("/chatgpt/connection/disconnect", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		service, err := requestChatGPTAuth(svc)
		if err != nil {
			failService(c, err)
			return
		}
		summary, err := service.Disconnect(c.Request.Context(), user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, summary)
	})
}

func requestChatGPTAuth(svc *app.Service) (*chatgptauth.Service, error) {
	if svc == nil {
		return nil, errors.New("ChatGPT 订阅服务尚未初始化")
	}
	service := svc.ChatGPTAuth()
	if service == nil {
		return nil, errors.New("ChatGPT 订阅服务尚未初始化")
	}
	return service, nil
}
