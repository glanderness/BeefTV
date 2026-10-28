package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

// Wire shapes: BeefAPI be8f7072 dto/task.go TaskDto/TaskResponse and
// controller/image_jobs.go GetImageJob/GetImageJobResult; synthetic identities.
func TestStep3VideoDTOBillingPersistsWithoutLogs(t *testing.T) {
	allowLoopbackProviderTest(t)
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		fmt.Fprint(w, `{"code":"success","data":{"id":42,"task_id":"original","status":"FAILURE","usage_state":"failed","reconcile_deadline":1793160000,"data":{"usage_state":"pending"}}}`)
	}))
	defer server.Close()
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	input, _ := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: server.URL + "/v1", APIKey: "fake-key", InterfaceType: "newapi"}})
	noResult := "no_result"
	task := model.Task{ID: "dto-billing", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, RouteRun: 2, RouteID: "route-a", ProviderRequestID: "original", RecoveryOutcome: &noResult, InputJSON: string(input)}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: server.URL})
	_, _ = svc.QueryFailedVideoTask(ctx, task.UserID, task.ID)
	if path != "/v1/video/generations/original" {
		t.Errorf("billing query path=%q", path)
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.BillingEvidence == nil || stored.BillingEvidence.UsageState != "failed" {
		t.Errorf("missing raw DTO evidence: %+v", stored.BillingEvidence)
	}
	if err := db.Where("task_id = ?", task.ID).Delete(&model.ApiCallLog{}).Error; err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task(task.UserID, task.ID)
	if err != nil || got.Outcome == nil || got.Outcome.Regenerate != "allowed" {
		t.Fatalf("projection after log removal=%+v err=%v", got, err)
	}
}

func TestStep3BillingProjectionIgnoresDiagnosticLogRefund(t *testing.T) {
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	noResult := "no_result"
	task := model.Task{ID: "log-only", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, RouteRun: 2, ProviderRequestID: "original", RecoveryOutcome: &noResult, InputJSON: `{}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ApiCallLog{ID: "diagnostic-only", UserID: task.UserID, TaskID: task.ID, RouteRun: 2, Source: "beefapi", UsageState: "failed", UsageStatePresent: true}).Error; err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task(task.UserID, task.ID)
	if err != nil || got.Outcome == nil || got.Outcome.Regenerate != "confirm" {
		t.Fatalf("diagnostic log changed billing decision: %+v err=%v", got, err)
	}
}

func TestStep3ImageJobTerminalConclusionAndResultJSON(t *testing.T) {
	for _, tc := range []struct {
		name, status, billing, want string
		resultStatus                int
	}{
		{"failed", "failed", "refunded", "no_result", 0},
		{"expired", "expired", "settled", "unrecoverable", 0},
		{"result expired", "completed", "settled", "unrecoverable", http.StatusGone},
		{"temporary result outage", "completed", "settled", "", http.StatusServiceUnavailable},
		{"result JSON", "completed", "settled", "ready", http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			allowLoopbackProviderTest(t)
			var resultReads, creates atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					creates.Add(1)
					w.WriteHeader(400)
					return
				}
				if r.URL.Path == "/v1/images/jobs/job/result" {
					resultReads.Add(1)
					w.WriteHeader(tc.resultStatus)
					if tc.resultStatus == 200 {
						fmt.Fprint(w, `{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}]}`)
					}
					return
				}
				if r.URL.Path != "/v1/images/jobs/job" {
					t.Errorf("query path=%q", r.URL.Path)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"job_id": "job", "status": tc.status, "billing_state": tc.billing, "result_url": "/v1/images/jobs/job/result"})
			}))
			defer server.Close()
			t.Setenv("BEEFTV_ENTERPRISE_TEST_ORIGIN", server.URL)
			svc, db := openDBRuntimeMatrix(t, t.TempDir())
			defer closeDBRuntimeMatrix(t, svc, db)
			input, _ := json.Marshal(canvasGenerationInput{Mode: "image", Config: providerConfig{BaseURL: server.URL + "/v1", APIKey: "fake-key"}})
			task := model.Task{ID: "image-job-terminal", UserID: "local", Type: "canvas_image", Status: model.TaskStatusFailed, RouteRun: 4, InputJSON: string(input)}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.ApiCallLog{ID: "job-create", UserID: task.UserID, TaskID: task.ID, RouteRun: 4, Source: "beefapi", Capability: "image", RequestKind: "create", Method: "POST", ImageJobID: "job", CreatedAt: time.Now()}).Error; err != nil {
				t.Fatal(err)
			}
			_, _ = svc.RetryTaskWithOperation(task.UserID, task.ID, "recover-job")
			got, err := svc.Task(task.UserID, task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if tc.want == "ready" {
				if got.Status != model.TaskStatusSucceeded {
					t.Errorf("result JSON not recovered: %+v", got)
				}
			} else if tc.want != "" {
				if got.RecoveryOutcome == nil || *got.RecoveryOutcome != tc.want {
					t.Errorf("terminal conclusion=%v want=%s", got.RecoveryOutcome, tc.want)
				}
			} else if got.RecoveryOutcome != nil {
				t.Errorf("temporary failure became permanent: %v", got.RecoveryOutcome)
			}
			if tc.resultStatus > 0 && resultReads.Load() != 1 {
				t.Errorf("result endpoint reads=%d", resultReads.Load())
			}
			if got.RouteRun != 4 || creates.Load() != 0 {
				t.Fatalf("free recovery changed generation: run=%d creates=%d", got.RouteRun, creates.Load())
			}
		})
	}
}
