package operations_test

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func TestTaskCancelReportsBillingCaveatAndReplays(t *testing.T) {
	h := newHarness(t)
	task := model.Task{ID: "task-cancel-1", UserID: h.userID, Status: model.TaskStatusQueued, Stage: "等待队列调度", Type: "canvas_image"}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}

	caller := operations.ExternalCaller(false)
	result, err := h.execute(t, caller, "task.cancel", "cancel-op-1", map[string]any{"taskId": task.ID})
	if err != nil {
		t.Fatalf("task.cancel: %v", err)
	}
	payload, ok := result.Result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result: %#v", result.Result)
	}
	if payload["status"] != string(model.TaskStatusCancelled) || payload["previousStatus"] != string(model.TaskStatusQueued) {
		t.Fatalf("unexpected cancel result: %#v", payload)
	}
	note, _ := payload["note"].(string)
	if !strings.Contains(note, "可能已经计费") || !strings.Contains(note, "不承诺退款") {
		t.Fatalf("cancel note must state the billing caveat, got %q", note)
	}

	stored, err := h.service.Task(h.userID, task.ID)
	if err != nil || stored.Status != model.TaskStatusCancelled {
		t.Fatalf("task was not cancelled: %+v (err=%v)", stored, err)
	}

	replayed, err := h.execute(t, caller, "task.cancel", "cancel-op-1", map[string]any{"taskId": task.ID})
	if err != nil {
		t.Fatalf("replay task.cancel: %v", err)
	}
	if !replayed.Replayed {
		t.Fatal("same operationId must replay the stored cancel result")
	}
}

func TestTaskCancelAlreadyCancelledAndReadOnlyClient(t *testing.T) {
	h := newHarness(t)
	task := model.Task{ID: "task-cancel-2", UserID: h.userID, Status: model.TaskStatusCancelled, Stage: "任务已取消", Type: "canvas_image"}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}

	result, err := h.execute(t, operations.ExternalCaller(false), "task.cancel", "cancel-op-2", map[string]any{"taskId": task.ID})
	if err != nil {
		t.Fatalf("cancel already-cancelled task: %v", err)
	}
	note, _ := result.Result.(map[string]any)["note"].(string)
	if !strings.Contains(note, "此前已经取消") {
		t.Fatalf("already-cancelled note = %q", note)
	}

	_, err = h.execute(t, operations.ExternalCaller(true), "task.cancel", "cancel-op-readonly", map[string]any{"taskId": task.ID})
	if got := opErr(t, err); got.Code != operations.CodeReadOnly {
		t.Fatalf("read-only client cancel must be rejected, got %+v", got)
	}
}

func TestTaskCancelRejectsOtherUsersTask(t *testing.T) {
	h := newHarness(t)
	task := model.Task{ID: "task-cancel-other", UserID: "other-user", Status: model.TaskStatusQueued, Stage: "等待队列调度", Type: "canvas_image"}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	_, err := h.execute(t, operations.ExternalCaller(false), "task.cancel", "cancel-op-other", map[string]any{"taskId": task.ID})
	if got := opErr(t, err); got.Code != operations.CodeNotFound {
		t.Fatalf("other user's task must not be cancellable, got %+v", got)
	}
}

func TestAgentTaskAndWriteOpsStayOutOfAssistantCatalog(t *testing.T) {
	h := newHarness(t)
	visible := map[string]bool{}
	for _, descriptor := range h.registry.List(h.assistant()) {
		visible[descriptor.ID] = true
	}
	for _, id := range []string{"task.cancel", "canvas.generation.orders", "canvas.external.write.list", "canvas.external.write.undo"} {
		if visible[id] {
			t.Fatalf("内置助手不应看到外部 Agent 操作 %s", id)
		}
	}
	_, err := h.execute(t, h.assistant(), "task.cancel", "assistant-cancel", map[string]any{"taskId": "anything"})
	if got := opErr(t, err); got.Code != operations.CodePermissionDenied || got.Reason != "scope_denied" {
		t.Fatalf("assistant cancel must be denied, got %+v", got)
	}
}
