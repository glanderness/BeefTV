package operations

import (
	"context"
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
)

// TaskController 是任务取消这类命令能力的窄端口，由组合根实现。
// 操作核只做身份、幂等与回执，不重新实现任务状态机。
type TaskController interface {
	CancelTask(ctx context.Context, userID string, id string) (*model.Task, error)
}

func registerTaskCancelOp(r *Registry) {
	r.Register(Op{ExternalOnly: true, ReplaySafe: true, ID: "task.cancel", Summary: "取消排队中或进行中的任务；生成已完成但产物还在取回的会停止继续取回，已经取回的不能取消。上游已经受理的任务可能已经计费，这里不承诺退款", Scope: ScopeWorkspaceRead,
		Params:  json.RawMessage(`{"type":"object","properties":{"taskId":{"type":"string","description":"要取消的任务 ID"}},"required":["taskId"]}`),
		Handler: opTaskCancel})
}

func opTaskCancel(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		TaskID string `json:"taskId"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	taskID := strings.TrimSpace(args.TaskID)
	if taskID == "" {
		return nil, InvalidArg("invalid_params", "taskId 必填")
	}
	if ctx.TaskControl == nil {
		return nil, Unsupported("task_control_unavailable", "当前工作区不支持取消任务")
	}
	// 先读一次任务，既能确认归属，也能如实说明取消前的状态。
	before, err := ctx.Domain.Task(ctx.UserID, taskID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if before == nil {
		return nil, NotFound("task_not_found", "任务不存在")
	}
	cancelled, err := ctx.TaskControl.CancelTask(ctx.Context, ctx.UserID, taskID)
	if err != nil {
		mapped := mapDomainError(err)
		if opErr, ok := mapped.(*Error); ok && (opErr.Code == CodeInvalidArgument || opErr.Code == CodeInternal) {
			return nil, Conflict("task_not_cancellable", err.Error(), map[string]any{
				"taskId": taskID,
				"status": before.Status,
			})
		}
		return nil, mapped
	}
	if cancelled == nil {
		return nil, newError(CodeInternal, "task_cancel_empty_result", "取消任务没有返回任务状态", nil)
	}
	return map[string]any{
		"taskId":         cancelled.ID,
		"status":         cancelled.Status,
		"previousStatus": before.Status,
		"note":           taskCancelNote(before.Status, cancelled.Status),
	}, nil
}

// taskCancelNote 只写使用者需要知道的后果：取消不一定退费，已完成任务只是停止继续取回。
func taskCancelNote(previous model.TaskStatus, current model.TaskStatus) string {
	switch {
	case previous == model.TaskStatusCancelled:
		return "任务此前已经取消，没有再次提交取消请求。"
	case current == model.TaskStatusCancelled:
		return "已请求取消。上游已经受理的任务可能已经计费，这里不承诺退款。"
	case current == model.TaskStatusSucceeded:
		return "任务已经完成，已停止继续取回产物。上游可能已经计费，这里不承诺退款。"
	default:
		return "已请求取消。上游已经受理的任务可能已经计费，这里不承诺退款。"
	}
}
