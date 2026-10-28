package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

// Contract 3.11: a definitive result conclusion plus a refund permits a new
// retry, while the old free operation still identifies its original admission.
func TestStep3ImageRefundRetryAfterResultConclusion(t *testing.T) {
	for _, tc := range []struct {
		name, status, conclusion string
		acceptedAttempt          bool
		resultGone               bool
	}{
		{"failed", "failed", "no_result", false, false},
		{"expired accepted request", "expired", "unrecoverable", true, false},
		{"gone result", "completed", "unrecoverable", true, true},
	} {
		for _, numbered := range []bool{false, true} {
			mode := "legacy"
			if numbered {
				mode = "new operation"
			}
			t.Run(tc.name+"/"+mode, func(t *testing.T) {
				allowLoopbackProviderTest(t)
				var reads, creates atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodGet {
						creates.Add(1)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					reads.Add(1)
					if r.URL.Path == "/v1/images/jobs/job/result" && tc.resultGone {
						w.WriteHeader(http.StatusGone)
						return
					}
					if r.URL.Path != "/v1/images/jobs/job" {
						t.Errorf("unexpected query %s", r.URL.Path)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"job_id": "job", "status": tc.status, "billing_state": "refunded", "result_url": "/v1/images/jobs/job/result"})
				}))
				defer server.Close()
				t.Setenv("BEEFTV_ENTERPRISE_TEST_ORIGIN", server.URL)
				svc, db := openDBRuntimeMatrix(t, t.TempDir())
				defer closeDBRuntimeMatrix(t, svc, db)
				input, _ := json.Marshal(canvasGenerationInput{Mode: "image", Config: providerConfig{BaseURL: server.URL + "/v1", APIKey: "fake-key"}})
				task := model.Task{ID: "refunded-image", UserID: "local", Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "任务失败", Error: "请求过于频繁", RouteRun: 4, InputJSON: string(input)}
				if err := db.Create(&task).Error; err != nil {
					t.Fatal(err)
				}
				if tc.acceptedAttempt {
					attempt := model.RouteAttempt{ID: "accepted-image", TaskID: task.ID, RouteRun: 4, DispatchState: "accepted", StartedAt: time.Now().Add(-time.Minute)}
					if err := db.Create(&attempt).Error; err != nil {
						t.Fatal(err)
					}
					if err := db.Create(&model.ImageSubmission{AttemptID: attempt.ID, TaskID: task.ID, UserID: task.UserID, ResponseAccepted: true}).Error; err != nil {
						t.Fatal(err)
					}
				}
				if err := db.Create(&model.ApiCallLog{ID: "image-create", UserID: task.UserID, TaskID: task.ID, RouteRun: 4, Source: "beefapi", Capability: "image", RequestKind: "create", Method: "POST", ImageJobID: "job", CreatedAt: time.Now()}).Error; err != nil {
					t.Fatal(err)
				}
				first, err := svc.RetryTaskWithOperation(task.UserID, task.ID, "original-recovery")
				if err != nil || first.RecoveryOutcome == nil || *first.RecoveryOutcome != tc.conclusion || first.Outcome == nil || first.Outcome.Regenerate != "allowed" {
					t.Fatalf("refund recovery precondition: task=%+v err=%v", first, err)
				}
				before := reads.Load()
				if _, err := svc.RetryTaskWithOperation(task.UserID, task.ID, "original-recovery"); err != nil {
					t.Fatal(err)
				}
				var retried *model.Task
				if numbered {
					retried, err = svc.RetryTaskWithOperation(task.UserID, task.ID, "new-generation")
				} else {
					retried, err = svc.RetryTask(task.UserID, task.ID)
				}
				if err != nil || retried == nil || retried.Status != model.TaskStatusQueued || retried.RouteRun != 5 {
					t.Fatalf("refunded image not requeued: task=%+v err=%v extra_queries=%d", retried, err, reads.Load()-before)
				}
				if numbered {
					replayed, err := svc.RetryTaskWithOperation(task.UserID, task.ID, "new-generation")
					if err != nil || replayed.RetryOperation == nil || replayed.RetryOperation.Action != "retry" || replayed.RetryOperation.OriginalRouteRun != 4 || replayed.RetryOperation.AcceptedRouteRun != 5 || replayed.RouteRun != 5 {
						t.Fatalf("new admission not replayed: task=%+v err=%v", replayed, err)
					}
				}
				old, err := svc.RetryTaskWithOperation(task.UserID, task.ID, "original-recovery")
				if err != nil || old.RetryOperation == nil || old.RetryOperation.Action != "free_recovery" || old.RetryOperation.OriginalRouteRun != 4 || old.RetryOperation.AcceptedRouteRun != 4 || old.RouteRun != 5 || old.Status != model.TaskStatusQueued {
					t.Fatalf("old free identity changed: task=%+v err=%v", old, err)
				}
				if reads.Load() != before || creates.Load() != 0 {
					t.Fatalf("retry queried or submitted upstream: extra_queries=%d creates=%d", reads.Load()-before, creates.Load())
				}
			})
		}
	}
}

