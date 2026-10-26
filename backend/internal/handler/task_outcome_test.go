package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestTaskOutcomeReadEndpointsOnlyAddPublicProjection(t *testing.T) {
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}
	op := "canvas:outcome-receipt"
	conclusion := "unrecoverable"
	task := model.Task{ID: "outcome-task", UserID: owner.ID, ProjectID: "outcome-canvas", Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "submission_unknown", ClientOperationID: &op, RecoveryOutcome: &conclusion, InputJSON: `{"mode":"image","config":{"apiKey":"never-expose"},"metadata":{"nodeId":"n1"}}`}
	if err := h.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/tasks/" + task.ID, "/api/tasks/by-operation/" + op + "?projectId=" + task.ProjectID, "/api/tasks?projectId=" + task.ProjectID} {
		t.Run(path, func(t *testing.T) {
			resp := h.do(t, http.MethodGet, path, nil)
			if resp.Code != 200 {
				t.Fatalf("%d %s", resp.Code, resp.Body.String())
			}
			if strings.Contains(resp.Body.String(), "never-expose") || strings.Contains(resp.Body.String(), "recovery_outcome") {
				t.Fatal("泄露私有事实或凭据")
			}
			var env struct {
				Data json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil {
				t.Fatal(err)
			}
			var got model.Task
			if strings.HasPrefix(strings.TrimSpace(string(env.Data)), "[") {
				var items []model.Task
				if err := json.Unmarshal(env.Data, &items); err != nil || len(items) != 1 {
					t.Fatalf("list=%s err=%v", env.Data, err)
				}
				got = items[0]
			} else if err := json.Unmarshal(env.Data, &got); err != nil {
				t.Fatal(err)
			}
			if got.ID != task.ID || got.Status != model.TaskStatusFailed || got.Outcome == nil || got.Outcome.Phase != "failed" || got.Outcome.Regenerate != "confirm" || got.Outcome.Reason != "result_unrecoverable" {
				t.Fatalf("投影=%+v", got)
			}
		})
	}
	stored, err := h.svc.Task(owner.ID, task.ID)
	if err != nil || stored.Status != task.Status {
		t.Fatal("读接口改了任务")
	}
}
