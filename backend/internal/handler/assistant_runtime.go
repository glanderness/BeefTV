package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantruntime"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

type assistantRuntimeRouteService interface {
	assistantRuntimeSkillContextService
	assistantTurnFinalizer
	RegisterAssistantNativeSource(ctx context.Context, userID, currentTurnID, originTurnID, sessionID string, source operations.MediaSource) error
	RevalidateAssistantNativeSource(ctx context.Context, userID, currentTurnID, originTurnID, sessionID string, source operations.MediaSource) (any, error)
	BeginAssistantTurn(userID, canvasID, turnID string, input app.AssistantTurnInput) (int64, error)
	Task(userID, id string) (*model.Task, error)
}

// Runtime lifecycle is a host capability, never a model-discoverable operation.
func registerAssistantRuntimeRoutes(r gin.IRouter, svc assistantRuntimeRouteService, host *assistantruntime.Host) {
	registerAssistantRuntimeSkillContextRoutes(r, svc)
	if host != nil && !isNilService(svc) {
		host.ConfigureTaskWaitEvaluator(func(_ context.Context, userID, taskID string) (assistantruntime.TaskWaitEvaluation, error) {
			task, err := svc.Task(userID, taskID)
			if err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return assistantruntime.TaskWaitEvaluation{NotFound: true}, nil
				}
				var appErr *app.AppError
				if errors.As(err, &appErr) && appErr.Status == http.StatusNotFound {
					return assistantruntime.TaskWaitEvaluation{NotFound: true}, nil
				}
				return assistantruntime.TaskWaitEvaluation{}, err
			}
			if task == nil {
				return assistantruntime.TaskWaitEvaluation{NotFound: true}, nil
			}
			eval := operations.EvaluateTaskWaitSignal(*task)
			return assistantruntime.TaskWaitEvaluation{
				Settled: eval.Settled,
				Payload: eval.Payload,
			}, nil
		})
	}
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
		state, err := svc.AssistantTurns().RuntimeState(user.ID, c.Param("turnId"))
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
		if err := svc.AssistantTurns().BindDurableSession(user.ID, c.Param("turnId"), body.SessionID, body.Historical); err != nil {
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
	r.POST("/assistant/runtime/turns", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) || !isAssistantHostRequest(c, svc) {
			fail(c, http.StatusForbidden, app.Forbidden("仅内置助手宿主可以开启任务"))
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var body struct {
			TurnID         string `json:"turnId"`
			CanvasID       string `json:"canvasId"`
			PermissionMode string `json:"permissionMode"`
			SessionID      string `json:"sessionId"`
		}
		decoder := json.NewDecoder(io.LimitReader(c.Request.Body, 8192))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&body) != nil || body.TurnID == "" || body.CanvasID == "" {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("任务启动参数无效"))
			return
		}
		mode := body.PermissionMode
		if mode == "" {
			mode = "canvas"
		}
		if _, err := svc.BeginAssistantTurn(user.ID, body.CanvasID, body.TurnID, app.AssistantTurnInput{PermissionMode: mode}); err != nil {
			failService(c, err)
			return
		}
		if body.SessionID != "" {
			if err := svc.AssistantTurns().BindDurableSession(user.ID, body.TurnID, body.SessionID, false); err != nil {
				failService(c, err)
				return
			}
		}
		state, err := svc.AssistantTurns().RuntimeState(user.ID, body.TurnID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, state)
	})
	r.POST("/assistant/runtime/task-waits", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) || !isAssistantHostRequest(c, svc) {
			fail(c, http.StatusForbidden, app.Forbidden("仅内置助手宿主可以登记任务等待"))
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if host == nil || host.TaskWaits() == nil {
			fail(c, http.StatusServiceUnavailable, app.BadAuthRequest("内置助手宿主未就绪"))
			return
		}
		var body struct {
			CanvasID      string   `json:"canvasId"`
			SessionID     string   `json:"sessionId"`
			DurableTaskID int64    `json:"durableTaskId"`
			Signal        string   `json:"signal"`
			TaskIDs       []string `json:"taskIds"`
		}
		decoder := json.NewDecoder(io.LimitReader(c.Request.Body, 16384))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&body) != nil ||
			strings.TrimSpace(body.CanvasID) == "" ||
			strings.TrimSpace(body.SessionID) == "" ||
			body.DurableTaskID <= 0 ||
			len(body.TaskIDs) == 0 {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("任务等待参数无效"))
			return
		}
		if !host.HasSignalEndpoint() {
			ok(c, map[string]any{
				"registered":    false,
				"reason":        "signal_endpoint_unavailable",
				"durableTaskId": body.DurableTaskID,
				"taskIds":       body.TaskIDs,
			})
			return
		}
		if err := host.TaskWaits().Register(assistantruntime.TaskWaitSubscription{
			UserID:        user.ID,
			CanvasID:      strings.TrimSpace(body.CanvasID),
			SessionID:     strings.TrimSpace(body.SessionID),
			DurableTaskID: body.DurableTaskID,
			Signal:        strings.TrimSpace(body.Signal),
			TaskIDs:       body.TaskIDs,
		}); err != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest(err.Error()))
			return
		}
		ok(c, map[string]any{
			"registered":    true,
			"durableTaskId": body.DurableTaskID,
			"taskIds":       body.TaskIDs,
		})
	})
	r.POST("/assistant/runtime/task-waits/cancel", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) || !isAssistantHostRequest(c, svc) {
			fail(c, http.StatusForbidden, app.Forbidden("仅内置助手宿主可以取消任务等待"))
			return
		}
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		var body struct {
			CanvasID      string   `json:"canvasId"`
			SessionID     string   `json:"sessionId"`
			DurableTaskID int64    `json:"durableTaskId"`
			TaskIDs       []string `json:"taskIds"`
		}
		decoder := json.NewDecoder(io.LimitReader(c.Request.Body, 16384))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&body) != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("取消任务等待参数无效"))
			return
		}
		if host != nil && host.TaskWaits() != nil {
			host.TaskWaits().Cancel(strings.TrimSpace(body.CanvasID), strings.TrimSpace(body.SessionID), body.DurableTaskID)
		}
		ok(c, map[string]any{"cancelled": true})
	})
	r.GET("/assistant/runtime/turns/:turnId", handle)
	r.POST("/assistant/runtime/turns/:turnId/complete", handle)
}
