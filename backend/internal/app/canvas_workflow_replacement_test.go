package app

import (
	"context"
	"encoding/json"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
	"testing"
)

func replacementString(s string) *string { return &s }

func TestReplacementLocalRetryDoesNotRefreshProviderCredentials(t *testing.T) {
	s, _, _ := workflowFixture(t)
	input, err := cw.PrepareRetryCredentials(s.compileHost(), model.CanvasWorkflowRun{RecipeCipher: "unreadable"}, "replace", &model.Task{Type: model.TaskTypeCanvasMediaTransform, Status: model.TaskStatusFailed, InputJSON: `{"node":{}}`})
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
	state, _ := json.Marshal(cw.Run{Status: "failed", Steps: []cw.Step{{NodeID: "replace", Status: "failed", TaskID: task.ID, Replacement: &cw.ReplacementProgress{}}}})
	row := model.CanvasWorkflowRun{ID: "retry-reconciliation", UserID: "owner", Status: "failed", StateJSON: string(state)}
	if err := db.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	run, err := s.workflowRuns().Retry("owner", row.ID)
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
	child := model.Task{ID: "uncheckpointed-child", UserID: "owner", Type: model.TaskTypeCanvasMediaTransform, Status: model.TaskStatusQueued, ClientOperationID: replacementString(cw.StepOperation(row.ID, n.ID) + ":part:0")}
	if e := db.Create(&child).Error; e != nil {
		t.Fatal(e)
	}
	if _, e := s.workflowRuns().Cancel(context.Background(), "owner", row.ID); e != nil {
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

func TestReplacementReconcilesChildrenAcrossCheckpointCrash(t *testing.T) {
	s, db, _ := workflowFixture(t)
	n := cw.Node{ID: "replace", Title: "Replace", Role: "operation", OperationID: cw.CharacterReplacementOperation, OperationVersion: 1, MediaType: "video", Config: map[string]any{"modelOption": "channel::seedance-2.0-fast"}}
	d := cw.Definition{Version: 1, Nodes: []cw.Node{
		{ID: "source", Role: "input", Title: "原视频", MediaType: "video"},
		{ID: "character", Role: "input", Title: "参考图", MediaType: "image"}, n,
	}, OutputNodeIDs: []string{n.ID}, Edges: []cw.Edge{{From: "source", To: n.ID, ToPort: "video"}, {From: "character", To: n.ID, ToPort: "character"}}}
	steps := map[string]*cw.Step{"source": {Status: "succeeded", ResourceID: "old-action"}, "character": {Status: "succeeded", ResourceID: "new-person"}}
	rawDefinition, _ := json.Marshal(d)
	state, _ := json.Marshal(cw.Run{Steps: []cw.Step{
		{NodeID: "source", Status: "succeeded", ResourceID: steps["source"].ResourceID},
		{NodeID: "character", Status: "succeeded", ResourceID: steps["character"].ResourceID},
		{NodeID: n.ID, Status: "pending"},
	}})
	cipher, err := s.encryptSettingSecret("{}")
	if err != nil {
		t.Fatal(err)
	}
	row := model.CanvasWorkflowRun{ID: "run-replacement", UserID: "owner", Status: "running", DefinitionJSON: string(rawDefinition), StateJSON: string(state), RecipeCipher: cipher}
	if err := db.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	base := cw.StepOperation(row.ID, n.ID)
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
	for i := 0; i < 3; i++ {
		s.workflowRuns().Advance(&row)
		if err := db.First(&row, "id = ?", row.ID).Error; err != nil {
			t.Fatal(err)
		}
	}
	run, err := cw.RunFromRow(row)
	if err != nil {
		t.Fatal(err)
	}
	step := run.Steps[2]
	if step.Status != "succeeded" || !step.ReviewRequired || step.ResourceID != "old-output" || step.Replacement.Plan.Segments[0].OutputResourceID != "new-output" {
		t.Fatalf("bad final checkpoint %+v", step)
	}
	var count int64
	db.Model(&model.Task{}).Where("client_operation_id LIKE ?", base+"%").Count(&count)
	if count != 3 {
		t.Fatalf("duplicated child tasks: %d", count)
	}
}

func TestReplacementSegmentRejectsOutOfBoundsReferenceVideoDimensionsAndBytes(t *testing.T) {
	s, db, _ := workflowFixture(t)
	if err := db.Create(&model.Resource{ID: "seg-small-dim", UserID: "owner", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Width: 640, Height: 360, Size: 256, DurationMs: 4000}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Resource{ID: "seg-large-bytes", UserID: "owner", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Width: 1280, Height: 720, Size: 2048, DurationMs: 4000}).Error; err != nil {
		t.Fatal(err)
	}
	n := cw.Node{ID: "replace", Title: "Replace", Role: "operation", OperationID: cw.CharacterReplacementOperation, OperationVersion: 1, MediaType: "video", Config: map[string]any{"modelOption": "channel::custom-hd"}}
	d := cw.Definition{Version: 1, Nodes: []cw.Node{
		{ID: "source", Role: "input", Title: "原视频", MediaType: "video"},
		{ID: "character", Role: "input", Title: "参考图", MediaType: "image"}, n,
	}, OutputNodeIDs: []string{n.ID}, Edges: []cw.Edge{{From: "source", To: n.ID, ToPort: "video"}, {From: "character", To: n.ID, ToPort: "character"}}}
	rawDefinition, _ := json.Marshal(d)
	capCfg := map[string]any{
		"video": map[string]any{
			"operations":  []string{"reference_to_video"},
			"resolutions": []string{"720p"},
			"duration":    map[string]any{"selection": "range", "min": 4, "max": 10, "default": 5},
			"references": map[string]any{
				"minImages":      1,
				"maxImages":      2,
				"maxVideos":      1,
				"maxVideoBytes":  512,
				"minVideoWidth":  1280,
				"minVideoHeight": 720,
				"maxVideoWidth":  1920,
				"maxVideoHeight": 1080,
			},
		},
	}
	recipesRaw, _ := json.Marshal(cw.RecipesByNode{
		n.ID: {
			Request: cw.RecipeRequest{
				Type:  "canvas_video",
				Model: "custom-hd",
				Input: map[string]any{"config": map[string]any{"interfaceType": "volcengine-ark-video", "capabilityConfig": capCfg}},
			},
		},
	})
	cipher, err := s.encryptSettingSecret(string(recipesRaw))
	if err != nil {
		t.Fatal(err)
	}
	for _, segID := range []string{"seg-small-dim", "seg-large-bytes"} {
		p := cw.ReplacementPlan{
			Width:            1280,
			Height:           720,
			FPS:              30,
			SourceResourceID: "old-action",
			Segments:         []cw.ReplacementSegment{{ResourceID: segID, GenerationSeconds: 4, ReferenceFrames: 120, EndFrame: 120, ReferenceEndFrame: 120}},
		}
		state, _ := json.Marshal(cw.Run{Steps: []cw.Step{
			{NodeID: "source", Status: "succeeded", ResourceID: "old-action"},
			{NodeID: "character", Status: "succeeded", ResourceID: "new-person"},
			{NodeID: n.ID, Status: "running", Replacement: &cw.ReplacementProgress{PrepareTaskID: "done-prep", Plan: &p}},
		}})
		row := model.CanvasWorkflowRun{ID: "reject-" + segID, UserID: "owner", ClientOperationID: "op-" + segID, Status: "running", DefinitionJSON: string(rawDefinition), StateJSON: string(state), RecipeCipher: cipher}
		if err := db.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
		s.workflowRuns().Advance(&row)
		if err := db.First(&row, "id = ?", row.ID).Error; err != nil {
			t.Fatal(err)
		}
		if row.Status != "failed" {
			t.Fatalf("expected segment %s to be rejected, got status=%s state=%s", segID, row.Status, row.StateJSON)
		}
	}
}
