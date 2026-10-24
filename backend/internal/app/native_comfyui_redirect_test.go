package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/provider/workflow"
)

func TestNativeComfyNeverRedirectsCredentials(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected.Add(1)
		w.Write([]byte(`{}`))
	}))
	defer target.Close()
	for _, status := range []int{http.StatusFound, http.StatusTemporaryRedirect} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-Comfy-Key") != "private-key" {
					t.Error("configured endpoint did not receive authentication")
				}
				http.Redirect(w, r, target.URL, status)
			}))
			defer server.Close()
			client := &workflow.Client{Requests: workflowRequestExecutor{}}
			_, err := client.InspectNativeComfy(context.Background(), workflow.Config{
				BaseURL: server.URL, InterfaceType: "comfyui-video", AuthType: "header", AuthHeader: "X-Comfy-Key", APIKey: "private-key",
			})
			if err == nil || redirected.Load() != 0 {
				t.Fatalf("redirect escaped configured endpoint: hits=%d err=%v", redirected.Load(), err)
			}
		})
	}
}
