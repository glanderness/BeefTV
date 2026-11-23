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
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/topaz"
)

type stubMediaCapabilitiesService struct {
	userID        string
	upscaleUsers  []string
	subtitleUsers []string
}

func (s *stubMediaCapabilitiesService) WorkspaceOwner(string) (*model.User, error) {
	return &model.User{ID: s.userID}, nil
}
func (s *stubMediaCapabilitiesService) LocalWorkspaceOwner() (*model.User, error) {
	return &model.User{ID: s.userID}, nil
}
func (s *stubMediaCapabilitiesService) RuntimePolicy() (app.RuntimePolicySetting, error) {
	return app.RuntimePolicySetting{Request: app.RuntimeRequestPolicy{TaskCreatePerMinute: 60}}, nil
}
func (s *stubMediaCapabilitiesService) RecoverMediaUpscale(context.Context, string, string) (*model.Task, error) {
	return nil, nil
}
func (s *stubMediaCapabilitiesService) MediaUpscaleCapabilities(ctx context.Context) map[string]any {
	s.upscaleUsers = append(s.upscaleUsers, generation.CanonicalCallMeta(ctx).UserID)
	return map[string]any{"modes": []any{}, "cloudProcessing": true}
}
func (s *stubMediaCapabilitiesService) EstimateMediaUpscale(context.Context, string, topaz.Request) (map[string]any, error) {
	return map[string]any{}, nil
}
func (s *stubMediaCapabilitiesService) CreateMediaUpscale(context.Context, string, topaz.Request) (*model.Task, error) {
	return nil, nil
}
func (s *stubMediaCapabilitiesService) RecoverVideoSubtitleErase(context.Context, string, string) (*model.Task, error) {
	return nil, nil
}
func (s *stubMediaCapabilitiesService) VideoSubtitleEraseCapabilities(ctx context.Context) map[string]any {
	s.subtitleUsers = append(s.subtitleUsers, generation.CanonicalCallMeta(ctx).UserID)
	return map[string]any{"models": []any{}, "cloudProcessing": true}
}
func (s *stubMediaCapabilitiesService) EstimateVideoSubtitleErase(context.Context, string, generation.SubtitleEraseRequest) (map[string]any, error) {
	return map[string]any{"reservation": 1}, nil
}
func (s *stubMediaCapabilitiesService) CreateVideoSubtitleErase(context.Context, string, generation.SubtitleEraseRequest) (*model.Task, error) {
	return nil, nil
}

func TestMediaCapabilitiesHandlersBindCallMetaUserID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := &stubMediaCapabilitiesService{userID: "user-handler-42"}
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{
		RequestCoordinator: &stubRequestCoordinator{allowed: true},
	}))
	api := router.Group("/api")
	registerMediaUpscaleRoutes(api, svc)
	registerVideoSubtitleEraseRoutes(api, svc)

	for _, path := range []string{"/api/media-upscale/capabilities", "/api/video-subtitle-erase/capabilities"} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s status=%d body=%s", path, rec.Code, rec.Body.String())
		}
	}
	if len(svc.upscaleUsers) != 1 || svc.upscaleUsers[0] != "user-handler-42" {
		t.Fatalf("upscale capabilities UserIDs = %v, want [user-handler-42]", svc.upscaleUsers)
	}
	if len(svc.subtitleUsers) != 1 || svc.subtitleUsers[0] != "user-handler-42" {
		t.Fatalf("subtitle erase capabilities UserIDs = %v, want [user-handler-42]", svc.subtitleUsers)
	}

	// Verify POST /video-subtitle-erase/estimate also passes UserID when checking capabilities.
	req := httptest.NewRequest(http.MethodPost, "/api/video-subtitle-erase/estimate", strings.NewReader(`{"resourceId":"res-1","eraseType":"subtitle"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://127.0.0.1")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if len(svc.subtitleUsers) != 2 || svc.subtitleUsers[1] != "user-handler-42" {
		t.Fatalf("subtitle erase estimate capabilities UserIDs = %v, want second user-handler-42 (status=%d body=%s)", svc.subtitleUsers, rec.Code, rec.Body.String())
	}
}
