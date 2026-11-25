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

func TestExtractProviderTaskIDTopLevelTaskIDAndDashScopeOutputPrecedence(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantID  string
		wantErr bool
	}{
		{
			name:   "top-level task_id wins even when output.id is non-string",
			body:   `{"task_id":"job-1","output":{"id":123}}`,
			wantID: "job-1",
		},
		{
			name:   "top-level task_id wins over output.id string",
			body:   `{"task_id":"job-1","output":{"id":"other"}}`,
			wantID: "job-1",
		},
		{
			name:   "dashscope output extracts explicit output.task_id over request_id",
			body:   `{"output":{"task_id":"dash-job-2","task_status":"PENDING"},"request_id":"req-trace-2"}`,
			wantID: "dash-job-2",
		},
		{
			name:   "dashscope output never extracts generic output.id or tracing request_id",
			body:   `{"output":{"id":"sub-item-1","choices":[]},"request_id":"req-trace-3"}`,
			wantID: "",
		},
		{
			name:   "dashscope output ignores non-string output.id without error",
			body:   `{"output":{"id":123,"choices":[]},"request_id":"req-trace-4"}`,
			wantID: "",
		},
		{
			name:   "top-level id still works alongside dashscope output when task_id absent",
			body:   `{"id":"top-job-5","output":{"choices":[]},"request_id":"req-trace-5"}`,
			wantID: "top-job-5",
		},
		{
			name:   "non-dashscope response still supports request_id fallback",
			body:   `{"request_id":"xai-job-6"}`,
			wantID: "xai-job-6",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ExtractProviderTaskID([]byte(tc.body))
			if (err != nil) != tc.wantErr {
				t.Fatalf("ExtractProviderTaskID(%s) err = %v, wantErr=%v", tc.body, err, tc.wantErr)
			}
			if got != tc.wantID {
				t.Fatalf("ExtractProviderTaskID(%s) = %q, want %q", tc.body, got, tc.wantID)
			}
		})
	}
}