func TestStep3ImageConclusionWithoutRefundDoesNotRequeue(t *testing.T) {
	for _, tc := range []struct {
		name, billing, regenerate string
		present                   bool
	}{
		{"settled", "settled", "confirm", true},
		{"pending", "", "blocked", true},
		{"missing billing", "", "confirm", false},
	} {
		for _, numbered := range []bool{false, true} {
			mode := "legacy"
			if numbered {
				mode = "new operation"
			}
			t.Run(tc.name+"/"+mode, func(t *testing.T) {
				allowLoopbackProviderTest(t)
				var creates atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodGet {
						creates.Add(1)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					payload := map[string]any{"job_id": "job", "status": "failed"}
					if tc.present {
						payload["billing_state"] = tc.billing
					}
					_ = json.NewEncoder(w).Encode(payload)
				}))
				defer server.Close()
				t.Setenv("BEEFTV_ENTERPRISE_TEST_ORIGIN", server.URL)
				svc, db := openDBRuntimeMatrix(t, t.TempDir())
				defer closeDBRuntimeMatrix(t, svc, db)
				input, _ := json.Marshal(canvasGenerationInput{Mode: "image", Config: providerConfig{BaseURL: server.URL + "/v1", APIKey: "fake-key"}})
				task := model.Task{ID: "unrefunded-image", UserID: "local", Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "任务失败", Error: "请求过于频繁", RouteRun: 4, InputJSON: string(input)}
				if err := db.Create(&task).Error; err != nil {
					t.Fatal(err)
				}
				if err := db.Create(&model.ApiCallLog{ID: "image-create", UserID: task.UserID, TaskID: task.ID, RouteRun: 4, Source: "beefapi", Capability: "image", RequestKind: "create", Method: "POST", ImageJobID: "job", CreatedAt: time.Now()}).Error; err != nil {
					t.Fatal(err)
				}
				first, err := svc.RetryTaskWithOperation(task.UserID, task.ID, "original-recovery")
				if err != nil || first.RecoveryOutcome == nil || *first.RecoveryOutcome != "no_result" || first.Outcome == nil || first.Outcome.Regenerate != tc.regenerate {
					t.Fatalf("billing precondition: task=%+v err=%v", first, err)
				}
				if numbered {
					_, err = svc.RetryTaskWithOperation(task.UserID, task.ID, "unconfirmed-generation")
				} else {
					_, err = svc.RetryTask(task.UserID, task.ID)
				}
				current, readErr := svc.Task(task.UserID, task.ID)
				if err != nil || readErr != nil || current.Status != model.TaskStatusFailed || current.RouteRun != 4 || current.Outcome == nil || current.Outcome.Regenerate != tc.regenerate || creates.Load() != 0 {
					t.Fatalf("unconfirmed image requeued or billing changed: task=%+v err=%v readErr=%v creates=%d", current, err, readErr, creates.Load())
				}
			})
		}
	}
}
