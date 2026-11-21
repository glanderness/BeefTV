package outbound

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func warmOutboundKeepAlivePool(t *testing.T, url string) string {
	t.Helper()
	resp, err := OutboundHTTPClient(0).Get(url)
	if err != nil {
		t.Fatalf("warmup GET(%s) failed: %v", url, err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatalf("warmup read failed: %v", err)
	}
	return strings.TrimSpace(string(body))
}

func TestDownloadResumableEOFRetryBypassesIdlePoolAndUsesFreshConnection(t *testing.T) {
	allowLoopback(t)
	payload := bytes.Repeat([]byte("video-frame-"), 128)
	var downloadAttempts atomic.Int32
	var mu sync.Mutex
	var downloadAddrs []string
	var closeHeaders []string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/warmup" {
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte(r.RemoteAddr))
			return
		}
		attempt := downloadAttempts.Add(1)
		mu.Lock()
		downloadAddrs = append(downloadAddrs, r.RemoteAddr)
		closeHeaders = append(closeHeaders, r.Header.Get("Connection"))
		mu.Unlock()
		if attempt == 1 {
			// 先写出响应头和部分字节再断开连接，模拟真实大文件下载中途 EOF（不会被 net/http 的空闲重试吞掉）。
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("ETag", `"v1"`)
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
			_, _ = w.Write(payload[:64])
			w.(http.Flusher).Flush()
			if hijacker, ok := w.(http.Hijacker); ok {
				if conn, _, err := hijacker.Hijack(); err == nil {
					_ = conn.Close()
					return
				}
			}
			panic(http.ErrAbortHandler)
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("ETag", `"v1"`)
		w.Header().Set("Accept-Ranges", "bytes")
		if r.Header.Get("Range") == "bytes=64-" {
			w.Header().Set("Content-Range", "bytes 64-"+strconv.Itoa(len(payload)-1)+"/"+strconv.Itoa(len(payload)))
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write(payload[64:])
			return
		}
		_, _ = w.Write(payload)
	}))
	defer server.Close()

	// 先预热一条存活的 keep-alive 连接进入共享池，第 1 次下载会复用它并被远端断开。
	warmedFirst := warmOutboundKeepAlivePool(t, server.URL+"/warmup")
	var warmedBeforeRetry string
	var retryReused atomic.Bool
	var gotConnCalls atomic.Int32

	traceCtx := httptrace.WithClientTrace(context.Background(), &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			if gotConnCalls.Add(1) == 2 {
				retryReused.Store(info.Reused)
			}
		},
	})

	result, err := DownloadResumable(traceCtx, server.URL+"/result.mp4", ResumableOptions{
		PartialPath: filepath.Join(t.TempDir(), "video.part"),
		MaxBytes:    1 << 20,
		Attempts:    3,
		OnProgress: func(update ResumableProgress) {
			if update.State == "retrying" && warmedBeforeRetry == "" {
				// 在第 2 次重试发出前，再往共享连接池放一条存活的 idle keep-alive 连接；
				// 只有真正切换到 DisableKeepAlives 的 fresh transport，第 2 次才会避开这条池化连接。
				warmedBeforeRetry = warmOutboundKeepAlivePool(t, server.URL+"/warmup")
			}
		},
	})
	if err != nil {
		t.Fatalf("DownloadResumable() error = %v", err)
	}
	if !bytes.Equal(result.Data, payload) {
		t.Fatalf("downloaded bytes mismatch: got %d want %d", len(result.Data), len(payload))
	}
	if warmedBeforeRetry == "" {
		t.Fatal("expected retrying callback to warm an idle pooled connection")
	}
	if retryReused.Load() {
		t.Fatal("EOF retry unexpectedly reused a pooled keep-alive connection")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(downloadAddrs) != 2 {
		t.Fatalf("attempts = %d, want 2", len(downloadAddrs))
	}
	if downloadAddrs[0] != warmedFirst {
		t.Fatalf("attempt 1 addr = %q, want warmed pooled conn %q", downloadAddrs[0], warmedFirst)
	}
	if downloadAddrs[1] == downloadAddrs[0] || downloadAddrs[1] == warmedBeforeRetry {
		t.Fatalf("EOF retry reused an existing connection: attempt2=%q attempt1=%q idlePool=%q", downloadAddrs[1], downloadAddrs[0], warmedBeforeRetry)
	}
	if !strings.EqualFold(closeHeaders[1], "close") {
		t.Fatalf("retry Connection header = %q, want close", closeHeaders[1])
	}
}

