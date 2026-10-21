package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/workspace"
)

type upscaleAPITest struct {
	calls int
	owner string
}

func (*upscaleAPITest) MediaUpscaleCapabilities(context.Context) (map[string]any, error) {
	return map[string]any{"supported_models": []any{map[string]any{"id": "topaz-standard-v2", "media_type": "image"}}}, nil
}
func (a *upscaleAPITest) EstimateMediaUpscale(_ context.Context, owner string, _ generation.Input) (generation.UpscaleEstimate, error) {
	a.calls++
	a.owner = owner
	return generation.UpscaleEstimate{Model: "topaz-standard-v2", Currency: "CNY", Reservation: 1.25}, nil
}

func TestUpscaleEstimateRequiresDesktopWriterAndUsesWorkspaceOwner(t *testing.T) {
	gin.SetMode(gin.TestMode)
	api := &upscaleAPITest{}
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: "actual-owner", DataDir: t.TempDir()}))
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{RequestCoordinator: &stubRequestCoordinator{allowed: true}, DesktopTrust: func(r *http.Request) bool { return r.Header.Get("X-Test-Trusted") == "yes" }}))
	registerMediaUpscaleRoutes(router.Group("/api"), &app.Service{}, api)
	for _, tc := range []struct {
		trusted, client bool
		body            string
		status          int
	}{
		{false, false, `{}`, 403},
		{true, true, `{}`, 403},
		{true, false, `{`, 400},
		{true, false, `{"mode":"image","config":{"model":"topaz-standard-v2"},"upscale":{"factor":2}}`, 200},
	} {
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:18090/api/media-upscale/estimate", strings.NewReader(tc.body))
		request.RemoteAddr = "127.0.0.1:12345"
		request.Header.Set("Content-Type", "application/json")
		if tc.trusted {
			request.Header.Set("X-Test-Trusted", "yes")
		}
		if tc.client {
			request.Header.Set("X-Beeftv-Client", "read-only-client")
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != tc.status {
			t.Fatalf("trusted=%v client=%v status=%d body=%s", tc.trusted, tc.client, recorder.Code, recorder.Body)
		}
		if recorder.Code == 200 && !strings.Contains(recorder.Body.String(), `"generation_submitted":false`) {
			t.Fatal("estimate did not preserve non-generating receipt")
		}
	}
	if api.calls != 1 || api.owner != "actual-owner" {
		t.Fatalf("calls=%d owner=%s", api.calls, api.owner)
	}
}
