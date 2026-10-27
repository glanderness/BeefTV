package app

import (
	"encoding/json"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func TestCanvasBindRecoveryStopsTerminalFailuresAndResumesWhenNodeReturns(t *testing.T) {
	t.Run("normal binding", func(t *testing.T) {
		svc, canvasID, revision := newAssistantTurnService(t)
		task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-normal", "node-normal", "bind-normal")

		if err := svc.recoverCanvasTaskBindings(task); err != nil {
			t.Fatal(err)
		}
		stored, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.RecoveryOutcome != nil {
			t.Fatalf("successful bind left recovery marker: %q", *stored.RecoveryOutcome)
		}
		meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-normal")
		if meta["content"] != "正常绑定" {
			t.Fatalf("normal bind content = %#v", meta["content"])
		}
	})

	t.Run("switched task resumes after re-point", func(t *testing.T) {
		svc, canvasID, revision := newAssistantTurnService(t)
		task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-switched", "node-switched", "other-task")

		if err := svc.recoverCanvasTaskBindings(task); err != nil {
			t.Fatal(err)
		}
		stored, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		marker, ok := localtask.DecodeCanvasBindRecovery(stored.RecoveryOutcome)
		if !ok || len(marker.Targets) != 1 || marker.Targets[0].Reason != "node_task_mismatch" || marker.Targets[0].NodeTaskID != "other-task" {
			t.Fatalf("mismatch marker = %#v, raw=%v", marker, stored.RecoveryOutcome)
		}

		// A second recovery pass must not call canvas.task.bind again while the
		// node still points at the same newer task.
		beforeRetryBinds := canvasBindTraceCount(t, svc)
		if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
			t.Fatal(err)
		}
		if got := canvasBindTraceCount(t, svc); got != beforeRetryBinds {
			t.Fatalf("unchanged mismatch retried canvas.bind: before=%d after=%d", beforeRetryBinds, got)
		}
		still, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if still.RecoveryOutcome == nil || *still.RecoveryOutcome != *stored.RecoveryOutcome {
			var after string
			if still.RecoveryOutcome != nil {
				after = *still.RecoveryOutcome
			}
			t.Fatalf("unchanged mismatch marker was rewritten: before=%q after=%q", *stored.RecoveryOutcome, after)
		}

		setCanvasBindTestNodeTaskID(t, svc, canvasID, "node-switched", task.ID)
		beforeResumeBinds := canvasBindTraceCount(t, svc)
		if err := svc.recoverCanvasTaskBindings(*still); err != nil {
			t.Fatal(err)
		}
		if got := canvasBindTraceCount(t, svc); got != beforeResumeBinds+1 {
			t.Fatalf("re-pointed node did not retry canvas.bind exactly once: before=%d after=%d", beforeResumeBinds, got)
		}
		final, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if final.RecoveryOutcome != nil {
			t.Fatalf("re-pointed node kept terminal marker: %q", *final.RecoveryOutcome)
		}
		meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-switched")
		if meta["content"] != "节点换回后绑定" {
			t.Fatalf("re-pointed bind content = %#v", meta["content"])
		}
	})

	t.Run("deleted node resumes after recreation", func(t *testing.T) {
		svc, canvasID, revision := newAssistantTurnService(t)
		task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-deleted", "node-deleted", "bind-deleted")
		removeCanvasBindTestNode(t, svc, canvasID, "node-deleted")

		if err := svc.recoverCanvasTaskBindings(task); err != nil {
			t.Fatal(err)
		}
		stored, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		marker, ok := localtask.DecodeCanvasBindRecovery(stored.RecoveryOutcome)
		if !ok || len(marker.Targets) != 1 || marker.Targets[0].Reason != "node_deleted" || marker.Targets[0].NodePresent {
			t.Fatalf("deleted marker = %#v, raw=%v", marker, stored.RecoveryOutcome)
		}

		before := *stored.RecoveryOutcome
		beforeRetryBinds := canvasBindTraceCount(t, svc)
		if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
			t.Fatal(err)
		}
		if got := canvasBindTraceCount(t, svc); got != beforeRetryBinds {
			t.Fatalf("unchanged deleted node retried canvas.bind: before=%d after=%d", beforeRetryBinds, got)
		}
		still, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if still.RecoveryOutcome == nil || *still.RecoveryOutcome != before {
			t.Fatalf("deleted-node marker changed before recreation: before=%q after=%v", before, still.RecoveryOutcome)
		}

		addCanvasBindTestNode(t, svc, canvasID, "node-deleted", task.ID)
		beforeResumeBinds := canvasBindTraceCount(t, svc)
		if err := svc.recoverCanvasTaskBindings(*still); err != nil {
			t.Fatal(err)
		}
		if got := canvasBindTraceCount(t, svc); got != beforeResumeBinds+1 {
			t.Fatalf("recreated node did not retry canvas.bind exactly once: before=%d after=%d", beforeResumeBinds, got)
		}
		final, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if final.RecoveryOutcome != nil {
			t.Fatalf("recreated node kept terminal marker: %q", *final.RecoveryOutcome)
		}
		meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-deleted")
		if meta["content"] != "节点重建后绑定" {
			t.Fatalf("recreated bind content = %#v", meta["content"])
		}
	})
}