func TestDownloadResumableOpenResponseInheritsFreshConnectionOnEOFRetry(t *testing.T) {
	allowLoopback(t)
	payload := []byte("open-response-video-bytes")
	var attempts atomic.Int32
	var mu sync.Mutex
	var downloadAddrs []string
	var closeHeaders []string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/warmup" {
			_, _ = w.Write([]byte(r.RemoteAddr))
			return
		}
		attempt := attempts.Add(1)
		mu.Lock()
		downloadAddrs = append(downloadAddrs, r.RemoteAddr)
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

	result, err := DownloadResumable(traceCtx, server.URL+"/video.mp4", ResumableOptions{
		PartialPath: filepath.Join(t.TempDir(), "open-response.part"),
		MaxBytes:    1 << 20,
		Attempts:    2,
		OpenResponse: func(req *http.Request) (*http.Response, error) {
			return OutboundHTTPClient(0).Do(req)
		},
		OnProgress: func(update ResumableProgress) {
			if update.State == "retrying" && idlePoolAddr == "" {
				idlePoolAddr = warmOutboundKeepAlivePool(t, server.URL+"/warmup")
			}
		},
	})
	if err != nil {
		t.Fatalf("DownloadResumable(OpenResponse) error = %v", err)
	}
	if !bytes.Equal(result.Data, payload) {
		t.Fatalf("data mismatch: got %q", result.Data)
	}
	if retryReused.Load() {
		t.Fatal("OpenResponse EOF retry reused pooled keep-alive connection")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(downloadAddrs) != 2 || downloadAddrs[1] == idlePoolAddr || !strings.EqualFold(closeHeaders[1], "close") {
		t.Fatalf("unexpected OpenResponse retry connection behavior: addrs=%v idle=%q close=%v", downloadAddrs, idlePoolAddr, closeHeaders)
	}
}

func TestDownloadResumableEOFReportsDisconnectMessageWithoutLeakingURL(t *testing.T) {
	allowLoopback(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hijacker, ok := w.(http.Hijacker); ok {
			if conn, _, err := hijacker.Hijack(); err == nil {
				_ = conn.Close()
				return
			}
		}
		panic(http.ErrAbortHandler)
	}))
	defer server.Close()

	_, err := DownloadResumable(context.Background(), server.URL+"/video.mp4?signature=secret-token", ResumableOptions{
		PartialPath: filepath.Join(t.TempDir(), "video.part"),
		MaxBytes:    1 << 20,
		Attempts:    1,
	})
	if err == nil {
		t.Fatal("expected EOF error, got nil")
	}
	if !IsConnectionDrop(err) {
		t.Fatalf("expected wrapped EOF/disconnect error, got %v", err)
	}
	if !strings.Contains(err.Error(), ResumableConnectionDropMessage) {
		t.Fatalf("error missing clear disconnect hint: %q", err.Error())
	}
	if strings.Contains(err.Error(), "secret-token") || strings.Contains(err.Error(), server.URL) {
		t.Fatalf("error leaked signed URL: %q", err.Error())
	}
}

func TestDownloadResumableTruncatedBodyReportsDisconnectMessage(t *testing.T) {
	allowLoopback(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write([]byte("partial-data"))
		w.(http.Flusher).Flush()
		if hijacker, ok := w.(http.Hijacker); ok {
			if conn, _, err := hijacker.Hijack(); err == nil {
				_ = conn.Close()
			}
		}
	}))
	defer server.Close()

	_, err := DownloadResumable(context.Background(), server.URL+"/video.mp4?signature=secret-token", ResumableOptions{
		PartialPath: filepath.Join(t.TempDir(), "video.part"),
		MaxBytes:    1 << 20,
		Attempts:    1,
	})
	if err == nil {
		t.Fatal("expected truncated body error, got nil")
	}
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("expected io.ErrUnexpectedEOF, got %v", err)
	}
	if !strings.Contains(err.Error(), ResumableConnectionDropMessage) {
		t.Fatalf("error missing clear disconnect hint: %q", err.Error())
	}
	if strings.Contains(err.Error(), "secret-token") {
		t.Fatalf("error leaked signed URL: %q", err.Error())
	}
}
