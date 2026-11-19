package app

import (
	"encoding/json"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestTaskEffectsOutboxEliminatesIdleRecoveryScansAndResumesOnCanvasChange(t *testing.T) {
	svc, canvasID, revision := newAssistantTurnService(t)
	now := time.Now()
	normalTask := model.Task{
		ID: "outbox-normal", UserID: "local", ProjectID: canvasID, Type: "canvas_text",
		Status: model.TaskStatusSucceeded, Stage: "任务完成", Prompt: "正常绑定",
		InputJSON:  `{"mode":"text","metadata":{"source":"canvas","nodeId":"node-outbox-normal"}}`,
		ResultJSON: `{"mode":"text","text":"正常绑定完成"}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	switchedTask := model.Task{
		ID: "outbox-switched", UserID: "local", ProjectID: canvasID, Type: "canvas_text",
		Status: model.TaskStatusSucceeded, Stage: "任务完成", Prompt: "被切换节点",
		InputJSON:  `{"mode":"text","metadata":{"source":"canvas","nodeId":"node-outbox-switched"}}`,
		ResultJSON: `{"mode":"text","text":"换回后绑定"}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	missingTask := model.Task{
		ID: "outbox-missing-canvas", UserID: "local", ProjectID: "deleted-canvas-id", Type: "canvas_image",
		Status:     model.TaskStatusSucceeded,
		InputJSON:  `{"mode":"image","metadata":{"source":"canvas","nodeId":"ghost-node"}}`,
		ResultJSON: `{"mode":"image","imageUrl":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	for _, task := range []model.Task{normalTask, switchedTask, missingTask} {
		if err := svc.repo.DB().Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	}
	raw, err := json.Marshal(map[string]any{
		"id": canvasID, "title": "outbox 验收", "revision": revision,
		"nodes": []any{
			map[string]any{"id": "node-outbox-normal", "type": "text", "title": "正常", "metadata": map[string]any{"taskId": normalTask.ID}},
			map[string]any{"id": "node-outbox-switched", "type": "text", "title": "冲突", "metadata": map[string]any{"taskId": "other-task"}},
		},
		"connections": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}

	// Pass 1: settles normalTask, records refused for switchedTask, and records missing for missingTask.
	if err := svc.RecoverIncompleteGenerationDeliveries(64); err != nil {
		t.Fatalf("pass 1 failed: %v", err)
	}

	// After pass 1, idle SQL scans for pending delivery & pending canvas bind must return 0 rows!
	pendingDeliveries, err := svc.repo.PendingDeliveryTasks("", 64)
	if err != nil {
		t.Fatalf("PendingDeliveryTasks error: %v", err)
	}
	if len(pendingDeliveries) != 0 {
		t.Fatalf("expected 0 pending delivery tasks after settlement, got %d (%+v)", len(pendingDeliveries), pendingDeliveries)
	}

	pendingBinds, err := svc.repo.PendingCanvasBindTasks("", 64)
	if err != nil {
		t.Fatalf("PendingCanvasBindTasks error: %v", err)
	}
	if len(pendingBinds) != 0 {
		t.Fatalf("expected 0 pending canvas bind tasks after settlement/refusal, got %d (%+v)", len(pendingBinds), pendingBinds)
	}

	// Pass 2 & Pass 3 must perform zero canvas.bind trace executions.
	beforeTraces := canvasBindTraceCount(t, svc)
	if err := svc.RecoverIncompleteGenerationDeliveries(64); err != nil {
		t.Fatalf("pass 2 failed: %v", err)
	}
	if err := svc.RecoverIncompleteGenerationDeliveries(64); err != nil {
		t.Fatalf("pass 3 failed: %v", err)
	}
	if afterTraces := canvasBindTraceCount(t, svc); afterTraces != beforeTraces {
		t.Fatalf("idle recovery passes executed canvas.bind again: before=%d after=%d", beforeTraces, afterTraces)
	}

	// Verify settled effect exists for normalTask.
	if settled, err := svc.repo.IsTaskEffectSettled(normalTask.ID, model.TaskEffectKindTaskBindSettled, "", 0, "", ""); err != nil || !settled {
		t.Fatalf("expected normalTask task_bind_settled effect, settled=%v err=%v", settled, err)
	}

	// Re-point switchedTask's node back to switchedTask (bumping canvas revision).
	// PendingCanvasBindTasks must immediately pick up switchedTask again!
	setCanvasBindTestNodeTaskID(t, svc, canvasID, "node-outbox-switched", switchedTask.ID)
	resumedPending, err := svc.repo.PendingCanvasBindTasks("", 64)
	if err != nil {
		t.Fatalf("PendingCanvasBindTasks after canvas edit error: %v", err)
	}
	if len(resumedPending) != 1 || resumedPending[0].ID != switchedTask.ID {
		t.Fatalf("expected switchedTask to become pending after canvas revision advanced, got %+v", resumedPending)
	}
	if err := svc.RecoverIncompleteGenerationDeliveries(64); err != nil {
		t.Fatalf("resume pass failed: %v", err)
	}
	finalPending, err := svc.repo.PendingCanvasBindTasks("", 64)
	if err != nil {
		t.Fatalf("PendingCanvasBindTasks after resume error: %v", err)
	}
	if len(finalPending) != 0 {
		t.Fatalf("expected 0 pending canvas bind tasks after resume settled, got %d", len(finalPending))
	}
}

func TestTaskEffectsSkipsPausedTimedOutPermanentFailuresAndHonorsBackoff(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	now := time.Now()

	pausedTask := model.Task{
		ID: "outbox-paused", UserID: "local", ProjectID: canvasID, Type: "canvas_image",
		Status: model.TaskStatusSucceeded, Stage: "delivery_paused", Prompt: "已暂停下载",
		ResultJSON: `{"images":[{"url":"https://example.com/paused.png"}]}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	timedOutTask := model.Task{
		ID: "outbox-timed-out", UserID: "local", ProjectID: canvasID, Type: "canvas_image",
		Status: model.TaskStatusSucceeded, Stage: "delivery_timed_out", Prompt: "下载超时",
		ResultJSON: `{"images":[{"url":"https://example.com/timeout.png"}]}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	deletedConvTask := model.Task{
		ID: "outbox-deleted-conv", UserID: "local", ProjectID: canvasID, Type: "canvas_text",
		Status: model.TaskStatusSucceeded, Stage: "任务完成", Prompt: "已删对话消息绑定",
		InputJSON:  `{"mode":"text","metadata":{"conversationId":"missing-conv","messageId":"missing-msg"}}`,
		ResultJSON: `{"mode":"text","text":"对话已删除"}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	backedOffTask := model.Task{
		ID: "outbox-backoff", UserID: "local", ProjectID: canvasID, Type: "canvas_image",
		Status: model.TaskStatusSucceeded, Stage: "正在取回结果", Prompt: "暂时失败退避",
		ResultJSON: `{"images":[{"url":"https://example.com/transient.png"}]}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	for _, task := range []model.Task{pausedTask, timedOutTask, deletedConvTask, backedOffTask} {
		if err := svc.repo.DB().Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	}

	// Simulate transient delivery failure on backedOffTask -> schedules next_attempt_at > now.
	if err := svc.repo.RecordTaskEffectAttemptFailure("local", backedOffTask.ID, model.TaskEffectKindDeliverySettled, canvasID, "temporary network timeout"); err != nil {
		t.Fatal(err)
	}
	// Mark deletedConvTask delivery settled + permanently refused message attach.
	if err := svc.repo.MarkTaskEffectSettled("local", deletedConvTask.ID, model.TaskEffectKindDeliverySettled, "", "", 0, "", ""); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.MarkMessageEffectRefused("local", deletedConvTask.ID, "missing-conv", "missing-msg", 0, "conversation_deleted"); err != nil {
		t.Fatal(err)
	}

	pendingDeliveries, err := svc.repo.PendingDeliveryTasks("", 64)
	if err != nil {
		t.Fatal(err)
	}
	if len(pendingDeliveries) != 0 {
		t.Fatalf("expected paused, timed-out, settled, and backed-off tasks to be excluded from PendingDeliveryTasks, got %+v", pendingDeliveries)
	}

	pendingBinds, err := svc.repo.PendingCanvasBindTasks("", 64)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range pendingBinds {
		if item.ID == deletedConvTask.ID {
			t.Fatalf("permanently refused message attach task %s must not re-scan", deletedConvTask.ID)
		}
	}

	// Moving next_attempt_at into the past makes backedOffTask eligible immediately.
	if err := svc.repo.DB().Model(&model.TaskEffect{}).
		Where("task_id = ? AND kind = ?", backedOffTask.ID, model.TaskEffectKindDeliverySettled).
		Update("next_attempt_at", time.Now().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	dueDeliveries, err := svc.repo.PendingDeliveryTasks("", 64)
	if err != nil {
		t.Fatal(err)
	}
	if len(dueDeliveries) != 1 || dueDeliveries[0].ID != backedOffTask.ID {
		t.Fatalf("expected due backed-off task %s to become eligible, got %+v", backedOffTask.ID, dueDeliveries)
	}

	// Verify NULL stage tasks are NOT accidentally filtered out by stage NOT IN.
	if err := svc.repo.DB().Exec(`INSERT INTO tasks (id, user_id, project_id, type, status, stage, prompt, result_json, created_at, updated_at)
		VALUES ('outbox-null-stage', 'local', ?, 'canvas_image', 'succeeded', NULL, 'null stage', '{"images":[{"url":"https://example.com/a.png"}]}', ?, ?)`,
		canvasID, now, now).Error; err != nil {
		t.Fatal(err)
	}
	withNullStage, err := svc.repo.PendingDeliveryTasks("", 64)
	if err != nil {
		t.Fatal(err)
	}
	foundNullStage := false
	for _, item := range withNullStage {
		if item.ID == "outbox-null-stage" {
			foundNullStage = true
		}
	}
	if !foundNullStage {
		t.Fatalf("expected task with NULL stage to be returned by PendingDeliveryTasks, got %+v", withNullStage)
	}

	// Verify RecoverCanvasTaskBindings preserves task_bind_settled backoff row
	// when a target hits a transient skippable error like resource_missing/output_not_ready.
	transientTask := model.Task{
		ID: "outbox-transient-bind", UserID: "local", ProjectID: canvasID, Type: "canvas_image",
		Status: model.TaskStatusSucceeded, Stage: "生成完成", Prompt: "暂时未就绪",
		InputJSON:  `{"mode":"image","metadata":{"source":"canvas","nodeId":"node-transient"}}`,
		ResultJSON: `{"mode":"image","images":[{"resourceId":"missing-res-1"}]}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := svc.repo.DB().Create(&transientTask).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.MarkTaskEffectSettled("local", transientTask.ID, model.TaskEffectKindDeliverySettled, "", "", 0, "", ""); err != nil {
		t.Fatal(err)
	}
	// Run full RecoverCanvasTaskBindings (output_not_ready because result row is absent).
	_ = svc.recoverCanvasTaskBindings(transientTask)

	var backoffRow model.TaskEffect
	if err := svc.repo.DB().Where("task_id = ? AND kind = ?", transientTask.ID, model.TaskEffectKindTaskBindSettled).Take(&backoffRow).Error; err != nil {
		t.Fatalf("expected transient bind failure to keep task_bind_settled backoff row, err=%v", err)
	}
	if backoffRow.Status != model.TaskEffectStatusPending || backoffRow.Attempts < 1 || !backoffRow.NextAttemptAt.After(time.Now()) {
		t.Fatalf("expected pending backoff row with attempts>=1 and future next_attempt_at, got %+v", backoffRow)
	}
	// Before next_attempt_at, PendingCanvasBindTasks must NOT re-scan transientTask.
	bindsDuringBackoff, err := svc.repo.PendingCanvasBindTasks("", 64)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range bindsDuringBackoff {
		if item.ID == transientTask.ID {
			t.Fatalf("transientTask %s must be suppressed while backed off until %v", transientTask.ID, backoffRow.NextAttemptAt)
		}
	}
}
