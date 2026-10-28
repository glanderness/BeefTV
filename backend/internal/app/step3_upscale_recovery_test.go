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

	"infinite-canvas/backend/internal/model"
)

func TestStep3AutomaticImageUpscaleUsesOriginalRecoveryPOST(t *testing.T) {
	allowLoopbackProviderTest(t)
	var recoveryPOSTs, queries, creates atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			if r.URL.Path == "/v1/media-upscale/tasks/original/recover" {
				recoveryPOSTs.Add(1)
			} else {
				creates.Add(1)
				w.WriteHeader(400)
				return
			}
		} else {
			queries.Add(1)
		}
		fmt.Fprint(w, `{"task_id":"original","status":"unknown","model":"topaz-standard-v2","media_type":"image"}`)
	}))
	defer server.Close()
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	input, _ := json.Marshal(canvasGenerationInput{Mode: "image", Config: providerConfig{BaseURL: server.URL, APIKey: "fake", Model: "topaz-standard-v2"}})
	task := model.Task{ID: "image-upscale", UserID: "local", Type: "canvas_image", Model: "topaz-standard-v2", Status: model.TaskStatusFailed, RouteRun: 2, ProviderRequestID: "original", InputJSON: string(input)}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	_, _ = svc.backgroundWorkers().Start()
	svc.startImageRecoveryPass(context.Background())
	deadline := time.Now().Add(time.Second)
	for svc.imageRecoveryActive.Load() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if recoveryPOSTs.Load() != 1 || queries.Load() != 1 || creates.Load() != 0 {
		t.Fatalf("query POST omitted or used create: recover=%d query=%d create=%d", recoveryPOSTs.Load(), queries.Load(), creates.Load())
	}
	current, err := svc.repo.Task(task.ID)
	if err != nil || current.RouteRun != 2 || current.Status != model.TaskStatusFailed {
		t.Fatalf("recovery requeued original: %+v err=%v", current, err)
	}
}
