package generation

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

func loadOfficialProtocolAdapterForTest(t *testing.T, packageFile, providerID string) protocol.Adapter {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", packageFile))
	if err != nil {
		t.Fatalf("read %s: %v", packageFile, err)
	}
	pkg, err := protocol.ParsePluginPackage(data)
	if err != nil {
		t.Fatalf("parse %s: %v", packageFile, err)
	}
	adapters, err := protocol.LoadInstalledProviders(pkg.ManifestRaw)
	if err != nil {
		t.Fatalf("load %s: %v", packageFile, err)
	}
	for _, adapter := range adapters {
		if adapter.Metadata().ID == providerID {
			return adapter
		}
	}
	t.Fatalf("provider %s not found in %s", providerID, packageFile)
	return nil
}

// DashScope tasks return task_status=UNKNOWN when a task does not exist, expired,
// or was queried against a different region/workspace. Treating UNKNOWN as pending
// causes image generation to poll until context.DeadlineExceeded ("图片生成等待超时").
func TestDashscopeQwenImageUnknownTaskStatusFailsFastInsteadOfTimingOut(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	adapter := loadOfficialProtocolAdapterForTest(t, "dashscope-qwen-image.beeftv-plugin", "dashscope-qwen-image")

	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/services/aigc/image-generation/generation":
			fmt.Fprint(w, `{"output":{"task_id":"task-qwen-21","task_status":"PENDING"},"request_id":"req-create"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/tasks/task-qwen-21":
			polls++
			fmt.Fprint(w, `{"output":{"task_id":"task-qwen-21","task_status":"UNKNOWN"},"request_id":"req-poll"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	policy := DeclarativeProtocolPollPolicy("image")
	policy.Interval = 5 * time.Millisecond
	policy.Sleep = func(ctx context.Context, _ time.Duration) error { return ctx.Err() }

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	_, err := RunProtocolAdapterTaskWithPolicy(ctx, Input{
		Mode:   "image",
		Prompt: "a red circle",
		Config: Config{
			BaseURL:       server.URL + "/compatible-mode/v1",
			APIKey:        "test-key",
			Model:         "qwen-image-2.1-pro",
			InterfaceType: "dashscope-qwen-image",
		},
	}, adapter, policy)
	if err == nil {
		t.Fatal("expected failure when DashScope reports task_status=UNKNOWN")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("UNKNOWN status spun until context.DeadlineExceeded (polls=%d): %v", polls, err)
	}
	if polls != 1 {
		t.Fatalf("polls = %d, want 1 fast failure on UNKNOWN status", polls)
	}
}

// A DashScope envelope carrying only request_id (no task_id and no images) must not
// treat request_id as a pollable task_id and spin against /api/v1/tasks/{request_id}.
func TestDashscopeCreateWithoutTaskIDDoesNotPollRequestID(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	adapter := loadOfficialProtocolAdapterForTest(t, "dashscope-qwen-image.beeftv-plugin", "dashscope-qwen-image")

	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			fmt.Fprint(w, `{"output":{"choices":[]},"request_id":"trace-only-req-id"}`)
			return
		}
		polls++
		fmt.Fprint(w, `{"output":{"task_id":"trace-only-req-id","task_status":"UNKNOWN"},"request_id":"req-poll"}`)
	}))
	defer server.Close()

	policy := DeclarativeProtocolPollPolicy("image")
	policy.Interval = 5 * time.Millisecond
	policy.Sleep = func(ctx context.Context, _ time.Duration) error { return ctx.Err() }

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	_, err := RunProtocolAdapterTaskWithPolicy(ctx, Input{
		Mode:   "image",
		Prompt: "a red circle",
		Config: Config{
			BaseURL:       server.URL + "/compatible-mode/v1",
			APIKey:        "test-key",
			Model:         "qwen-image-2.1-pro",
			InterfaceType: "dashscope-qwen-image",
		},
	}, adapter, policy)
	if err == nil {
		t.Fatal("expected error when DashScope create response lacks both images and task_id")
	}
	if polls != 0 {
		t.Fatalf("polled %d times using DashScope tracing request_id instead of failing create", polls)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unexpected timeout: %v", err)
	}
}
