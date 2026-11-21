package generation

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

func TestRunVideoDownloadEOFRetryUsesFreshConnectionViaOpenResponse(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := bytes.Repeat([]byte("mp4-frame-"), 128)
	var attempts atomic.Int32
	var mu sync.Mutex
	var addrs []string
	var closeHeaders []string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/warmup" {
			_, _ = w.Write([]byte(r.RemoteAddr))
			return
		}
		attempt := attempts.Add(1)
		mu.Lock()
		addrs = append(addrs, r.RemoteAddr)
		closeHeaders = append(closeHeaders, r.Header.Get("Connection"))
		mu.Unlock()
		if attempt == 1 {
			if hijacker, ok := w.(http.Hijacker); ok {
				if conn, _, err := hijacker.Hijack(); err == nil {
					_ = conn.Close()
					return
				}
			}
			panic(http.ErrAbortHandler)
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("ETag", `"vid-1"`)
		_, _ = w.Write(payload)
	}))
	defer server.Close()

	var idlePoolAddr string
	var retryReused atomic.Bool
	var gotConnCalls atomic.Int32
	traceCtx := httptrace.WithClientTrace(context.Background(), &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			if gotConnCalls.Add(1) == 2 {
				retryReused.Store(info.Reused)
			}
		},
	})

	policy := fastPolicy(3, func(context.Context, time.Duration) error {
		resp, err := outbound.OutboundHTTPClient(0).Get(server.URL + "/warmup")
		if err != nil {
			t.Fatalf("warmup failed: %v", err)
		}
		raw, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		idlePoolAddr = strings.TrimSpace(string(raw))
		return nil
	})

	data, mimeType, err := RunVideoDownload(traceCtx, "video-eof-1", policy, videoResultDownloader(Config{BaseURL: server.URL}, server.URL+"/result.mp4", "video-eof-1"))
	if err != nil {
		t.Fatalf("RunVideoDownload() error = %v", err)
	}
	if mimeType != "video/mp4" || !bytes.Equal(data, payload) {
		t.Fatalf("unexpected result: mime=%q len=%d", mimeType, len(data))
	}
	if idlePoolAddr == "" {
		t.Fatal("expected sleep hook to warm idle keep-alive connection before retry")
	}
	if retryReused.Load() {
		t.Fatal("RunVideoDownload EOF retry reused pooled keep-alive connection")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(addrs) != 2 || addrs[1] == addrs[0] || addrs[1] == idlePoolAddr {
		t.Fatalf("RunVideoDownload EOF retry did not dial fresh connection: addrs=%v idle=%q", addrs, idlePoolAddr)
	}
	if !strings.EqualFold(closeHeaders[1], "close") {
		t.Fatalf("retry Connection header = %q, want close", closeHeaders[1])
	}
}

func TestRunVideoDownloadEOFFailureClassifiesAsDownloadFailed(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if hijacker, ok := w.(http.Hijacker); ok {
			if conn, _, err := hijacker.Hijack(); err == nil {
				_ = conn.Close()
				return
			}
		}
		panic(http.ErrAbortHandler)
	}))
	defer server.Close()

	_, _, err := RunVideoDownload(
		context.Background(),
		"video-eof-fail",
		fastPolicy(1, SleepContext),
		videoResultDownloader(Config{BaseURL: server.URL}, server.URL+"/result.mp4?signature=secret-token", "video-eof-fail"),
	)
	if err == nil {
		t.Fatal("expected EOF error, got nil")
	}
	if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) && !outbound.IsConnectionDrop(err) {
		t.Fatalf("expected connection drop error, got %v", err)
	}
	if strings.Contains(err.Error(), "secret-token") {
		t.Fatalf("error leaked signed URL: %q", err.Error())
	}
	if !isDownloadText(outbound.ResumableConnectionDropMessage) {
		t.Fatalf("ResumableConnectionDropMessage must match isDownloadText: %q", outbound.ResumableConnectionDropMessage)
	}
	classified := ClassifyError(err)
	if classified.Category != CategoryDownloadFailed {
		t.Fatalf("ClassifyError().Category = %q, want %q (err=%v)", classified.Category, CategoryDownloadFailed, err)
	}
}
