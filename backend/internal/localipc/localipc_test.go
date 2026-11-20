package localipc

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testEndpoint(t *testing.T, label string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		return AgentHostEndpoint()
	}
	// macOS sun_path limit is 104 bytes; keep temp socket path compact.
	dir, err := filepath.EvalSymlinks("/tmp")
	if err != nil {
		dir = "/tmp"
	}
	return filepath.Join(dir, fmt.Sprintf("btv-%s-%d.sock", sanitizeToken(label, 8), time.Now().UnixNano()%1_000_000_000))
}

func TestValidWindowsPipeName(t *testing.T) {
	if !validWindowsPipeName(`\\.\pipe\beeftv-ws-abcdef123456-42`) {
		t.Fatal("expected valid windows pipe name to pass")
	}
	for _, bad := range []string{
		"",
		`\\.\pipe\other-app`,
		`\\192.168.1.2\pipe\beeftv-ws-123`,
		`\\.\pipe\beeftv-..\escape`,
		`\\.\pipe\beeftv-a/b`,
		`C:\temp\beeftv.pipe`,
	} {
		if validWindowsPipeName(bad) {
			t.Fatalf("expected %q to be rejected", bad)
		}
	}
}

func TestHTTPStreamingAndConcurrencyOverLocalIPC(t *testing.T) {
	endpoint := testEndpoint(t, "stream")
	listener, err := Listen(endpoint)
	if err != nil {
		t.Fatalf("Listen(%s): %v", endpoint, err)
	}
	defer listener.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/echo", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = fmt.Fprintf(w, "host=%s remote=%s", r.Host, r.RemoteAddr)
	})
	mux.HandleFunc("/stream", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		flusher, _ := w.(http.Flusher)
		for i := range 3 {
			_, _ = fmt.Fprintf(w, "{\"seq\":%d}\n", i)
			if flusher != nil {
				flusher.Flush()
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
	srv := &http.Server{Handler: mux}
	defer srv.Close()
	go func() { _ = srv.Serve(listener) }()

	client := &http.Client{
		Transport: NewDynamicHTTPTransport(func() string { return endpoint }, 5*time.Second, false),
		Timeout:   5 * time.Second,
	}

	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Port 1 is intentionally unreachable over TCP, proving requests traverse local IPC.
			resp, reqErr := client.Get("http://127.0.0.1:1/echo")
			if reqErr != nil {
				errs <- reqErr
				return
			}
			defer resp.Body.Close()
			raw, _ := io.ReadAll(resp.Body)
			got := string(raw)
			if got != "host=127.0.0.1:1 remote=127.0.0.1:0" {
				errs <- fmt.Errorf("unexpected echo payload: %q", got)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for reqErr := range errs {
		t.Fatal(reqErr)
	}

	streamResp, err := client.Get("http://127.0.0.1:1/stream")
	if err != nil {
		t.Fatalf("stream request failed: %v", err)
	}
	defer streamResp.Body.Close()
	scanner := bufio.NewScanner(streamResp.Body)
	var lines []string
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if len(lines) != 3 || !strings.Contains(lines[2], `"seq":2`) {
		t.Fatalf("unexpected stream lines: %v", lines)
	}

	// Closing listener must unblock Accept promptly.
	done := make(chan struct{})
	go func() {
		_ = listener.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("listener.Close timed out")
	}

	if runtime.GOOS == "windows" {
		ep2 := testEndpoint(t, "dup")
		l1, err := Listen(ep2)
		if err != nil {
			t.Fatalf("first Listen failed: %v", err)
		}
		defer l1.Close()
		if l2, err := Listen(ep2); err == nil {
			_ = l2.Close()
			t.Fatal("expected duplicate first-instance pipe Listen to fail")
		}
	}
}

func TestDynamicTransportFallsBackToNetworkWhenConfigured(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ok", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("tcp-ok"))
	})
	tcpListener, err := ListenTCPForTest()
	if err != nil {
		t.Fatalf("tcp listen: %v", err)
	}
	defer tcpListener.Close()
	srv := &http.Server{Handler: mux}
	defer srv.Close()
	go func() { _ = srv.Serve(tcpListener) }()

	missingEndpoint := testEndpoint(t, "missing")
	client := &http.Client{
		Transport: NewDynamicHTTPTransport(func() string { return missingEndpoint }, 2*time.Second, true),
		Timeout:   2 * time.Second,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+tcpListener.Addr().String()+"/ok", nil)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("expected TCP fallback to succeed, got %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if string(raw) != "tcp-ok" {
		t.Fatalf("unexpected body: %q", string(raw))
	}
}

func TestWrapPipeConnError(t *testing.T) {
	local := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0}
	remote := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0}

	if got := wrapPipeConnError("read", local, remote, nil); got != nil {
		t.Fatalf("nil error should stay nil, got %v", got)
	}
	if got := wrapPipeConnError("read", local, remote, io.EOF); got != io.EOF {
		t.Fatalf("io.EOF should stay io.EOF, got %v", got)
	}

	deadlineErr := &os.PathError{Op: "read", Path: `\\.\pipe\beeftv-test`, Err: os.ErrDeadlineExceeded}
	wrapped := wrapPipeConnError("read", local, remote, deadlineErr)
	netErr, ok := wrapped.(net.Error)
	if !ok {
		t.Fatalf("wrapped deadline error %T must implement net.Error", wrapped)
	}
	if !netErr.Timeout() {
		t.Fatalf("wrapped deadline error must report Timeout()=true: %v", wrapped)
	}
	if !netErr.Temporary() {
		t.Fatalf("wrapped deadline error must report Temporary()=true: %v", wrapped)
	}
	if !errors.Is(wrapped, os.ErrDeadlineExceeded) {
		t.Fatalf("wrapped deadline error must preserve os.ErrDeadlineExceeded: %v", wrapped)
	}

	nestedDeadlineErr := &os.PathError{
		Op:   "read",
		Path: `\\.\pipe\beeftv-test`,
		Err:  fmt.Errorf("pipe poll: %w", os.ErrDeadlineExceeded),
	}
	wrappedNested := wrapPipeConnError("read", local, remote, nestedDeadlineErr)
	nestedNetErr, ok := wrappedNested.(net.Error)
	if !ok || !nestedNetErr.Timeout() || !errors.Is(wrappedNested, os.ErrDeadlineExceeded) {
		t.Fatalf("multi-wrapped deadline error must normalize to timeout net.Error, got %T: %v", wrappedNested, wrappedNested)
	}

	closedErr := &os.PathError{Op: "read", Path: `\\.\pipe\beeftv-test`, Err: os.ErrClosed}
	wrappedClosed := wrapPipeConnError("read", local, remote, closedErr)
	if _, ok := wrappedClosed.(net.Error); !ok {
		t.Fatalf("wrapped closed error %T must implement net.Error", wrappedClosed)
	}
	if !errors.Is(wrappedClosed, net.ErrClosed) {
		t.Fatalf("wrapped closed error must match net.ErrClosed: %v", wrappedClosed)
	}

	existing := &net.OpError{Op: "read", Net: "pipe", Err: os.ErrDeadlineExceeded}
	if got := wrapPipeConnError("read", local, remote, existing); got != existing {
		t.Fatalf("existing *net.OpError should pass through unchanged, got %v", got)
	}
}

