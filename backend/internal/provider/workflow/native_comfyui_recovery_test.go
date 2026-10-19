package workflow

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNativeComfyQueryExistingVideoUsesHistoryOnly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Comfy-Key") != "test-key" {
			t.Error("native query lost authentication")
		}
		switch r.URL.Path {
		case "/history/original-prompt":
			json.NewEncoder(w).Encode(map[string]any{"original-prompt": map[string]any{
				"status":  map[string]any{"completed": true, "status_str": "success"},
				"outputs": map[string]any{"save": map[string]any{"images": []any{map[string]any{"filename": "out.mp4", "subfolder": "", "type": "output"}}}},
			}})
		case "/view":
			w.Header().Set("Content-Type", "video/mp4")
			w.Write(testMP4())
		default:
			t.Errorf("query used an unexpected create, upload, or cloud path: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	config := nativeComfyTestConfig(server.URL, "video", map[string]any{"save": map[string]any{"class_type": "SaveVideo", "inputs": map[string]any{}}}, nil, "images")
	config.AuthType, config.AuthHeader, config.APIKey = "header", "X-Comfy-Key", "test-key"
	client := &Client{Requests: nativeComfyHTTPExecutor{client: server.Client()}}
	result, stage, err := client.QueryNativeComfy(context.Background(), Input{Mode: "video", Config: config, LocalWorkspace: true}, "original-prompt")
	if err != nil || stage != "succeeded" {
		t.Fatalf("query failed: stage=%s err=%v", stage, err)
	}
	nativeComfyAssertResultBytes(t, result, "video", testMP4())
}

func TestNativeComfyCancelQueuedPromptAcceptsEmptyResponse(t *testing.T) {
	deleted := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/jobs/queued-prompt/cancel":
			http.NotFound(w, r)
		case r.URL.Path == "/queue" && r.Method == http.MethodPost:
			var body struct {
				Delete []string `json:"delete"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Delete) != 1 || body.Delete[0] != "queued-prompt" {
				t.Errorf("wrong targeted delete: %+v err=%v", body, err)
			}
			deleted = true
			w.WriteHeader(http.StatusOK)
		case r.URL.Path == "/queue":
			pending := []any{}
			if !deleted {
				pending = append(pending, []any{1, "queued-prompt"})
			}
			json.NewEncoder(w).Encode(map[string]any{"queue_pending": pending, "queue_running": []any{[]any{0, "someone-else"}}})
		case r.URL.Path == "/history/queued-prompt":
			w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected request (global interrupt must never be called): %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := &Client{Requests: nativeComfyHTTPExecutor{client: server.Client()}}
	if err := client.CancelNativeComfy(context.Background(), Config{BaseURL: server.URL}, "queued-prompt"); err != nil || !deleted {
		t.Fatalf("targeted cancellation failed: deleted=%v err=%v", deleted, err)
	}
}
