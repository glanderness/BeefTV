package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func TestStep3WorkerRecoversFailedThirdPartyVideo(t *testing.T) {
	allowLoopbackProviderTest(t)
	media, err := os.ReadFile("testdata/reference-fragmented-30fps.mp4")
	if err != nil {
		t.Fatal(err)
	}
	var creates, polls atomic.Int32
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			creates.Add(1)
			w.WriteHeader(400)
			return
		}
		if r.URL.Path == "/result.mp4" {
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(media)
			return
		}
		polls.Add(1)
		fmt.Fprintf(w, `{"id":"original","status":"completed","video_url":%q}`, server.URL+"/result.mp4")
	}))
	defer server.Close()
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	input, _ := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: server.URL, APIKey: "fake-key"}})
	old := time.Now().Add(-72 * time.Hour)
	task := model.Task{ID: "auto-original", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, RouteRun: 5, ProviderRequestID: "original", InputJSON: string(input), CreatedAt: old, UpdatedAt: old}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	svc.StartWorker()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		current, err := svc.Task(task.UserID, task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if current.Status == model.TaskStatusSucceeded {
			if current.RouteRun != 5 || current.ProviderRequestID != "original" || creates.Load() != 0 || polls.Load() != 1 {
				t.Fatalf("recovery changed original: %+v creates=%d polls=%d", current, creates.Load(), polls.Load())
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("background worker did not query original video: polls=%d creates=%d", polls.Load(), creates.Load())
}

func TestStep3ClosedResultStillReconcilesPendingBilling(t *testing.T) {
	allowLoopbackProviderTest(t)
	var polls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		polls.Add(1)
		if r.Method != http.MethodGet || r.URL.Path != "/v1/video/generations/original" {
			t.Errorf("unexpected query %s %s", r.Method, r.URL.Path)
		}
		fmt.Fprint(w, `{"code":"success","data":{"id":42,"task_id":"original","status":"FAILURE","usage_state":"failed"}}`)
	}))
	defer server.Close()
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	input, _ := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: server.URL, APIKey: "fake-key", InterfaceType: "newapi"}})
	conclusion := "no_result"
	task := model.Task{ID: "pending-closed", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, RouteRun: 3, ProviderRequestID: "original", RecoveryOutcome: &conclusion, InputJSON: string(input), BillingEvidence: &model.TaskBillingEvidence{Source: "beefapi", RouteRun: 3, ProviderRequestID: "original", UsageStatePresent: true, UsageState: "pending"}}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: server.URL})
	_, _ = svc.backgroundWorkers().Start()
	svc.startImageRecoveryPass(ctx)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && svc.imageRecoveryActive.Load() {
		time.Sleep(time.Millisecond)
	}
	current, err := svc.Task(task.UserID, task.ID)
	if err != nil || polls.Load() != 1 || current.Outcome == nil || current.Outcome.Regenerate != "allowed" {
		t.Fatalf("closed pending not reconciled: task=%+v err=%v polls=%d", current, err, polls.Load())
	}
}
