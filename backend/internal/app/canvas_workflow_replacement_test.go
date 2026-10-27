package app

import (
	"context"
	"encoding/json"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
	"strings"
	"testing"
)

func TestReplacementRequestUsesOnlyCurrentInputsAndFast(t *testing.T) {
	s, _, _ := workflowFixture(t)
	recipe := workflowRecipe{Request: CreateTaskRequest{Type: "canvas_video", Model: "seedance-2.0-fast", Input: map[string]any{"mode": "video", "config": map[string]any{"model": "seedance-2.0-fast"}}}}
	p := cw.ReplacementPlan{Width: 714, Height: 1280, FPS: 30, FrameCount: 422, Segments: []cw.ReplacementSegment{{ResourceID: "new-depth", GenerationSeconds: 15}}}
	req, e := s.replacementRequest("owner", "part-once", cw.Node{}, recipe, p, 0, "new-person")
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(req)
	if strings.Contains(string(raw), "old-person") || strings.Contains(string(raw), "old-action") {
		t.Fatal("old example leaked into new run")
	}
	config := req.Input["config"].(map[string]any)
	if config["size"] != "9:16" || config["videoSeconds"] != "15" || config["vquality"] != "720p" {
		t.Fatal(config)
	}
	if len(req.Input["referenceVideos"].([]any)) != 1 || len(req.Input["referenceImages"].([]any)) != 1 {
		t.Fatal("separate references missing")
	}
	recipe.Request.Model = "seedance-2.5"
	if _, e = s.replacementRequest("owner", "wrong", cw.Node{}, recipe, p, 0, "new-person"); e == nil {
		t.Fatal("different video model accepted")
	}
}

func TestReplacementReconcilesChildrenAcrossCheckpointCrash(t *testing.T) {
	s, db, _ := workflowFixture(t)
	n := cw.Node{ID: "replace", Title: "Replace", Role: "operation", OperationID: cw.CharacterReplacementOperation, OperationVersion: 1, MediaType: "video", Config: map[string]any{"modelOption": "channel::seedance-2.0-fast"}}
	d := cw.Definition{Version: 1, Nodes: []cw.Node{n}, Edges: []cw.Edge{{From: "source", To: n.ID, ToPort: "video"}, {From: "character", To: n.ID, ToPort: "character"}}}
	steps := map[string]*cw.Step{"source": {Status: "succeeded", ResourceID: "old-action"}, "character": {Status: "succeeded", ResourceID: "new-person"}}
	row := model.CanvasWorkflowRun{ID: "run-replacement", UserID: "owner"}
	base := workflowOperation(row.ID, n.ID)
	p, _ := cw.PlanCharacterReplacement(640, 360, 30, 30, nil, 12)
	p.SourceResourceID = "old-action"
	p.Segments[0].ResourceID = "new-depth"
	prepare, _ := json.Marshal(map[string]any{"replacementPlan": p})
	tasks := []model.Task{{ID: "prep", UserID: "owner", Type: model.TaskTypeCanvasMediaTransform, Status: model.TaskStatusSucceeded, ClientOperationID: replacementString(base + ":prepare"), ResultJSON: string(prepare)},
		{ID: "part", UserID: "owner", Type: "canvas_video", Status: model.TaskStatusSucceeded, ClientOperationID: replacementString(base + ":part:0"), ResultJSON: `{"video":{"resourceId":"new-output"}}`},
		{ID: "finish", UserID: "owner", Type: model.TaskTypeCanvasMediaTransform, Status: model.TaskStatusSucceeded, ClientOperationID: replacementString(base + ":finish"), ResultJSON: `{"video":{"resourceId":"old-output"}}`}}
	for i := range tasks {
		if e := db.Create(&tasks[i]).Error; e != nil {
			t.Fatal(e)
		}
	}
	step := cw.Step{NodeID: n.ID, Status: "pending"}
	for i := 0; i < 3; i++ {
		if e := s.advanceReplacement(&row, n, d, steps, &step, workflowRecipe{}); e != nil {
			t.Fatal(e)
		}
		raw, _ := json.Marshal(step)
		if e := json.Unmarshal(raw, &step); e != nil {
			t.Fatal(e)
		}
	}
	if step.Status != "succeeded" || !step.ReviewRequired || step.ResourceID != "old-output" || step.Replacement.Plan.Segments[0].OutputResourceID != "new-output" {
		t.Fatalf("bad final checkpoint %+v", step)
	}
	var count int64
	db.Model(&model.Task{}).Where("client_operation_id LIKE ?", base+"%").Count(&count)
	if count != 3 {
		t.Fatalf("duplicated child tasks: %d", count)
	}
}

func replacementString(s string) *string { return &s }

func TestReplacementProgressReportsPhasesWithoutEarlyCompletion(t *testing.T) {
	p, stage := replacementTaskProgress(&cw.ReplacementProgress{}, &model.Task{Status: model.TaskStatusRunning, Progress: 50})
	if p != 5 || stage != "正在整理参考素材" {
		t.Fatalf("prepare: %d %s", p, stage)
	}
	state := &cw.ReplacementProgress{Plan: &cw.ReplacementPlan{Segments: []cw.ReplacementSegment{{OutputResourceID: "done"}, {}}}}
	p, stage = replacementTaskProgress(state, &model.Task{Status: model.TaskStatusRunning, Progress: 50})
	if p != 70 || stage != "正在生成替换视频（2/2）" {
		t.Fatalf("generation: %d %s", p, stage)
	}
	p, stage = replacementTaskProgress(state, &model.Task{Status: model.TaskStatusRunning, Progress: 100, PollStage: "download"})
	if p >= 90 || stage != "正在下载生成视频（2/2）" {
		t.Fatalf("download: %d %s", p, stage)
	}
	state.Plan.Segments[1].OutputResourceID = "done2"
	p, stage = replacementTaskProgress(state, &model.Task{Status: model.TaskStatusRunning, Progress: 100})
	if p >= 100 || stage != "正在合成并校验视频" {
		t.Fatalf("finish: %d %s", p, stage)
	}
	p, _ = replacementTaskProgress(state, &model.Task{Status: model.TaskStatusSucceeded, Progress: 100})
	if p != 100 {
		t.Fatal("successful finish should complete progress")
	}
}

