package assistantruntime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type capturedSignal struct {
	CanvasID      string         `json:"canvasId"`
	SessionID     string         `json:"sessionId"`
	DurableTaskID int64          `json:"durableTaskId"`
	Signal        string         `json:"signal"`
	Key           string         `json:"key"`
	Value         map[string]any `json:"value"`
}

func waitForCondition(t *testing.T, timeout time.Duration, check func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal(msg)
}

func TestTaskWaitRegistryPersistsAndDispatchesSignalOnSettleAndCancel(t *testing.T) {
	dataDir := t.TempDir()
	const hostToken = "test-host-token"
	const nonce = "test-nonce-1"

	var receivedMu sync.Mutex
	var received []capturedSignal
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/signals" || r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("X-Beeftv-Agent-Token") != hostToken || r.Header.Get(InstanceHeader) != nonce {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		var sig capturedSignal
		if err := json.NewDecoder(r.Body).Decode(&sig); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		receivedMu.Lock()
		received = append(received, sig)
		receivedMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	// Phase 1: Register on Host 1, verify persisted file exists, then stop Host 1.
	host1 := New(Options{
		DataDir:   dataDir,
		HostToken: func() string { return hostToken },
	})
	if err := host1.TaskWaits().Register(TaskWaitSubscription{
		UserID:        "user-1",
		CanvasID:      "canvas-1",
		SessionID:     "durable:sess-1",
		DurableTaskID: 77,
		Signal:        "business_task_settled",
		TaskIDs:       []string{"task-1", "task-2"},
	}); err != nil {
		t.Fatalf("register wait: %v", err)
	}
	// Duplicate registration is idempotent.
	if err := host1.TaskWaits().Register(TaskWaitSubscription{
		UserID:        "user-1",
		CanvasID:      "canvas-1",
		SessionID:     "durable:sess-1",
		DurableTaskID: 77,
		Signal:        "business_task_settled",
		TaskIDs:       []string{"task-1", "task-2"},
	}); err != nil {
		t.Fatalf("idempotent re-register: %v", err)
	}
	if len(host1.TaskWaits().List()) != 1 {
		t.Fatalf("expected 1 deduplicated subscription, got %d", len(host1.TaskWaits().List()))
	}
	if _, err := os.Stat(filepath.Join(dataDir, taskWaitsFileName)); err != nil {
		t.Fatalf("expected persisted task waits file: %v", err)
	}
	if err := host1.StopContext(context.Background()); err != nil {
		t.Fatalf("stop host1: %v", err)
	}

	// Phase 2: Reopen Host 2 on the same DataDir (simulating Go restart).
	host2 := New(Options{
		DataDir:   dataDir,
		HostToken: func() string { return hostToken },
	})
	defer func() { _ = host2.StopContext(context.Background()) }()
	host2.TaskWaits().SetPollInterval(15 * time.Millisecond)

	if subs := host2.TaskWaits().List(); len(subs) != 1 || subs[0].DurableTaskID != 77 {
		t.Fatalf("expected persisted subscription to reload across restart, got %+v", subs)
	}

	var statesMu sync.Mutex
	states := map[string]TaskWaitEvaluation{
		"task-1": {Settled: false},
		"task-2": {Settled: false},
	}
	host2.ConfigureTaskWaitEvaluator(func(_ context.Context, _ string, taskID string) (TaskWaitEvaluation, error) {
		statesMu.Lock()
		defer statesMu.Unlock()
		return states[taskID], nil
	})
	host2.TestingUseOwnedEndpoint(server.URL, nonce, "fp-1")

	time.Sleep(40 * time.Millisecond)
	receivedMu.Lock()
	initialCount := len(received)
	receivedMu.Unlock()
	if initialCount != 0 {
		t.Fatalf("expected 0 signals while tasks are running, got %d", initialCount)
	}

	// Settle task-1 -> immediate wakeup via NotifyTaskChanged.
	statesMu.Lock()
	states["task-1"] = TaskWaitEvaluation{
		Settled: true,
		Payload: map[string]any{"taskId": "task-1", "status": "succeeded", "state": "completed", "reason": "saved"},
	}
	statesMu.Unlock()
	host2.NotifyTaskChanged("task-1")

	waitForCondition(t, 2*time.Second, func() bool {
		receivedMu.Lock()
		defer receivedMu.Unlock()
		return len(received) == 1
	}, "expected signal for task-1")

	receivedMu.Lock()
	first := received[0]
	receivedMu.Unlock()
	if first.CanvasID != "canvas-1" || first.SessionID != "durable:sess-1" || first.DurableTaskID != 77 || first.Key != "task-1" || first.Value["state"] != "completed" {
		t.Fatalf("unexpected first signal payload: %+v", first)
	}
	if len(host2.TaskWaits().List()) != 1 {
		t.Fatalf("subscription should remain active until task-2 settles")
	}

	// Cancel task-2 -> signal delivered and subscription cleaned up from memory & disk.
	statesMu.Lock()
	states["task-2"] = TaskWaitEvaluation{
		Settled: true,
		Payload: map[string]any{"taskId": "task-2", "status": "cancelled", "state": "failed", "reason": "cancelled"},
	}
	statesMu.Unlock()
	host2.NotifyTaskChanged("task-2")

	waitForCondition(t, 2*time.Second, func() bool {
		receivedMu.Lock()
		count := len(received)
		receivedMu.Unlock()
		return count == 2 && len(host2.TaskWaits().List()) == 0
	}, "expected second signal and subscription cleanup")

	receivedMu.Lock()
	second := received[1]
	receivedMu.Unlock()
	if second.Key != "task-2" || second.Value["reason"] != "cancelled" {
		t.Fatalf("unexpected second signal payload: %+v", second)
	}
	if _, err := os.Stat(filepath.Join(dataDir, taskWaitsFileName)); !os.IsNotExist(err) {
		t.Fatalf("expected persisted waits file to be removed when empty, err=%v", err)
	}
}

