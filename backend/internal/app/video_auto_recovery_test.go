package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func TestRecoverFailedVideosQueriesOriginalTaskWithoutPost(t *testing.T) {
	allowLoopbackProviderTest(t)
	var gets, posts atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		gets.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "original", "status": "processing"})
	}))
	defer provider.Close()

	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	inputJSON, err := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{
		BaseURL: provider.URL, APIKey: "provider-fixture", APIFormat: "openai", InterfaceType: "beefapi", Model: "video-model",
	}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := model.Task{ID: "auto-video-recovery", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed,
		ProviderRequestID: "original", InputJSON: string(inputJSON), StartedAt: &now, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}

	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: provider.URL})
	if err := svc.recoverFailedVideos(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if gets.Load() != 1 || posts.Load() != 0 {
		t.Fatalf("provider methods: GET=%d POST=%d", gets.Load(), posts.Load())
	}
	stored, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.TaskStatusFailed || stored.NextPollAt == nil || stored.PollStage != "processing" {
		t.Fatalf("automatic query state = %+v", stored)
	}
}
