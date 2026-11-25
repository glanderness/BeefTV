package beeftv

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

// The upscale content endpoint redirects to the file the API already saved in
// object storage. Only that GET follows the redirect, and only to public HTTPS.

func TestUpscaleContentRejectsPrivateAndInvalidRedirects(t *testing.T) {
	// The API itself is a loopback test server, so the client runs in test mode
	// and loopback is allowed for the first hop. Loopback redirect targets are
	// therefore covered by TestStorageRedirectHopPolicyInProduction instead.
	for name, tc := range map[string]struct{ target, want string }{
		"private range":   {"https://10.0.0.8/saved", "内网"},
		"link-local":      {"https://169.254.169.254/latest/meta-data", "链路本地"},
		"credentials":     {"https://user:pass@storage.example.com/saved", "认证信息"},
		"non-http scheme": {"file:///etc/passwd", "地址无效"},
	} {
		t.Run(name, func(t *testing.T) {
			var hops atomic.Int32
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hops.Add(1)
				http.Redirect(w, r, tc.target, http.StatusTemporaryRedirect)
			}))
			defer api.Close()
			client := &MediaClient{BaseURL: api.URL + "/v1", APIKey: "secret", AllowHTTPTest: true}
			t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
			t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
			_, _, err := client.LegacyUpscaleContent(context.Background(), "task-1", 1<<20)
			if hops.Load() != 1 {
				t.Fatalf("API content endpoint hits = %d (err %v)", hops.Load(), err)
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("redirect to %s: err = %v, want policy error containing %q", tc.target, err, tc.want)
			}
		})
	}
}

func TestUpscaleContentStopsAfterRedirectLimit(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hops atomic.Int32
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hops.Add(1)
		http.Redirect(w, r, server.URL+"/loop", http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	client := &MediaClient{BaseURL: server.URL + "/v1", APIKey: "secret", AllowHTTPTest: true}
	_, _, err := client.LegacyUpscaleContent(context.Background(), "task-1", 1<<20)
	if err == nil || !strings.Contains(err.Error(), "重定向次数过多") {
		t.Fatalf("err = %v", err)
	}
	if got := hops.Load(); got != storageRedirectLimit {
		t.Fatalf("hops = %d", got)
	}
}

func TestUpscaleContentEnforcesSizeLimitAfterRedirect(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(make([]byte, 2048))
	}))
	defer storage.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, storage.URL+"/saved", http.StatusTemporaryRedirect)
	}))
	defer api.Close()
	client := &MediaClient{BaseURL: api.URL + "/v1", APIKey: "secret", AllowHTTPTest: true}
	if _, _, err := client.LegacyUpscaleContent(context.Background(), "task-1", 1024); err == nil {
		t.Fatal("accepted a stored file larger than the limit")
	}
}

func TestUpscaleJSONAndPOSTStillRefuseRedirects(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var storageHits atomic.Int32
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		storageHits.Add(1)
		_, _ = w.Write([]byte(`{"task_id":"task-1","status":"completed","model":"m","media_type":"image"}`))
	}))
	defer storage.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, storage.URL+"/elsewhere", http.StatusTemporaryRedirect)
	}))
	defer api.Close()
	client := &MediaClient{BaseURL: api.URL + "/v1", APIKey: "secret", AllowHTTPTest: true}
	if _, err := client.QueryLegacyUpscale(context.Background(), "task-1", "m", "image"); err == nil {
		t.Fatal("status query followed a redirect")
	}
	if _, err := client.CreateLegacyUpscale(context.Background(), "key-1", LegacyUpscaleInput{}); err == nil {
		t.Fatal("create followed a redirect")
	}
	if err := client.CancelLegacyUpscale(context.Background(), "task-1"); err == nil {
		t.Fatal("cancel followed a redirect")
	}
	if storageHits.Load() != 0 {
		t.Fatalf("JSON or POST calls reached the redirect target %d times", storageHits.Load())
	}
}