func TestReplacementReviewMarkerSurvivesDownstreamMediaStep(t *testing.T) {
	s, db, _ := workflowFixture(t)
	d := cw.Definition{Version: 1, Nodes: []cw.Node{{ID: "replaced", Title: "替换", Role: "constant", MediaType: "video", ResourceID: "new-depth"}, {ID: "downstream", Title: "帧率", Role: "operation", OperationID: "video.frame-rate", OperationVersion: 1, MediaType: "video", Config: map[string]any{"fps": 30}}}, Edges: []cw.Edge{{From: "replaced", To: "downstream", ToPort: "video"}}, OutputNodeIDs: []string{"downstream"}}
	definition, _ := json.Marshal(d)
	state, _ := json.Marshal(cw.Run{Status: "running", Steps: []cw.Step{{NodeID: "replaced", Status: "succeeded", ResourceID: "new-depth", ReviewRequired: true}, {NodeID: "downstream", Status: "pending"}}})
	cipher, err := s.encryptSettingSecret(`{}`)
	if err != nil {
		t.Fatal(err)
	}
	row := model.CanvasWorkflowRun{ID: "review-propagation", UserID: "owner", Status: "running", DefinitionJSON: string(definition), StateJSON: string(state), RecipeCipher: cipher}
	if err = db.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	child := model.Task{ID: "downstream-done", UserID: "owner", Type: model.TaskTypeCanvasMediaTransform, Status: model.TaskStatusSucceeded, ClientOperationID: replacementString(workflowOperation(row.ID, "downstream")), ResultJSON: `{"video":{"resourceId":"new-output"}}`}
	if err = db.Create(&child).Error; err != nil {
		t.Fatal(err)
	}
	s.advanceCanvasWorkflow(&row)
	run, err := workflowRun(row)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != "succeeded" || len(run.Outputs) != 1 || !run.Outputs[0].ReviewRequired {
		t.Fatalf("lost review requirement: %+v", run)
	}
}

func TestReplacementLocalRetryDoesNotRefreshProviderCredentials(t *testing.T) {
	s, _, _ := workflowFixture(t)
	input, err := s.prepareCanvasWorkflowRetryCredentials(model.CanvasWorkflowRun{RecipeCipher: "unreadable"}, "replace", &model.Task{Type: model.TaskTypeCanvasMediaTransform, Status: model.TaskStatusFailed, InputJSON: `{"node":{}}`})
	if err != nil || input != "" {
		t.Fatalf("local media retry reached provider credentials: %q %v", input, err)
	}
}

func TestReplacementRetryReconcilesSuccessfulChildWithoutResubmitting(t *testing.T) {
	s, db, _ := workflowFixture(t)
	task := model.Task{ID: "successful-child", UserID: "owner", Type: "canvas_video", Status: model.TaskStatusSucceeded}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	state, _ := json.Marshal(cw.Run{Status: "failed", Steps: []cw.Step{{NodeID: "replace", Status: "failed", TaskID: task.ID}}})
	row := model.CanvasWorkflowRun{ID: "retry-reconciliation", UserID: "owner", Status: "failed", StateJSON: string(state)}
	if err := db.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	run, err := s.RetryCanvasWorkflow("owner", row.ID)
	if err != nil {
		t.Fatal(err)
	}
	if run.Steps[0].TaskID != task.ID || run.Steps[0].Status != "pending" {
		t.Fatal("successful child was not retained for reconciliation")
	}
}

func TestReplacementCancelFindsChildBeforeParentCheckpoint(t *testing.T) {
	s, db, _ := workflowFixture(t)
	n := cw.Node{ID: "replace", OperationID: cw.CharacterReplacementOperation}
	d, _ := json.Marshal(cw.Definition{Nodes: []cw.Node{n}})
	p, _ := cw.PlanCharacterReplacement(640, 360, 30, 30, nil, 12)
	p.SourceResourceID = "old-action"
	p.Segments[0].ResourceID = "new-depth"
	state, _ := json.Marshal(cw.Run{Status: "running", Steps: []cw.Step{{NodeID: n.ID, Status: "running", Replacement: &cw.ReplacementProgress{PrepareTaskID: "done-prepare", Plan: &p}}}})
	row := model.CanvasWorkflowRun{ID: "cancel-replacement", UserID: "owner", Status: "running", DefinitionJSON: string(d), StateJSON: string(state)}
	if e := db.Create(&row).Error; e != nil {
		t.Fatal(e)
	}
	child := model.Task{ID: "uncheckpointed-child", UserID: "owner", Type: model.TaskTypeCanvasMediaTransform, Status: model.TaskStatusQueued, ClientOperationID: replacementString(workflowOperation(row.ID, n.ID) + ":part:0")}
	if e := db.Create(&child).Error; e != nil {
		t.Fatal(e)
	}
	if _, e := s.CancelCanvasWorkflow(context.Background(), "owner", row.ID); e != nil {
		t.Fatal(e)
	}
	saved, e := s.repo.TaskForUser("owner", child.ID)
	if e != nil {
		t.Fatal(e)
	}
	if saved.Status != model.TaskStatusCancelled {
		t.Fatal("uncheckpointed child was not cancelled")
	}
}
