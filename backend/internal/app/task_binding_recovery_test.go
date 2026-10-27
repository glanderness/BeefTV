package app

import (
	"encoding/json"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
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
		if !ok || len(marker.Targets) != 1 || marker.Targets[0].Reason != "node_task_mismatch" || marker.Targets[0].Revision != canvasBindTestRevision(t, svc, canvasID) {
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
		if !ok || len(marker.Targets) != 1 || marker.Targets[0].Reason != "node_deleted" || marker.Targets[0].Revision != canvasBindTestRevision(t, svc, canvasID) {
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

func TestCanvasBindRecoveryUsesFailureSnapshot(t *testing.T) {
	svc, canvasID, revision := newAssistantTurnService(t)
	task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-race", "node-race", "other-task")
	failedAt := canvasBindTestRevision(t, svc, canvasID)
	// The canvas moves on after the refusal. The marker must keep the revision
	// the failed bind read, not the current one, or that write would be missed.
	setCanvasBindTestNodeTaskID(t, svc, canvasID, "node-race", task.ID)

	err := &operations.Error{Reason: "node_task_mismatch", Details: map[string]any{
		"canvasBinding": map[string]any{"nodePresent": true, "nodeTaskId": "other-task", "revision": failedAt},
	}}
	marker, ok := canvasBindRecoveryTarget(canvasBindTarget{nodeID: "node-race", outputIndex: 0}, err)
	if !ok || marker.Revision != failedAt {
		t.Fatalf("marker did not preserve failed transaction revision: ok=%v marker=%+v want=%d", ok, marker, failedAt)
	}
	unchanged, stateErr := svc.canvasBindTargetUnchanged(task, marker)
	if stateErr != nil || unchanged {
		t.Fatalf("write after refusal was not detected: unchanged=%v err=%v", unchanged, stateErr)
	}

	missing := &operations.Error{Reason: "node_task_mismatch", Details: map[string]any{"canvasBinding": map[string]any{"nodePresent": true}}}
	if _, ok := canvasBindRecoveryTarget(canvasBindTarget{nodeID: "node-race"}, missing); ok {
		t.Fatal("refusal without a revision must not be recorded")
	}
}

func TestCanvasBindRecoveryRetriesPendingVideoAfterClientOperationRestored(t *testing.T) {
	svc, canvasID, revision := newAssistantTurnService(t)
	now := time.Now()
	operationID := "operation-video-pending"
	resource := model.Resource{ID: "res-pending-video", UserID: "local", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 128, CreatedAt: now, UpdatedAt: now}
	asset := model.Asset{ID: "asset-pending-video", UserID: "local", PayloadJSON: `{"data":{"storageKey":"resource:res-pending-video"}}`, CreatedAt: now, UpdatedAt: now}
	task := model.Task{
		ID: "bind-video-pending", UserID: "local", ProjectID: canvasID, Type: "canvas_video", Status: model.TaskStatusSucceeded,
		ClientOperationID: &operationID, InputJSON: `{"metadata":{"source":"canvas","nodeId":"node-video-pending"}}`,
		ResultJSON: `{"mode":"video","video":{"resourceId":"res-pending-video","storageKey":"resource:res-pending-video"}}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	output := localtask.CanonicalOutput{OutputIndex: 0, MediaType: "video", MaterializedAssetID: asset.ID, ResourceID: resource.ID, ProviderArtifactRef: "resource:" + resource.ID}
	payload, err := localtask.EncodeOutputPayload(output)
	if err != nil {
		t.Fatal(err)
	}
	result := model.Result{ID: "result-pending-video", UserID: "local", TaskID: task.ID, Kind: "generation_output", Payload: payload, CreatedAt: now}
	for _, item := range []any{&resource, &asset, &task, &result} {
		if err := svc.Database().Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	canvasDoc, err := json.Marshal(map[string]any{
		"id": canvasID, "title": "视频待绑定", "revision": revision,
		"nodes": []any{map[string]any{
			"id": "node-video-pending", "type": "video",
			"metadata": map[string]any{"taskClientOperationId": "operation-other"},
		}}, "connections": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("local", canvasDoc); err != nil {
		t.Fatal(err)
	}
	if err := svc.recoverCanvasTaskBindings(task); err != nil {
		t.Fatal(err)
	}
	stored, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if marker, ok := localtask.DecodeCanvasBindRecovery(stored.RecoveryOutcome); !ok || len(marker.Targets) != 1 {
		t.Fatalf("pending video with another operation id did not record a marker: %v", stored.RecoveryOutcome)
	}
	beforeRetryBinds := canvasBindTraceCount(t, svc)
	if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
		t.Fatal(err)
	}
	if got := canvasBindTraceCount(t, svc); got != beforeRetryBinds {
		t.Fatalf("unchanged canvas retried canvas.bind: before=%d after=%d", beforeRetryBinds, got)
	}

	// Only the client operation id comes back; the task id stays empty.
	setCanvasBindTestNodeMetadata(t, svc, canvasID, "node-video-pending", map[string]any{"taskClientOperationId": operationID})
	if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
		t.Fatal(err)
	}
	final, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.RecoveryOutcome != nil {
		t.Fatalf("restored pending video kept recovery marker: %q", *final.RecoveryOutcome)
	}
	if meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-video-pending"); meta["taskId"] != task.ID {
		t.Fatalf("restored pending video did not bind: %#v", meta)
	}
}

func TestCanvasBindRecoveryRetriesLegacyMarkers(t *testing.T) {
	// #25 wrote versions 1-3 without a revision. Each must lead to a retry,
	// never a permanent skip.
	for _, legacy := range []string{
		`canvas_bind:{"version":1,"targets":[{"nodeId":"node-legacy","outputIndex":0,"reason":"node_task_mismatch","nodeTaskId":"other-task"}]}`,
		`canvas_bind:{"version":2,"targets":[{"nodeId":"node-legacy","outputIndex":0,"reason":"node_task_mismatch","nodePresent":true,"nodeTaskId":"other-task"}]}`,
		`canvas_bind:{"version":3,"targets":[{"nodeId":"node-legacy","outputIndex":0,"reason":"node_deleted","nodePresent":false,"nodeHasBindingOccupancy":false}]}`,
	} {
		svc, canvasID, revision := newAssistantTurnService(t)
		task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-legacy", "node-legacy", "bind-legacy")
		if err := svc.Database().Model(&model.Task{}).Where("id = ?", task.ID).Update("recovery_outcome", legacy).Error; err != nil {
			t.Fatal(err)
		}
		stored, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
			t.Fatal(err)
		}
		if meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-legacy"); meta["content"] != "节点重建后绑定" {
			t.Fatalf("legacy marker %s blocked the bind: %#v", legacy, meta)
		}
	}

	// A current-format node marker without a revision must not skip either.
	marker := localtask.CanvasBindRecoveryTarget{NodeID: "node-legacy", Reason: "node_task_mismatch"}
	svc, canvasID, _ := newAssistantTurnService(t)
	if unchanged, err := svc.canvasBindTargetUnchanged(model.Task{UserID: "local", ProjectID: canvasID}, marker); err != nil || unchanged {
		t.Fatalf("revision-less node marker skipped: unchanged=%v err=%v", unchanged, err)
	}
}

func TestCanvasBindRecoveryRetriesOnceAfterUnrelatedEdit(t *testing.T) {
	svc, canvasID, revision := newAssistantTurnService(t)
	task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-unrelated", "node-unrelated", "other-task")
	if err := svc.recoverCanvasTaskBindings(task); err != nil {
		t.Fatal(err)
	}
	stored, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	// An edit that does not touch the node still moves the revision: one retry,
	// then the scanner is quiet again until the next edit.
	addCanvasBindTestNode(t, svc, canvasID, "node-elsewhere", "")
	before := canvasBindTraceCount(t, svc)
	for pass := 0; pass < 3; pass++ {
		current, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.recoverCanvasTaskBindings(*current); err != nil {
			t.Fatal(err)
		}
	}
	if got := canvasBindTraceCount(t, svc); got != before+1 {
		t.Fatalf("unrelated edit retried %d times, want 1", got-before)
	}
	final, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	marker, ok := localtask.DecodeCanvasBindRecovery(final.RecoveryOutcome)
	if !ok || len(marker.Targets) != 1 || marker.Targets[0].Revision != canvasBindTestRevision(t, svc, canvasID) {
		t.Fatalf("retry did not refresh marker revision: %#v (stored=%v)", marker, stored.RecoveryOutcome)
	}
}

func TestCanvasBindRecoveryBindsAfterVideoContentCleared(t *testing.T) {
	svc, canvasID, revision := newAssistantTurnService(t)
	now := time.Now()
	operationID := "operation-video"
	resource := model.Resource{ID: "res-recovery-video", UserID: "local", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 128, CreatedAt: now, UpdatedAt: now}
	asset := model.Asset{ID: "asset-recovery-video", UserID: "local", PayloadJSON: `{"data":{"storageKey":"resource:res-recovery-video"}}`, CreatedAt: now, UpdatedAt: now}
	task := model.Task{
		ID: "bind-video-content", UserID: "local", ProjectID: canvasID, Type: "canvas_video", Status: model.TaskStatusSucceeded,
		ClientOperationID: &operationID, InputJSON: `{"metadata":{"source":"canvas","nodeId":"node-video-content"}}`,
		ResultJSON: `{"mode":"video","video":{"resourceId":"res-recovery-video","storageKey":"resource:res-recovery-video"}}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	output := localtask.CanonicalOutput{OutputIndex: 0, MediaType: "video", MaterializedAssetID: asset.ID, ResourceID: resource.ID, ProviderArtifactRef: "resource:" + resource.ID}
	payload, err := localtask.EncodeOutputPayload(output)
	if err != nil {
		t.Fatal(err)
	}
	result := model.Result{ID: "result-recovery-video", UserID: "local", TaskID: task.ID, Kind: "generation_output", Payload: payload, CreatedAt: now}
	for _, item := range []any{&resource, &asset, &task, &result} {
		if err := svc.Database().Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	canvasDoc, err := json.Marshal(map[string]any{
		"id": canvasID, "title": "视频恢复", "revision": revision,
		"nodes": []any{map[string]any{
			"id": "node-video-content", "type": "video",
			"metadata": map[string]any{"taskClientOperationId": operationID, "content": "existing-result"},
		}}, "connections": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("local", canvasDoc); err != nil {
		t.Fatal(err)
	}
	if err := svc.recoverCanvasTaskBindings(task); err != nil {
		t.Fatal(err)
	}
	stored, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	marker, ok := localtask.DecodeCanvasBindRecovery(stored.RecoveryOutcome)
	if !ok || len(marker.Targets) != 1 || marker.Targets[0].Revision <= 0 {
		t.Fatalf("occupied video marker = %#v, raw=%v", marker, stored.RecoveryOutcome)
	}

	setCanvasBindTestNodeMetadata(t, svc, canvasID, "node-video-content", map[string]any{
		"taskClientOperationId": operationID, "content": "",
	})
	if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
		t.Fatal(err)
	}
	final, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.RecoveryOutcome != nil {
		t.Fatalf("cleared video occupancy kept recovery marker: %q", *final.RecoveryOutcome)
	}
	meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-video-content")
	if meta["taskId"] != task.ID || meta["content"] != "/api/resources/"+resource.ID+"/file" {
		t.Fatalf("cleared video occupancy did not bind: %#v", meta)
	}
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

func canvasBindTestRevision(t *testing.T, svc *Service, canvasID string) int64 {
	t.Helper()
	project, err := svc.repo.CanvasProjectMetadata("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	return project.Revision
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

func setCanvasBindTestNodeMetadata(t *testing.T, svc *Service, canvasID, nodeID string, metadata map[string]any) {
	t.Helper()
	doc := canvasBindTestDocument(t, svc, canvasID)
	for _, rawNode := range doc["nodes"].([]any) {
		node := rawNode.(map[string]any)
		if node["id"] == nodeID {
			node["metadata"] = metadata
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