func TestTaskWaitRegistryRetriesOnTransient5xxAndDropsOn404(t *testing.T) {
	const hostToken = "retry-token"
	const nonce = "retry-nonce"

	var retryAttempts atomic.Int32
	var notFoundAttempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var sig capturedSignal
		if err := json.NewDecoder(r.Body).Decode(&sig); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if sig.Key == "task-retry" {
			if retryAttempts.Add(1) <= 2 {
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"error":"host_restarting"}`))
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		if sig.Key == "task-missing-target" {
			notFoundAttempts.Add(1)
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"signal_target_not_found"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	host := New(Options{
		DataDir:   t.TempDir(),
		HostToken: func() string { return hostToken },
	})
	defer func() { _ = host.StopContext(context.Background()) }()
	host.TaskWaits().SetPollInterval(15 * time.Millisecond)
	host.ConfigureTaskWaitEvaluator(func(_ context.Context, _ string, taskID string) (TaskWaitEvaluation, error) {
		return TaskWaitEvaluation{
			Settled: true,
			Payload: map[string]any{"taskId": taskID, "status": "succeeded", "state": "completed"},
		}, nil
	})
	host.TestingUseOwnedEndpoint(server.URL, nonce, "fp-retry")

	if err := host.TaskWaits().Register(TaskWaitSubscription{
		UserID:        "u1",
		CanvasID:      "c1",
		SessionID:     "durable:s1",
		DurableTaskID: 11,
		TaskIDs:       []string{"task-retry"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := host.TaskWaits().Register(TaskWaitSubscription{
		UserID:        "u1",
		CanvasID:      "c1",
		SessionID:     "durable:s1",
		DurableTaskID: 12,
		TaskIDs:       []string{"task-missing-target"},
	}); err != nil {
		t.Fatal(err)
	}

	waitForCondition(t, 2*time.Second, func() bool {
		return retryAttempts.Load() >= 3 && len(host.TaskWaits().List()) == 0
	}, "expected retry subscription to succeed after 503s and 404 target to be dropped")

	if got := notFoundAttempts.Load(); got != 1 {
		t.Fatalf("expected 404 target to be dropped after 1 attempt, got %d", got)
	}
}

func TestTaskWaitRegistryCancelStopsDelivery(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	host := New(Options{
		DataDir:   t.TempDir(),
		HostToken: func() string { return "tok" },
	})
	defer func() { _ = host.StopContext(context.Background()) }()
	host.TaskWaits().SetPollInterval(15 * time.Millisecond)

	var settled atomic.Bool
	host.ConfigureTaskWaitEvaluator(func(_ context.Context, _ string, taskID string) (TaskWaitEvaluation, error) {
		if !settled.Load() {
			return TaskWaitEvaluation{Settled: false}, nil
		}
		return TaskWaitEvaluation{Settled: true, Payload: map[string]any{"taskId": taskID}}, nil
	})
	host.TestingUseOwnedEndpoint(server.URL, "nonce", "fp-cancel")

	if err := host.TaskWaits().Register(TaskWaitSubscription{
		UserID:        "u1",
		CanvasID:      "c1",
		SessionID:     "durable:s1",
		DurableTaskID: 99,
		TaskIDs:       []string{"task-cancelled-wait"},
	}); err != nil {
		t.Fatal(err)
	}
	host.TaskWaits().Cancel("c1", "durable:s1", 99)
	if len(host.TaskWaits().List()) != 0 {
		t.Fatalf("expected subscription removed on Cancel")
	}

	settled.Store(true)
	host.NotifyTaskChanged("task-cancelled-wait")
	time.Sleep(50 * time.Millisecond)
	if hits.Load() != 0 {
		t.Fatalf("expected 0 signal deliveries after Cancel, got %d", hits.Load())
	}
}