// Production clients (no test mode) refuse every non-public or non-HTTPS hop
// when private upstreams are disabled, and always refuse link-local, URL
// credentials, and plain HTTP to public hosts.
func TestStorageRedirectHopPolicyInProduction(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	client := &MediaClient{}
	for _, target := range []string{
		"https://127.0.0.1/saved",
		"https://localhost/saved",
		"https://10.0.0.8/saved",
		"https://169.254.169.254/latest/meta-data",
		"http://storage.example.com/saved",
		"https://user:pass@storage.example.com/saved",
	} {
		req, err := http.NewRequestWithContext(client.networkContext(context.Background()), http.MethodGet, target, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := client.storageClient("too many").CheckRedirect(req, []*http.Request{req}); err == nil {
			t.Fatalf("hop to %s allowed", target)
		}
	}
	req, _ := http.NewRequestWithContext(client.networkContext(context.Background()), http.MethodGet, "https://storage.example.com/saved", nil)
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("Cookie", "session=1")
	req.Header.Set("X-Private-Gateway", "private")
	_ = client.storageClient("too many").CheckRedirect(req, []*http.Request{req})
	if len(req.Header) != 0 {
		t.Fatalf("hop kept headers: %v", req.Header)
	}
}

func TestUpscaleContentToFileExactAtLimitAndOverLimitAfterRedirect(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var payloadSize atomic.Int64
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := int(payloadSize.Load())
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("ETag", `"exact-limit-etag"`)
		_, _ = w.Write(make([]byte, n))
	}))
	defer storage.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, storage.URL+"/saved.mp4", http.StatusFound)
	}))
	defer api.Close()

	client := &MediaClient{BaseURL: api.URL + "/v1", APIKey: "secret", AllowHTTPTest: true}
	destDir := t.TempDir()

	// Exact limit (1024 bytes with limit=1024) must succeed on 302 redirect.
	payloadSize.Store(1024)
	path, mime, size, err := client.LegacyUpscaleContentToFile(context.Background(), "task-exact", destDir, 1024)
	if err != nil {
		t.Fatalf("exact at-limit /content redirect failed: %v", err)
	}
	defer os.Remove(path)
	if size != 1024 || mime != "video/mp4" {
		t.Fatalf("exact at-limit got size=%d mime=%q, want 1024 video/mp4", size, mime)
	}

	// Limit + 1 (1025 bytes with limit=1024) must fail cleanly.
	payloadSize.Store(1025)
	if overPath, _, _, err := client.LegacyUpscaleContentToFile(context.Background(), "task-over", destDir, 1024); err == nil {
		_ = os.Remove(overPath)
		t.Fatal("accepted 1025-byte redirected file under 1024-byte limit")
	}
}

type closeTrackingReadCloser struct {
	io.ReadCloser
	closed *atomic.Bool
}

func (c *closeTrackingReadCloser) Close() error {
	c.closed.Store(true)
	return c.ReadCloser.Close()
}

type redirectProbeSpyTransport struct {
	base        http.RoundTripper
	probeClosed *atomic.Bool
	probeSeen   *atomic.Bool
}

func (rt *redirectProbeSpyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := rt.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	if isRedirectStatus(resp.StatusCode) {
		rt.probeSeen.Store(true)
		resp.Body = &closeTrackingReadCloser{ReadCloser: resp.Body, closed: rt.probeClosed}
	}
	return resp, nil
}

func TestDownloadStorageToFileClosesRedirectProbeBeforeStorageHop(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var probeSeen, probeClosed, closedBeforeStorage atomic.Bool
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		closedBeforeStorage.Store(probeClosed.Load())
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("ETag", `"probe-close-etag"`)
		_, _ = w.Write([]byte("0123456789abcdef"))
	}))
	defer storage.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", storage.URL+"/saved.mp4")
		w.WriteHeader(http.StatusFound)
		_, _ = w.Write([]byte("redirect body"))
	}))
	defer api.Close()

	client := &MediaClient{
		BaseURL:       api.URL + "/v1",
		APIKey:        "secret",
		AllowHTTPTest: true,
		Client: &http.Client{
			Transport: &redirectProbeSpyTransport{
				base:        http.DefaultTransport,
				probeClosed: &probeClosed,
				probeSeen:   &probeSeen,
			},
		},
	}
	path, mime, size, err := client.LegacyUpscaleContentToFile(context.Background(), "task-close-probe", t.TempDir(), 1<<20)
	if err != nil {
		t.Fatalf("LegacyUpscaleContentToFile() error = %v", err)
	}
	defer os.Remove(path)
	if size != 16 || mime != "video/mp4" {
		t.Fatalf("got size=%d mime=%q, want 16 video/mp4", size, mime)
	}
	if !probeSeen.Load() {
		t.Fatal("expected 3xx redirect probe response to be observed")
	}
	if !closedBeforeStorage.Load() {
		t.Fatal("3xx redirect probe response body was still open when storage hop started")
	}
}