func canvasBindTraceCount(t *testing.T, svc *Service) int {
	t.Helper()
	recorder := svc.SupportTrace()
	if recorder == nil {
		return 0
	}
	snapshot, err := recorder.Snapshot("local", time.Unix(0, 0), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, event := range snapshot.Events {
		if event.Name == "canvas.bind" && event.Phase == "start" {
			count++
		}
	}
	return count
}

func seedCanvasBindRecoveryTask(t *testing.T, svc *Service, canvasID string, revision int64, taskID, nodeID, nodeTaskID string) model.Task {
	t.Helper()
	now := time.Now()
	task := model.Task{
		ID: taskID, UserID: "local", ProjectID: canvasID, Type: "canvas_text",
		Status: model.TaskStatusSucceeded, Stage: "任务完成", Prompt: "绑定测试",
		InputJSON:  `{"mode":"text","metadata":{"source":"canvas","nodeId":"` + nodeID + `"}}`,
		ResultJSON: `{"mode":"text","text":"` + bindTestText(taskID) + `"}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := svc.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(map[string]any{
		"id": canvasID, "title": "绑定恢复测试", "revision": revision,
		"nodes": []any{map[string]any{
			"id": nodeID, "type": "text", "title": "文本", "metadata": map[string]any{"taskId": nodeTaskID},
		}}, "connections": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	return task
}

func bindTestText(taskID string) string {
	switch taskID {
	case "bind-normal":
		return "正常绑定"
	case "bind-switched":
		return "节点换回后绑定"
	default:
		return "节点重建后绑定"
	}
}

func canvasBindTestDocument(t *testing.T, svc *Service, canvasID string) map[string]any {
	t.Helper()
	raw, err := svc.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func canvasBindTestNodeMetadata(t *testing.T, svc *Service, canvasID, nodeID string) map[string]any {
	t.Helper()
	doc := canvasBindTestDocument(t, svc, canvasID)
	for _, rawNode := range doc["nodes"].([]any) {
		node := rawNode.(map[string]any)
		if node["id"] == nodeID {
			return node["metadata"].(map[string]any)
		}
	}
	t.Fatalf("node %q not found", nodeID)
	return nil
}

func setCanvasBindTestNodeTaskID(t *testing.T, svc *Service, canvasID, nodeID, taskID string) {
	t.Helper()
	doc := canvasBindTestDocument(t, svc, canvasID)
	for _, rawNode := range doc["nodes"].([]any) {
		node := rawNode.(map[string]any)
		if node["id"] == nodeID {
			node["metadata"].(map[string]any)["taskId"] = taskID
		}
	}
	saveCanvasBindTestDocument(t, svc, doc)
}

func removeCanvasBindTestNode(t *testing.T, svc *Service, canvasID, nodeID string) {
	t.Helper()
	doc := canvasBindTestDocument(t, svc, canvasID)
	nodes := doc["nodes"].([]any)[:0]
	for _, rawNode := range doc["nodes"].([]any) {
		if rawNode.(map[string]any)["id"] != nodeID {
			nodes = append(nodes, rawNode)
		}
	}
	doc["nodes"] = nodes
	saveCanvasBindTestDocument(t, svc, doc)
}

func addCanvasBindTestNode(t *testing.T, svc *Service, canvasID, nodeID, taskID string) {
	t.Helper()
	doc := canvasBindTestDocument(t, svc, canvasID)
	doc["nodes"] = append(doc["nodes"].([]any), map[string]any{
		"id": nodeID, "type": "text", "title": "重建文本", "metadata": map[string]any{"taskId": taskID},
	})
	saveCanvasBindTestDocument(t, svc, doc)
}

func saveCanvasBindTestDocument(t *testing.T, svc *Service, doc map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("local", encoded); err != nil {
		t.Fatal(err)
	}
}
