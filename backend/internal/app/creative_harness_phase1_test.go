package app

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func TestAssistantFileAttachmentScopePersistsAcrossDurableSessionAndReadsPaginated(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	sqlDB, _ := svc.Database().DB()
	sqlDB.SetMaxOpenConns(1)

	content := []byte("第一行：场次一\n第二行：雨夜街道\n第三行：人物登场\n")
	res, err := svc.UploadLocalResourceFile("local", "script.md", int64(len(content)), "file", 0, 0, 0, bytes.NewReader(content), "file-attach-1")
	if err != nil {
		t.Fatalf("UploadLocalResourceFile: %v", err)
	}
	otherBytes := []byte("secret other file")
	otherRes, err := svc.UploadLocalResourceFile("local", "other.txt", int64(len(otherBytes)), "file", 0, 0, 0, bytes.NewReader(otherBytes), "file-attach-2")
	if err != nil {
		t.Fatalf("UploadLocalResourceFile other: %v", err)
	}

	if err := svc.ValidateAssistantAttachments("local", canvasID, []AssistantAttachment{{
		ResourceID: res.ID,
		Kind:       "file",
		Name:       "script.md",
		MimeType:   res.MimeType,
		Bytes:      res.Size,
		Purpose:    "reference",
	}}); err != nil {
		t.Fatalf("ValidateAssistantAttachments(file): %v", err)
	}
	zero := 0.0
	if err := svc.ValidateAssistantAttachments("local", canvasID, []AssistantAttachment{{
		ResourceID: res.ID,
		Kind:       "file",
		Name:       "script.md",
		MimeType:   res.MimeType,
		Bytes:      res.Size,
		Purpose:    "analysis",
		Start:      &zero,
	}}); err == nil {
		t.Fatal("expected file attachment with time range to be rejected")
	}

	const sessionID = "durable:11111111-2222-3333-4444-555555555555"
	turn1 := "aaaa1111aaaa1111"
	if _, err := svc.BeginAssistantTurn("local", canvasID, turn1, AssistantTurnInput{
		PermissionMode: assistantturns.PermissionCanvas,
		ResourceIDs:    []string{res.ID},
	}); err != nil {
		t.Fatalf("BeginAssistantTurn turn1: %v", err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", turn1, sessionID, false); err != nil {
		t.Fatalf("BindDurableSession turn1: %v", err)
	}
	if err := svc.AssistantTurns().Finalize(turn1); err != nil {
		t.Fatalf("Finalize turn1: %v", err)
	}

	turn2 := "aaaa1111aaaa2222"
	if _, err := svc.BeginAssistantTurn("local", canvasID, turn2, AssistantTurnInput{
		PermissionMode: assistantturns.PermissionCanvas,
	}); err != nil {
		t.Fatalf("BeginAssistantTurn turn2: %v", err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", turn2, sessionID, false); err != nil {
		t.Fatalf("BindDurableSession turn2: %v", err)
	}
	scope2, ok, err := svc.AssistantTurns().ScopeForHost("local", turn2)
	if err != nil || !ok {
		t.Fatalf("ScopeForHost turn2: ok=%v err=%v", ok, err)
	}
	resSet := map[string]bool{}
	for _, id := range scope2.ResourceIDs {
		resSet[id] = true
	}
	if !resSet[res.ID] {
		t.Fatalf("expected turn2 to inherit session file resource %s, got %+v", res.ID, scope2.ResourceIDs)
	}

	reg := agentops.NewRegistry(svc, agentops.NewStore(svc.Database()))
	agentops.RegisterDefaultOps(reg)
	caller := agentops.AssistantCaller(&agentops.AssistantScope{
		PermissionMode: assistantturns.PermissionCanvas,
		CanvasID:       canvasID,
		ResourceIDs:    resSet,
	}, false)

	readRes, err := reg.Execute(agentops.Request{
		Context: context.Background(),
		Op:      "file.read",
		UserID:  "local",
		Caller:  caller,
		TurnID:  turn2,
		Params:  json.RawMessage(`{"resourceId":"` + res.ID + `","offset":2,"limit":1}`),
	})
	if err != nil {
		t.Fatalf("file.read attached file: %v", err)
	}
	resMap := readRes.Result.(map[string]any)
	if resMap["content"] != "第二行：雨夜街道" {
		t.Fatalf("unexpected file.read content: %+v", resMap)
	}

	if _, err := reg.Execute(agentops.Request{
		Context: context.Background(),
		Op:      "file.read",
		UserID:  "local",
		Caller:  caller,
		TurnID:  turn2,
		Params:  json.RawMessage(`{"resourceId":"` + otherRes.ID + `"}`),
	}); err == nil {
		t.Fatal("expected unattached resource to be denied in canvas mode")
	}
}

func TestAssistantFullAccessCanvasCreateAndTaskCancelFinalizeCleanly(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	sqlDB, _ := svc.Database().DB()
	sqlDB.SetMaxOpenConns(1)

	task := model.Task{ID: "task-cancel-turn", UserID: "local", ProjectID: canvasID, Status: model.TaskStatusQueued, Stage: "等待队列调度", Type: "canvas_image"}
	if err := svc.Database().Create(&task).Error; err != nil {
		t.Fatalf("create task: %v", err)
	}

	turnID := "bbbb2222bbbb2222"
	if _, err := svc.BeginAssistantTurn("local", canvasID, turnID, AssistantTurnInput{
		PermissionMode: assistantturns.PermissionFullAccess,
	}); err != nil {
		t.Fatalf("BeginAssistantTurn: %v", err)
	}

	reg := agentops.NewRegistry(svc, agentops.NewStore(svc.Database()))
	agentops.RegisterDefaultOps(reg)
	caller := agentops.AssistantCaller(&agentops.AssistantScope{
		PermissionMode: assistantturns.PermissionFullAccess,
		CanvasID:       canvasID,
	}, false)

	created, err := reg.Execute(agentops.Request{
		Context: context.Background(),
		Op:      "canvas.create",
		OpID:    "op-create-canvas-1",
		UserID:  "local",
		Caller:  caller,
		TurnID:  turnID,
		Params:  json.RawMessage(`{"title":"新建分镜画布"}`),
	})
	if err != nil {
		t.Fatalf("canvas.create in full-access turn: %v", err)
	}
	createdMap := created.Result.(map[string]any)
	if createdMap["canvasId"] == "" || createdMap["canvasId"] == canvasID {
		t.Fatalf("expected distinct created canvasId, got %+v", createdMap)
	}

	cancelled, err := reg.Execute(agentops.Request{
		Context: context.Background(),
		Op:      "task.cancel",
		OpID:    "op-cancel-task-1",
		UserID:  "local",
		Caller:  caller,
		TurnID:  turnID,
		Params:  json.RawMessage(`{"taskId":"` + task.ID + `"}`),
	})
	if err != nil {
		t.Fatalf("task.cancel in assistant turn: %v", err)
	}
	if cancelled.Result.(map[string]any)["status"] != string(model.TaskStatusCancelled) {
		t.Fatalf("expected cancelled task, got %+v", cancelled.Result)
	}

	if err := svc.AssistantTurns().Finalize(turnID); err != nil {
		t.Fatalf("Finalize after canvas.create + task.cancel: %v", err)
	}
}

func TestAssistantRegenerateRequiresExplicitRegenerateConfirmation(t *testing.T) {
	svc, _, canvasID, _ := externalGenerationFixture(t)

	imgBytes := []byte("\x89PNG\r\n\x1a\n" + string(make([]byte, 32)))
	oldRes, err := svc.UploadLocalResourceFile("local", "old.png", int64(len(imgBytes)), "image", 64, 64, 0, bytes.NewReader(imgBytes), "old-img-res")
	if err != nil {
		t.Fatalf("upload old image: %v", err)
	}
	oldTask := model.Task{
		ID:          "task-old-done",
		UserID:      "local",
		ProjectID:   canvasID,
		Status:      model.TaskStatusSucceeded,
		ResultState: "READY",
		Type:        "canvas_image",
		Prompt:      "old cat",
		ResultJSON:  `{"outputs":[{"outputIndex":0,"resourceId":"` + oldRes.ID + `","mediaType":"image"}]}`,
	}
	if err := svc.Database().Create(&oldTask).Error; err != nil {
		t.Fatalf("create old task: %v", err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = []any{map[string]any{
		"id":    "node-img-1",
		"type":  "image",
		"title": "分镜1",
		"metadata": map[string]any{
			"composerContent": "new cat in rain",
			"size":            "1:1",
			"count":           1,
			"status":          "success",
			"taskId":          oldTask.ID,
			"storageKey":      "resource:" + oldRes.ID,
		},
	}}
	updatedRaw, _ := json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", updatedRaw); err != nil {
		t.Fatalf("save canvas: %v", err)
	}

	turnID := "cccc3333cccc3333"
	if _, err := svc.BeginAssistantTurn("local", canvasID, turnID, AssistantTurnInput{
		PermissionMode: assistantturns.PermissionCanvas,
	}); err != nil {
		t.Fatalf("BeginAssistantTurn: %v", err)
	}

	reg := agentops.NewRegistry(svc, agentops.NewStore(svc.Database()))
	agentops.RegisterDefaultOps(reg)
	caller := agentops.AssistantCaller(&agentops.AssistantScope{
		PermissionMode: assistantturns.PermissionCanvas,
		CanvasID:       canvasID,
	}, false)

	// Calling canvas.generation.regenerate directly without confirmed regenerate proposal MUST be rejected.
	if _, err := reg.Execute(agentops.Request{
		Context: context.Background(),
		Op:      "canvas.generation.regenerate",
		OpID:    "op-regen-unauth",
		UserID:  "local",
		Caller:  caller,
		TurnID:  turnID,
		Params:  json.RawMessage(`{"canvasId":"` + canvasID + `","nodeIds":["node-img-1"],"kind":"image"}`),
	}); err == nil {
		t.Fatal("expected unconfirmed canvas.generation.regenerate to be rejected")
	} else if opErr := agentops.AsError(err); opErr.Reason != "production_authorization_required" {
		t.Fatalf("expected production_authorization_required, got %+v", opErr)
	}

	// Propose with regenerate: true, then confirm through ConfirmAssistantProduction -> releases old node & creates new task.
	proposeRes, err := reg.Execute(agentops.Request{
		Context: context.Background(),
		Op:      "canvas.generation.propose",
		UserID:  "local",
		Caller:  caller,
		TurnID:  turnID,
		Params:  json.RawMessage(`{"canvasId":"` + canvasID + `","nodeIds":["node-img-1"],"kind":"image","regenerate":true}`),
	})
	if err != nil {
		t.Fatalf("canvas.generation.propose(regenerate=true): %v", err)
	}
	proposeMap := proposeRes.Result.(map[string]any)
	proposalID, _ := proposeMap["proposalId"].(string)
	if proposalID == "" || proposeMap["regenerate"] != true {
		t.Fatalf("expected regenerate proposalId, got %+v", proposeMap)
	}

	confirmed, err := svc.ConfirmAssistantProduction("local", turnID, AssistantProductionConfirmation{
		CanvasID:   canvasID,
		ProposalID: proposalID,
		Kind:       "image",
		NodeIDs:    []string{"node-img-1"},
		Regenerate: true,
	})
	if err != nil {
		t.Fatalf("ConfirmAssistantProduction(regenerate=true): %v", err)
	}
	confirmedMap := confirmed.(map[string]any)
	taskIDs, _ := confirmedMap["taskIds"].([]string)
	if len(taskIDs) != 1 || taskIDs[0] == "" || taskIDs[0] == oldTask.ID {
		t.Fatalf("expected new task after regenerate confirmation, got %+v", confirmedMap)
	}

	// Retrying confirmation while the newly admitted task is running MUST be idempotent (never fail with generation_task_exists).
	retried, err := svc.ConfirmAssistantProduction("local", turnID, AssistantProductionConfirmation{
		CanvasID:   canvasID,
		ProposalID: proposalID,
		Kind:       "image",
		NodeIDs:    []string{"node-img-1"},
		Regenerate: true,
	})
	if err != nil {
		t.Fatalf("ConfirmAssistantProduction retry while running: %v", err)
	}
	if retryIDs, _ := retried.(map[string]any)["taskIds"].([]string); len(retryIDs) != 1 || retryIDs[0] != taskIDs[0] {
		t.Fatalf("expected idempotent task ID %s on retry, got %+v", taskIDs[0], retried)
	}

	// Simulate the newly admitted task succeeding & materializing on the node, then retry regenerate confirmation:
	// MUST preserve the materialized storageKey instead of wiping this plan's own output!
	if err := svc.Database().Model(&model.Task{}).Where("id = ?", taskIDs[0]).Update("status", model.TaskStatusSucceeded).Error; err != nil {
		t.Fatalf("mark new task succeeded: %v", err)
	}
	rawAfter, _ := svc.UserCanvasProject("local", canvasID)
	var docAfter map[string]any
	_ = json.Unmarshal(rawAfter, &docAfter)
	nodeAfter := docAfter["nodes"].([]any)[0].(map[string]any)
	metaAfter := nodeAfter["metadata"].(map[string]any)
	metaAfter["status"] = "success"
	metaAfter["taskStatus"] = "succeeded"
	metaAfter["storageKey"] = "resource:new-materialized"
	savedAfter, _ := json.Marshal(docAfter)
	if _, err := svc.UpsertUserCanvasProject("local", savedAfter); err != nil {
		t.Fatalf("save materialized canvas: %v", err)
	}
	if _, err := svc.ConfirmAssistantProduction("local", turnID, AssistantProductionConfirmation{
		CanvasID:   canvasID,
		ProposalID: proposalID,
		Kind:       "image",
		NodeIDs:    []string{"node-img-1"},
		Regenerate: true,
	}); err != nil {
		t.Fatalf("ConfirmAssistantProduction retry after completion: %v", err)
	}
	rawFinal, _ := svc.UserCanvasProject("local", canvasID)
	var docFinal map[string]any
	_ = json.Unmarshal(rawFinal, &docFinal)
	finalMeta := docFinal["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)
	if finalMeta["storageKey"] != "resource:new-materialized" || finalMeta["status"] != "success" {
		t.Fatalf("retry after completion must not wipe this plan's succeeded output: %+v", finalMeta)
	}
	_ = operations.GenerationOrderPending
}