type pathErrorSimConn struct {
	net.Conn
}

func (c *pathErrorSimConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if err != nil {
		if ne, ok := err.(net.Error); ok && ne.Timeout() {
			// Match *os.File.Read on Windows Named Pipes: returns *os.PathError
			// wrapping os.ErrDeadlineExceeded, which does NOT implement net.Error.
			err = &os.PathError{Op: "read", Path: `\\.\pipe\beeftv-sim`, Err: os.ErrDeadlineExceeded}
		}
		err = wrapPipeConnError("read", c.LocalAddr(), c.RemoteAddr(), err)
	}
	return n, err
}

type simListener struct {
	net.Listener
}

func (l *simListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &pathErrorSimConn{Conn: c}, nil
}

func TestKeepAlivePostPreservesContextWhenFileConnReturnsPathError(t *testing.T) {
	baseLn, err := ListenTCPForTest()
	if err != nil {
		t.Fatalf("ListenTCPForTest: %v", err)
	}
	ln := &countingListener{Listener: &simListener{Listener: baseLn}}
	defer ln.Close()

	var mu sync.Mutex
	var ctxErrs []error
	srv := &http.Server{
		ReadHeaderTimeout: 10 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.ReadAll(r.Body)
			mu.Lock()
			ctxErrs = append(ctxErrs, r.Context().Err())
			mu.Unlock()
			if r.Context().Err() != nil {
				http.Error(w, r.Context().Err().Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"code":0,"data":{"ok":true}}`))
		}),
	}
	defer srv.Close()
	go func() { _ = srv.Serve(ln) }()

	client := &http.Client{
		Transport: &http.Transport{
			DisableKeepAlives:   false,
			MaxIdleConnsPerHost: 1,
			MaxConnsPerHost:     1,
		},
		Timeout: 5 * time.Second,
	}
	defer client.CloseIdleConnections()

	url := "http://" + baseLn.Addr().String() + "/api/ops/canvas.get"
	for i := range 6 {
		resp, reqErr := client.Post(url, "application/json", bytes.NewBufferString(fmt.Sprintf(`{"params":{"canvasId":"c-%d"}}`, i)))
		if reqErr != nil {
			t.Fatalf("request %d failed: %v", i, reqErr)
		}
		_, _ = io.ReadAll(resp.Body)
		resp.Body.Close()
	}
	if accepts := ln.accepts.Load(); accepts != 1 {
		t.Fatalf("expected 1 reused keep-alive connection, got %d accepts", accepts)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(ctxErrs) != 6 {
		t.Fatalf("expected 6 recorded contexts, got %d", len(ctxErrs))
	}
	for i, ctxErr := range ctxErrs {
		if ctxErr != nil {
			t.Fatalf("request %d unexpectedly had canceled context: %v", i, ctxErr)
		}
	}
}

type countingListener struct {
	net.Listener
	accepts atomic.Int32
}

func (l *countingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err == nil {
		l.accepts.Add(1)
	}
	return c, err
}

func TestHTTPKeepAlivePostContextOverLocalIPC(t *testing.T) {
	endpoint := testEndpoint(t, "keepalive")
	rawLn, err := Listen(endpoint)
	if err != nil {
		t.Fatalf("Listen(%s): %v", endpoint, err)
	}
	ln := &countingListener{Listener: rawLn}
	defer ln.Close()

	srv := &http.Server{
		ReadHeaderTimeout: 10 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, readErr := io.ReadAll(r.Body)
			if readErr != nil {
				http.Error(w, readErr.Error(), http.StatusBadRequest)
				return
			}
			if ctxErr := r.Context().Err(); ctxErr != nil {
				http.Error(w, "ctx="+ctxErr.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{"code":0,"data":{"path":%q,"bytes":%d}}`, r.URL.Path, len(body))
		}),
	}
	defer srv.Close()
	go func() { _ = srv.Serve(ln) }()

	// 1. Go keep-alive HTTP client reusing a single local IPC connection.
	keepAliveTransport := &http.Transport{
		Proxy:               nil,
		DisableKeepAlives:   false,
		MaxIdleConnsPerHost: 1,
		MaxConnsPerHost:     1,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return DialContext(ctx, endpoint)
		},
	}
	client := &http.Client{Transport: keepAliveTransport, Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()

	paths := []string{
		"/api/assistant/runtime/turns/t1/bind-session",
		"/api/ops/canvas.get",
		"/api/ops/skill.catalog",
		"/api/ops/canvas.get",
		"/api/ops/canvas.nodes.create",
		"/api/ops/canvas.get",
	}
	for i, path := range paths {
		resp, reqErr := client.Post("http://127.0.0.1:1"+path, "application/json", bytes.NewBufferString(`{"params":{"canvasId":"canvas-1"}}`))
		if reqErr != nil {
			t.Fatalf("Go keep-alive POST #%d (%s) failed: %v", i, path, reqErr)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("Go keep-alive POST #%d (%s) status=%d body=%s", i, path, resp.StatusCode, string(raw))
		}
	}
	if accepts := ln.accepts.Load(); accepts != 1 {
		t.Fatalf("expected 1 reused keep-alive pipe connection for Go client, got %d accepts", accepts)
	}

	// 2. Real Node.js http.request({ socketPath }) keep-alive client (same path as agent-host/operation-bridge.mjs).
	t.Run("node_keepalive", func(t *testing.T) {
		nodeBin, lookErr := exec.LookPath("node")
		if lookErr != nil {
			t.Skip("node not installed; skipping Node keep-alive pipe verification")
		}
		beforeNodeAccepts := ln.accepts.Load()
		script := `
const http = require('node:http');
const socketPath = process.argv[1];
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const paths = [
  '/api/assistant/runtime/turns/t1/bind-session',
  '/api/ops/canvas.get',
  '/api/ops/skill.catalog',
  '/api/ops/canvas.get',
  '/api/ops/canvas.get',
];
function post(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      agent,
      socketPath,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: '127.0.0.1:1' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, reused: req.reusedSocket, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(JSON.stringify({ params: { canvasId: 'canvas-node' } }));
    req.end();
  });
}
(async () => {
  for (let i = 0; i < paths.length; i++) {
    const res = await post(paths[i]);
    if (res.status !== 200) {
      console.error('FAILED', i, paths[i], res.status, res.body);
      process.exit(1);
    }
    if (i > 0 && !res.reused) {
      console.error('NOT_REUSED', i, paths[i]);
      process.exit(1);
    }
  }
  agent.destroy();
})().catch((err) => { console.error(err); process.exit(1); });
`
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, nodeBin, "-e", script, endpoint)
		out, cmdErr := cmd.CombinedOutput()
		if cmdErr != nil {
			t.Fatalf("Node keep-alive POST sequence over localipc failed: %v\noutput: %s", cmdErr, string(out))
		}
		if delta := ln.accepts.Load() - beforeNodeAccepts; delta != 1 {
			t.Fatalf("expected 1 reused keep-alive pipe connection for Node client, got %d accepts", delta)
		}
	})
}
