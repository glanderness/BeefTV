package generation

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/protocol"
)

func videoResultDownloader(config Config, rawURL, taskID string, renew ...videoResultURLResolver) func(context.Context) ([]byte, string, error) {
	var resolver videoResultResolver
	if len(renew) > 0 {
		resolver = func(ctx context.Context) (VideoResultSource, error) {
			freshURL, err := renew[0](ctx)
			return VideoResultSource{URL: freshURL}, err
		}
	}
	fileDownload := videoResultFileDownloader(config, taskID, VideoResultSource{URL: rawURL}, resolver)
	return func(ctx context.Context) ([]byte, string, error) {
		filePath, mimeType, err := fileDownload(ctx)
		if err != nil {
			return nil, "", err
		}
		defer os.Remove(filePath)
		data, err := os.ReadFile(filePath)
		return data, mimeType, err
	}
}

func getVideoBinaryWithIdleTimeout(ctx context.Context, config Config, rawURL string, idle time.Duration) ([]byte, string, error) {
	dlCtx := context.WithValue(ctx, videoDeliveryRequestContext{}, idle)
	dlCtx = context.WithValue(dlCtx, videoDownloadHeaderTimeoutContext{}, idle)
	filePath, mimeType, err := getProviderExternalVideoFile(dlCtx, config, rawURL)
	if err != nil {
		return nil, "", err
	}
	defer os.Remove(filePath)
	data, err := os.ReadFile(filePath)
	return data, mimeType, err
}

func downloadVideoResultForTest(ctx context.Context, config Config, rawURL, taskID string) ([]byte, string, error) {
	policy := videoPollPolicyForConfig(ctx, config, DefaultVideoPollPolicy())
	data, mimeType, err := RunVideoDownload(ctx, taskID, policy, videoResultDownloader(config, rawURL, taskID))
	return data, NormalizedMediaMIMEType(mimeType, data), err
}

func TestSeedanceDispatchUsesGatewayDeliveryFallback(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, withURL := range []bool{true, false} {
		t.Run(map[bool]string{true: "result URL", false: "content endpoint"}[withURL], func(t *testing.T) {
			creates, polls, direct, proxy := 0, 0, 0, 0
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-key" {
					t.Error("missing provider credential")
				}
				switch {
				case r.Method == http.MethodPost && r.URL.Path == "/v1/videos":
					creates++
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "original"})
				case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/original":
					polls++
					state := map[string]any{"status": "completed"}
					if withURL {
						state["video_url"] = server.URL + "/v1/videos/original/content"
					}
					_ = json.NewEncoder(w).Encode(state)
				case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/original/content":
					if r.URL.Query().Get("delivery") != "" {
						proxy++
						t.Error("client selected a recovery route")
					}
					direct++
					if direct == 1 {
						w.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("original video"))
				default:
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			ctx := WithEndpoints(context.Background(), Endpoints{BeefTVVideoBaseURL: server.URL})
			ctx = WithSubmissionKey(ctx, "stable-video-attempt")
			policy := DefaultVideoPollPolicy()
			policy.Sleep = func(context.Context, time.Duration) error { return nil }
			result, err := RunVideoTaskWithPolicy(ctx, Input{Mode: "video", Prompt: "pottery", Config: Config{BaseURL: server.URL, APIKey: "test-key", InterfaceType: "newapi", Model: "seedance-2.0-fast", VideoSeconds: "5", VQuality: "720P", Size: "16:9"}}, policy)
			if err != nil {
				t.Fatal(err)
			}
			video, _ := result["video"].(map[string]interface{})
			_, data, err := DecodeProviderDataURL(stringField(video, "dataUrl"))
			if err != nil || string(data) != "original video" || creates != 1 || polls != 1 || direct != 2 || proxy != 0 {
				t.Fatalf("result=%v creates=%d polls=%d direct=%d proxy=%d error=%v", result, creates, polls, direct, proxy, err)
			}
		})
	}
}

type deliveryCircuitLimits struct {
	stubLimits
	checks, results, acquired, released int
}

func (l *deliveryCircuitLimits) CircuitOpen(context.Context, string) (bool, error) {
	l.checks++
	return true, nil
}

func (l *deliveryCircuitLimits) RecordChannelResult(context.Context, string, bool) error {
	l.results++
	return nil
}

func (l *deliveryCircuitLimits) AcquireChannelSlot(context.Context, string, string, time.Duration) (func(), int, error) {
	l.acquired++
	return func() { l.released++ }, 1, nil
}

