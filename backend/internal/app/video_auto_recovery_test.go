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

func TestAutomaticVideoRecoveryPersistsTerminalAndPermanentConclusions(t *testing.T) {
	cases := []struct {
		name          string
		response      func(http.ResponseWriter)
		interfaceType string
		wantOutcome   string
		wantGets      int32
	}{
		{
			name: "provider terminal failure",
			response: func(w http.ResponseWriter) {
				_ = json.NewEncoder(w).Encode(map[string]any{"id": "original", "status": "failed"})
			},
			interfaceType: "beefapi", wantOutcome: "no_result", wantGets: 1,
		},
		{
			name: "query rejected",
			response: func(w http.ResponseWriter) {
				w.WriteHeader(http.StatusUnauthorized)
			},
			interfaceType: "unsupported", wantOutcome: "unrecoverable", wantGets: 0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			allowLoopbackProviderTest(t)
			var gets atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					gets.Add(1)
				}
				tc.response(w)
			}))
			defer provider.Close()

			svc, db := openDBRuntimeMatrix(t, t.TempDir())
			defer closeDBRuntimeMatrix(t, svc, db)
			inputJSON, err := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{
				BaseURL: provider.URL, APIKey: "provider-fixture", APIFormat: "openai", InterfaceType: tc.interfaceType, Model: "video-model",
			}})
			if err != nil {
				t.Fatal(err)
			}
			now := time.Now()
			task := model.Task{ID: "auto-video-" + tc.name, UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed,
				ProviderRequestID: "original", InputJSON: string(inputJSON), StartedAt: &now, CreatedAt: now, UpdatedAt: now}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}

			ctx := context.Background()
			if tc.interfaceType == "beefapi" {
				ctx = generation.WithEndpoints(ctx, generation.Endpoints{BeefAPIVideoBaseURL: provider.URL})
			}
			if err := svc.recoverFailedVideos(ctx, 1); err != nil {
				t.Fatal(err)
			}
			stored, err := svc.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if gets.Load() != tc.wantGets {
				t.Fatalf("GET=%d want %d", gets.Load(), tc.wantGets)
			}
			if stored.RecoveryOutcome == nil || *stored.RecoveryOutcome != tc.wantOutcome || stored.NextPollAt != nil {
				t.Fatalf("automatic conclusion = %+v", stored)
			}
		})
	}
}

func TestAutomaticVideoRecoveryKeepsTransientQueryFailurePending(t *testing.T) {
	allowLoopbackProviderTest(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
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
	task := model.Task{ID: "auto-video-transient", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed,
		ProviderRequestID: "original", InputJSON: string(inputJSON), StartedAt: &now, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: provider.URL})
	if err := svc.recoverFailedVideos(ctx, 1); err == nil {
		t.Fatal("transient query failure was hidden")
	}
	stored, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.RecoveryOutcome != nil || stored.NextPollAt == nil {
		t.Fatalf("transient query failure became terminal: %+v", stored)
	}
}

func TestFailedVideoRecoveryWindowExcludesOldTasks(t *testing.T) {
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	now := time.Now()
	recent := model.Task{ID: "recent-video", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "recent-provider", CreatedAt: now, UpdatedAt: now}
	old := model.Task{ID: "old-video", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "old-provider", CreatedAt: now.Add(-25 * time.Hour), UpdatedAt: now.Add(-25 * time.Hour)}
	if err := db.Create(&recent).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&old).Error; err != nil {
		t.Fatal(err)
	}
	got, err := svc.repo.FailedVideoTasksForRecovery("", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != recent.ID {
		t.Fatalf("recovery window = %+v", got)
	}
}

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
