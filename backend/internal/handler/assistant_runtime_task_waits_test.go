package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestAssistantRuntimeTaskWaitsRouteAuthAndSignalDispatch(t *testing.T) {
	type signalRequest struct {
		CanvasID      string         `json:"canvasId"`
		SessionID     string         `json:"sessionId"`
		DurableTaskID int64          `json:"durableTaskId"`
		Signal        string         `json:"signal"`
		Key           string         `json:"key"`
		Value         map[string]any `json:"value"`
	}

	var mu sync.Mutex
	var signals []signalRequest

	env := newAssistantTestEnv(t, func(_ *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/signals" && r.Method == http.MethodPost {
				var sig signalRequest
				if err := json.NewDecoder(r.Body).Decode(&sig); err != nil {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				mu.Lock()
				signals = append(signals, sig)
				mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"ok":true}`))
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
		})
	})
	env.assistantHost.TaskWaits().SetPollInterval(15 * time.Millisecond)

	postRuntime := func(path, body string, withHostToken bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:18090"+path, strings.NewReader(body))
		req.Host = "127.0.0.1:18090"
		req.RemoteAddr = "127.0.0.1:54321"
		req.Header.Set("Content-Type", "application/json")
		if withHostToken {
			req.Header.Set("X-Beeftv-Agent-Token", assistantTestHostToken)
		}
		rec := httptest.NewRecorder()
		env.router.ServeHTTP(rec, req)
		return rec
	}

	// 1. Unauthorized caller (no host token) must be rejected with 403.
	unauthed := postRuntime("/api/assistant/runtime/task-waits",
		`{"canvasId":"assistant-canvas","sessionId":"durable:s1","durableTaskId":42,"signal":"business_task_settled","taskIds":["task-live-1"]}`,
		false)
	if unauthed.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without host token, got %d: %s", unauthed.Code, unauthed.Body.String())
	}

	// 2. Seed a real running task in SQLite for the local workspace owner.
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	taskRow := model.Task{
		ID:        "task-live-1",
		UserID:    owner.ID,
		ProjectID: env.canvasID,
		Type:      "canvas_text",
		Status:    model.TaskStatusRunning,
		InputJSON: `{"mode":"text"}`,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := env.service.Database().Create(&taskRow).Error; err != nil {
		t.Fatalf("create task row: %v", err)
	}

	// 3. Register task wait as authenticated agent-host.
	regRec := postRuntime("/api/assistant/runtime/task-waits",
		`{"canvasId":"assistant-canvas","sessionId":"durable:s1","durableTaskId":42,"signal":"business_task_settled","taskIds":["task-live-1"]}`,
		true)
	if regRec.Code != http.StatusOK {
		t.Fatalf("expected 200 registering task wait, got %d: %s", regRec.Code, regRec.Body.String())
	}

	// While task is still running, no signal should fire.
	time.Sleep(45 * time.Millisecond)
	mu.Lock()
	if len(signals) != 0 {
		t.Fatalf("expected 0 signals while running, got %d", len(signals))
	}
	mu.Unlock()

	// 4. Transition task to succeeded in SQLite -> Go dispatches POST /signals.
	if err := env.service.Database().Model(&model.Task{}).Where("id = ?", "task-live-1").Updates(map[string]any{
		"status":      model.TaskStatusSucceeded,
		"result_json": `{"text":"finished"}`,
		"updated_at":  time.Now().UTC(),
	}).Error; err != nil {
		t.Fatalf("update task to succeeded: %v", err)
	}
	env.assistantHost.NotifyTaskChanged("task-live-1")

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(signals)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(signals) != 1 {
		t.Fatalf("expected 1 signal delivered after task settled, got %d", len(signals))
	}
	sig := signals[0]
	if sig.CanvasID != "assistant-canvas" || sig.SessionID != "durable:s1" || sig.DurableTaskID != 42 || sig.Signal != "business_task_settled" || sig.Key != "task-live-1" {
		t.Fatalf("unexpected signal envelope: %+v", sig)
	}
	if sig.Value["state"] != "completed" || sig.Value["status"] != "succeeded" {
		t.Fatalf("unexpected signal value: %+v", sig.Value)
	}

	// 5. Cancel endpoint removes an active wait subscription so no signal is dispatched.
	taskRow2 := model.Task{
		ID:        "task-live-2",
		UserID:    owner.ID,
		ProjectID: env.canvasID,
		Type:      "canvas_image",
		Status:    model.TaskStatusRunning,
		InputJSON: `{"mode":"image"}`,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := env.service.Database().Create(&taskRow2).Error; err != nil {
		t.Fatal(err)
	}
	regRec2 := postRuntime("/api/assistant/runtime/task-waits",
		`{"canvasId":"assistant-canvas","sessionId":"durable:s1","durableTaskId":43,"signal":"business_task_settled","taskIds":["task-live-2"]}`,
		true)
	if regRec2.Code != http.StatusOK {
		t.Fatalf("expected 200 registering second wait, got %d", regRec2.Code)
	}
	cancelRec := postRuntime("/api/assistant/runtime/task-waits/cancel",
		`{"canvasId":"assistant-canvas","sessionId":"durable:s1","durableTaskId":43,"taskIds":["task-live-2"]}`,
		true)
	if cancelRec.Code != http.StatusOK {
		t.Fatalf("expected 200 cancelling wait, got %d: %s", cancelRec.Code, cancelRec.Body.String())
	}
	if len(env.assistantHost.TaskWaits().List()) != 0 {
		t.Fatalf("expected 0 remaining waits after cancel, got %+v", env.assistantHost.TaskWaits().List())
	}
}