func TestCompletedVideoDownloadDoesNotUseGenerationCircuit(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, status := range []int{200, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			hits := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits++
				w.WriteHeader(status)
			}))
			defer server.Close()
			limits := &deliveryCircuitLimits{}
			ctx := WithRuntime(context.Background(), Runtime{Limits: limits, Call: CallMeta{ChannelID: "video", RequestKind: "download"}})
			_, _, err := GetProviderExternalBinary(ctx, Config{BaseURL: server.URL}, "/videos/original/content")
			if (err != nil) != (status != 200) || hits != 1 || limits.checks != 0 || limits.results != 0 || limits.acquired != 1 || limits.released != 1 {
				t.Fatalf("download err=%v hits=%d limits=%+v", err, hits, limits)
			}
			_, _, err = GetProviderExternalBinary(WithRequestKind(ctx, "poll"), Config{BaseURL: server.URL}, "/videos/original")
			if err == nil || hits != 1 || limits.checks != 1 || limits.acquired != 1 {
				t.Fatalf("generation circuit no longer protects polling: %v %+v", err, limits)
			}
		})
	}
}

func TestVideoDeliveryFallbackReadsSameTaskWithoutGeneration(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, directStatus := range []int{200, 503, 401} {
		t.Run(http.StatusText(directStatus), func(t *testing.T) {
			direct, proxy := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/v1/videos/original/content" {
					t.Error("unexpected request")
				}
				if r.Header.Get("Authorization") != "Bearer test-key" {
					t.Error("missing provider credential")
				}
				if r.URL.Query().Get("delivery") == "backup" {
					proxy++
				} else {
					direct++
					if directStatus != 200 {
						w.WriteHeader(directStatus)
						return
					}
				}
				w.Header().Set("Content-Type", "video/mp4")
				_, _ = w.Write([]byte("original video"))
			}))
			defer server.Close()
			ctx := WithEndpoints(context.Background(), Endpoints{BeefTVVideoBaseURL: server.URL})
			data, _, err := videoResultDownloader(Config{BaseURL: server.URL, APIKey: "test-key"}, server.URL+"/v1/videos/original/content", "original")(ctx)
			if directStatus == 401 {
				if err == nil || proxy != 0 {
					t.Fatal("retried rejected credential")
				}
			} else if err != nil || string(data) != "original video" {
				t.Fatalf("delivery failed: %v", err)
			}
			want := 0
			if directStatus == 503 {
				want = 1
			}
			if direct != 1 || proxy != want {
				t.Fatalf("requests direct=%d proxy=%d", direct, proxy)
			}
		})
	}
}

func TestVideoDeliveryFallbackFollowsBackupWithoutCredentials(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	redirected := 0
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected++
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Gateway-Secret") != "" {
			t.Error("gateway credentials reached the signed media endpoint")
		}
		_, _ = w.Write([]byte("original video"))
	}))
	defer media.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("delivery") == "backup" {
			if r.Header.Get("Authorization") != "Bearer test-key" {
				t.Error("backup endpoint missing gateway credential")
			}
			http.Redirect(w, r, media.URL, 302)
			return
		}
		w.WriteHeader(503)
	}))
	defer server.Close()
	ctx := WithEndpoints(context.Background(), Endpoints{BeefTVVideoBaseURL: server.URL})
	config := Config{BaseURL: server.URL, APIKey: "test-key", Headers: []outbound.OutboundHeader{{Name: "X-Gateway-Secret", Value: "private-value"}}}
	data, _, err := videoResultDownloader(config, server.URL+"/v1/videos/original/content", "original")(ctx)
	if err != nil || redirected != 1 || string(data) != "original video" {
		t.Fatalf("backup redirect: %d %v", redirected, err)
	}
}

func TestFinishProtocolResultPersistedVideoAttachesLastFrame(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	videoBytes := unifiedVideoPayload(t)
	lastFrameBytes := []byte("\x89PNG\r\n\x1a\nlast-frame-bytes")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/video.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(videoBytes)
		case "/last-frame.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(lastFrameBytes)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	store := &recordingVideoFileStore{savedDir: t.TempDir(), savedID: "saved-video-1"}
	ctx := WithRuntime(context.Background(), Runtime{
		Resources: store,
		Call:      CallMeta{UserID: "user-1", TaskID: "task-last-frame"},
	})
	result, err := FinishProtocolResult(ctx, Config{BaseURL: srv.URL, APIKey: "k"}, "video", "task-last-frame", &protocol.Result{
		Videos: []protocol.MediaReference{{
			URL:      srv.URL + "/video.mp4",
			Metadata: map[string]any{"last_frame_url": srv.URL + "/last-frame.png"},
		}},
	}, DefaultVideoPollPolicy())
	if err != nil {
		t.Fatalf("FinishProtocolResult() error = %v", err)
	}
	if store.calls != 1 {
		t.Fatalf("expected 1 PersistGeneratedVideoFile call, got %d", store.calls)
	}
	video, _ := result["video"].(map[string]any)
	if video == nil || video["storageKey"] != "resource:saved-video-1" {
		t.Fatalf("expected persisted video resource map, got %+v", video)
	}
	lastFrame, _ := video["lastFrame"].(map[string]any)
	if lastFrame == nil || !strings.HasPrefix(stringField(lastFrame, "dataUrl"), "data:image/png;base64,") {
		t.Fatalf("expected attached lastFrame PNG dataUrl on persisted video result, got %+v", video["lastFrame"])
	}
}
