package app

import (
	"encoding/json"
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func externalGenerationFixture(t *testing.T) (*Service, *operations.Registry, string, int64) {
	t.Helper()
	svc, canvasID, _ := newAssistantTurnService(t)
	sqlDB, _ := svc.Database().DB()
	sqlDB.SetMaxOpenConns(1)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::qwen-image-2.1","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["qwen-image-2.1"],"modelProfiles":[{"model":"qwen-image-2.1","capability":"image","protocol":"openai-image"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = []any{
		map[string]any{"id": "image", "type": "image", "metadata": map[string]any{"prompt": "A wooden tray", "size": "1:1", "count": 1}},
		map[string]any{"id": "image-2", "type": "image", "metadata": map[string]any{"prompt": "A glass of water", "size": "1:1", "count": 1}},
	}
	doc["connections"] = []any{}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	r := operations.NewRegistry(svc, operations.NewStore(svc.Database()))
	operations.RegisterDefaultOps(r)
	return svc, r, canvasID, canvasRevisionOf(t, svc, canvasID)
}

func externalGenerationRequest(canvasID string, revision int64, operationID string) operations.Request {
	raw, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{"image", "image-2"}, "expectedRevision": revision, "expectedModelConfigRevision": 1})
	return operations.Request{Op: "canvas.generation.submit", OpID: operationID, UserID: "local", Caller: operations.ExternalCaller(false), Params: raw}
}

func TestExternalGenerationSubmitsAndReplaysWithoutAssistantTurn(t *testing.T) {
	svc, r, canvasID, revision := externalGenerationFixture(t)
	req := externalGenerationRequest(canvasID, revision, "external-confirmed-1")
	first, err := r.Execute(req)
	if err != nil {
		t.Fatal(err)
	}
	second, err := r.Execute(req)
	if err != nil || !second.Replayed || !reflect.DeepEqual(first.Result, second.Result) {
		t.Fatalf("replay = %+v, %v", second, err)
	}
	var tasks []model.Task
	if err := svc.Database().Find(&tasks).Error; err != nil || len(tasks) != 2 {
		t.Fatalf("tasks = %d, %v", len(tasks), err)
	}
	for _, task := range tasks {
		var input struct {
			Config struct {
				Model string `json:"model"`
			} `json:"config"`
		}
		if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
			t.Fatal(err)
		}
		if task.Status != model.TaskStatusQueued || task.ProjectID != canvasID || input.Config.Model != "qwen-image-2.1" {
			t.Fatalf("unexpected admitted task: %s, %s, %s", task.Status, task.ProjectID, input.Config.Model)
		}
	}
	var turns int64
	svc.Database().Model(&model.AssistantTurn{}).Count(&turns)
	if turns != 0 {
		t.Fatal("external submission invented an assistant turn")
	}
	// A new key must not purchase another generation while the original node has a task.
	duplicate := externalGenerationRequest(canvasID, first.Revision, "external-confirmed-2")
	if _, err := r.Execute(duplicate); err == nil {
		t.Fatal("duplicate target accepted")
	}
	// Old read-only credentials may not replay a write receipt.
	req.Caller = operations.ExternalCaller(true)
	if _, err := r.Execute(req); err == nil {
		t.Fatal("read-only replay accepted")
	}
}

func TestExternalGenerationValidationAndAtomicAdmission(t *testing.T) {
	svc, r, canvasID, revision := externalGenerationFixture(t)
	for _, tc := range []struct {
		name   string
		mutate func(*operations.Request)
	}{
		{"stale canvas", func(r *operations.Request) { r.Params = externalGenerationRequest(canvasID, revision-1, "").Params }},
		{"missing revision", func(r *operations.Request) {
			r.Params = json.RawMessage(`{"canvasId":"` + canvasID + `","nodeIds":["image"]}`)
		}},
		{"stale model config", func(r *operations.Request) {
			var params map[string]any
			_ = json.Unmarshal(r.Params, &params)
			params["expectedModelConfigRevision"] = 0
			r.Params, _ = json.Marshal(params)
		}},
		{"other user", func(r *operations.Request) { r.UserID = "another-user" }},
		{"manual cannot impersonate external", func(r *operations.Request) { r.Caller = operations.ManualCaller(false) }},
		{"read-only", func(r *operations.Request) { r.Caller = operations.ExternalCaller(true) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := externalGenerationRequest(canvasID, revision, tc.name)
			tc.mutate(&req)
			if _, err := r.Execute(req); err == nil {
				t.Fatal("invalid admission accepted")
			}
		})
	}
	if err := svc.Database().Exec("CREATE TRIGGER fail_external_batch BEFORE INSERT ON tasks WHEN NEW.prompt = 'A glass of water' BEGIN SELECT RAISE(ABORT, 'fixture second admission failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	req := externalGenerationRequest(canvasID, revision, "atomic-external")
	if _, err := r.Execute(req); err == nil {
		t.Fatal("second admission failure accepted")
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 0 || canvasRevisionOf(t, svc, canvasID) != revision {
		t.Fatal("failed batch left a task or canvas mutation", count)
	}
	if err := svc.Database().Exec("DROP TRIGGER fail_external_batch").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := r.Execute(req); err != nil {
		t.Fatal("rolled-back batch could not retry same key", err)
	}
}
