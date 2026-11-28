package generation

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func withStreamReadIdleTimeout(ctx context.Context, timeout time.Duration) context.Context {
	return context.WithValue(ctx, streamReadIdleTimeoutContext{}, timeout)
}

func TestDoBinaryWithConsumerStreamIdleTimeoutRaceFree(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	release := make(chan struct{})
	defer close(release)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"))
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()

	ctx := withStreamReadIdleTimeout(context.Background(), 100*time.Millisecond)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/chat/completions", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	var chunks atomic.Int32
	start := time.Now()
	_, _, err = DoBinaryWithConsumer(req, func(_ string, chunk []byte) {
		if len(chunk) > 0 {
			chunks.Add(1)
		}
	})
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected upstream_stream_idle_timeout error, got nil")
	}
	if !strings.Contains(err.Error(), "upstream_stream_idle_timeout") || !errors.Is(err, errUpstreamReadIdle) {
		t.Fatalf("unexpected error: %v", err)
	}
	if errors.Is(err, context.Canceled) {
		t.Fatalf("idle timeout error must not wrap context.Canceled: %v", err)
	}
	if failure := ClassifyError(err); failure.Category != CategoryTimeout {
		t.Fatalf("ClassifyError(idleTimeout) = %+v, want CategoryTimeout", failure)
	}
	if chunks.Load() < 1 {
		t.Fatalf("expected at least 1 chunk before idle timeout, got %d", chunks.Load())
	}
	if elapsed > 2*time.Second {
		t.Fatalf("idle timeout took too long: %s", elapsed)
	}
}

func TestDoBinaryWithConsumerStreamResetsIdleTimeoutOnEachChunk(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for i := 0; i < 4; i++ {
			time.Sleep(40 * time.Millisecond)
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"chunk-%d\"}}]}\n\n", i)
			if flusher != nil {
				flusher.Flush()
			}
		}
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
	}))
	defer server.Close()

	// Total duration (~160ms) exceeds the 100ms per-chunk idle timeout, so
	// every chunk must reset the idle timer.
	ctx := withStreamReadIdleTimeout(context.Background(), 100*time.Millisecond)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/chat/completions", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	data, _, err := DoBinaryWithConsumer(req, func(string, []byte) {})
	if err != nil {
		t.Fatalf("healthy chunked stream should not time out: %v", err)
	}
	if !strings.Contains(string(data), "chunk-3") {
		t.Fatalf("missing final chunk in body: %q", string(data))
	}
}

func TestDoBinaryNonStreamingSlowHeaderUnaffectedByStreamIdleTimeout(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(150 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[{"url":"https://example.com/ok.png"}]}`))
	}))
	defer server.Close()

	ctx := withStreamReadIdleTimeout(context.Background(), 50*time.Millisecond)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/images/generations", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	data, _, err := DoBinary(req)
	if err != nil {
		t.Fatalf("non-streaming slow header must not hit stream idle timeout: %v", err)
	}
	if !strings.Contains(string(data), "ok.png") {
		t.Fatalf("unexpected body: %q", string(data))
	}
}

func TestTextProvidersRejectWhitespaceOnlyOutput(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	t.Run("non-streaming", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"\n   \t\n"}}]}`))
		}))
		defer server.Close()

		cfg := Config{BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "test-text"}
		_, err := RequestTextProvider(context.Background(), cfg, ChatCompletionsPath, map[string]any{"model": "test-text"}, "chat-completion", false, nil)
		if err == nil || !strings.Contains(err.Error(), "没有返回内容") {
			t.Fatalf("expected empty content error for whitespace-only output, got %v", err)
		}
	})

	t.Run("streaming", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"\\n\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"  \"}}]}\n\ndata: [DONE]\n\n"))
		}))
		defer server.Close()

		cfg := Config{BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "test-text"}
		_, err := PostStreamingTextResult(context.Background(), cfg, ChatCompletionsPath, map[string]any{"model": "test-text"}, "chat-completion", nil)
		if err == nil || !strings.Contains(err.Error(), "没有返回内容") {
			t.Fatalf("expected empty content error for whitespace-only stream, got %v", err)
		}
	})
}
