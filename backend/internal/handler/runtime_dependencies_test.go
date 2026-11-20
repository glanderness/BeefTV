package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

type stubRequestCoordinator struct {
	allowed bool
	retry   time.Duration
	calls   int
}

func (s *stubRequestCoordinator) AllowRequest(context.Context, string, int, time.Duration) (bool, error) {
	s.calls++
	return s.allowed, nil
}

func (s *stubRequestCoordinator) RequestRetryAfter(context.Context, string, time.Duration) time.Duration {
	return s.retry
}

func TestRuntimeDependenciesKeepRoutersIsolated(t *testing.T) {
	gin.SetMode(gin.TestMode)
	allowed := &stubRequestCoordinator{allowed: true}
	blocked := &stubRequestCoordinator{allowed: false, retry: 3 * time.Second}

	newRouter := func(coordinator RequestCoordinator) *gin.Engine {
		router := gin.New()
		router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{RequestCoordinator: coordinator}))
		router.GET("/limited", func(c *gin.Context) {
			if !enforceRateLimit(c, "test", 1, time.Minute) {
				return
			}
			c.Status(http.StatusNoContent)
		})
		return router
	}

	first := httptest.NewRecorder()
	newRouter(allowed).ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/limited", nil))
	if first.Code != http.StatusNoContent {
		t.Fatalf("allowed router status = %d, want %d", first.Code, http.StatusNoContent)
	}

	second := httptest.NewRecorder()
	newRouter(blocked).ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/limited", nil))
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("blocked router status = %d, want %d", second.Code, http.StatusTooManyRequests)
	}
	if got := second.Header().Get("Retry-After"); got != "3" {
		t.Fatalf("Retry-After = %q, want 3", got)
	}
	if allowed.calls != 1 || blocked.calls != 1 {
		t.Fatalf("coordinator calls = (%d, %d), want (1, 1)", allowed.calls, blocked.calls)
	}
}

func TestEnforcePolicyRateLimitSkipsCoordinatorWhenUnlimited(t *testing.T) {
	gin.SetMode(gin.TestMode)
	blocked := &stubRequestCoordinator{allowed: false, retry: 5 * time.Second}

	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{RequestCoordinator: blocked}))
	router.GET("/unlimited", func(c *gin.Context) {
		var policy app.RuntimePolicySetting
		policy.Request.Unlimited = true
		if !enforcePolicyRateLimit(c, policy, "canvas-write:local", 1, time.Minute) {
			return
		}
		c.Status(http.StatusNoContent)
	})
	router.GET("/enforced", func(c *gin.Context) {
		var policy app.RuntimePolicySetting
		if !enforcePolicyRateLimit(c, policy, "canvas-write:hosted", 1, time.Minute) {
			return
		}
		c.Status(http.StatusNoContent)
	})

	unlimitedResp := httptest.NewRecorder()
	router.ServeHTTP(unlimitedResp, httptest.NewRequest(http.MethodGet, "/unlimited", nil))
	if unlimitedResp.Code != http.StatusNoContent {
		t.Fatalf("unlimited policy status = %d, want %d", unlimitedResp.Code, http.StatusNoContent)
	}
	if blocked.calls != 0 {
		t.Fatalf("unlimited policy called coordinator %d times, want 0", blocked.calls)
	}

	enforcedResp := httptest.NewRecorder()
	router.ServeHTTP(enforcedResp, httptest.NewRequest(http.MethodGet, "/enforced", nil))
	if enforcedResp.Code != http.StatusTooManyRequests {
		t.Fatalf("enforced policy status = %d, want %d", enforcedResp.Code, http.StatusTooManyRequests)
	}
	if blocked.calls != 1 {
		t.Fatalf("enforced policy called coordinator %d times, want 1", blocked.calls)
	}
}
