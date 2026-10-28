package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func TestStep3BillingMissingFieldsAndFailedQueryKeepObservation(t *testing.T) {
	allowLoopbackProviderTest(t)
	var round atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch round.Load() {
		case 0:
			fmt.Fprint(w, `{"code":"success","data":{"id":42,"task_id":"original","status":"FAILURE","usage_state":"pending","reconcile_deadline":1793160000}}`)
		case 1:
			fmt.Fprint(w, `{"code":"success","data":{"task_id":"original","status":"failed","format":"mp4","metadata":null,"error":null}}`)
		case 2:
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			fmt.Fprint(w, `{"code":"success","data":{"id":42,"task_id":"original","status":"FAILURE","usage_state":"failed"}}`)
		}
	}))
	defer server.Close()
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	input, _ := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: server.URL, APIKey: "fake", InterfaceType: "newapi"}})
	conclusion := "no_result"
	task := model.Task{ID: "observation-continuity", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "original", RouteRun: 2, RouteID: "route-a", RecoveryOutcome: &conclusion, InputJSON: string(input)}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: server.URL})
	for i := 0; i < 4; i++ {
		round.Store(int32(i))
		_, _ = svc.QueryFailedVideoTask(ctx, task.UserID, task.ID)
		var stored model.Task
		if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
			t.Fatal(err)
		}
		want := "pending"
		if i == 3 {
			want = "failed"
		}
		if stored.BillingEvidence == nil || stored.BillingEvidence.UsageState != want || stored.BillingEvidence.ReconcileDeadline != 1793160000 {
			t.Fatalf("round %d lost original observation: %+v", i, stored.BillingEvidence)
		}
	}
}

func TestStep3LateBillingCannotOverwriteChangedRoute(t *testing.T) {
	allowLoopbackProviderTest(t)
	entered, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		fmt.Fprint(w, `{"code":"success","data":{"task_id":"original","status":"FAILURE","usage_state":"failed"}}`)
	}))
	defer server.Close()
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	input, _ := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: server.URL, APIKey: "fake", InterfaceType: "newapi"}})
	conclusion := "no_result"
	task := model.Task{ID: "late-route", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "original", RouteRun: 2, RouteID: "route-a", RecoveryOutcome: &conclusion, InputJSON: string(input)}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: server.URL})
	done := make(chan error, 1)
	go func() { _, err := svc.QueryFailedVideoTask(ctx, task.UserID, task.ID); done <- err }()
	<-entered
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("route_id", "route-b").Error; err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	<-done
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.BillingEvidence != nil {
		t.Fatalf("late old-route response persisted: %+v", stored.BillingEvidence)
	}
}
