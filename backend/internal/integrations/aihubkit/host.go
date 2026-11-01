package aihubkit

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/bootstrap"
	"infinite-canvas/backend/internal/depthcapture"
	"infinite-canvas/backend/internal/runtimeinfo"
	httptransport "infinite-canvas/backend/internal/transport/http"
)

const sessionHeader = "X-Aihubkit-Session"
const cookieName = "beeftv_aihubkit"
const apiPrefix = "/api/integrations/aihubkit/"

// Host wraps one official local runtime at a time. Each account owns a separate
// database, provider snapshot, encryption key and resource tree. A server host
// is a single-operator workbench, not a shared multi-tenant deployment.
type Host struct {
	transition  sync.Mutex
	mu          sync.RWMutex
	cfg         bootstrap.Config
	client      *client
	active      *bootstrap.Runtime
	account     *account
	session     string
	accountCtx  context.Context
	cancel      context.CancelFunc
	handler     http.Handler
	server      *http.Server
	listener    net.Listener
	errors      chan error
	launchToken string
	uiToken     string
	lock        *os.File
	closed      bool
	migrating   bool
}

func Open(_ context.Context, cfg bootstrap.Config) (*Host, error) {
	if cfg.DataDir == "" {
		return nil, errors.New("账号宿主数据目录不能为空")
	}
	if cfg.DatabaseURL != "" || (cfg.DatabaseDriver != "" && cfg.DatabaseDriver != "sqlite") {
		return nil, errors.New("aihubkit 账号宿主仅支持独立的本地 SQLite 数据目录")
	}
	if cfg.ListenAddr == "" {
		if cfg.Profile == bootstrap.ProfileDesktop {
			cfg.ListenAddr = "127.0.0.1:0"
		} else {
			cfg.ListenAddr = bootstrap.DefaultServerListenAddr
		}
	}
	if cfg.Profile == bootstrap.ProfileDesktop && !strings.HasPrefix(cfg.ListenAddr, "127.0.0.1:") {
		return nil, errors.New("桌面账号宿主只能监听回环地址")
	}
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return nil, err
	}
	lock, err := runtimeinfo.LockWorkspace(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	h := &Host{cfg: cfg, client: newClient(), errors: make(chan error, 1), lock: lock}
	if cfg.Profile == bootstrap.ProfileDesktop {
		h.launchToken = cfg.LaunchToken
		if h.launchToken == "" {
			h.launchToken, err = httptransport.NewLaunchToken()
		}
		if err == nil {
			h.uiToken, err = httptransport.NewLaunchToken()
		}
	}
	if err != nil {
		lock.Close()
		return nil, err
	}
	router := gin.New()
	router.Use(gin.Recovery())
	for _, m := range cfg.RouterMiddleware {
		router.Use(m)
	}
	router.Use(h.cors())
	router.NoRoute(func(c *gin.Context) { h.serve(c.Writer, c.Request) })
	h.handler = router
	return h, nil
}

func (h *Host) cors() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" {
			allowed := false
			u, err := url.Parse(origin)
			if err == nil && u.User == nil && u.RawQuery == "" && u.Fragment == "" && (u.Path == "" || u.Path == "/") {
				allowed = (u.Scheme == "http" || u.Scheme == "https") && strings.EqualFold(u.Host, c.Request.Host)
				if h.cfg.Profile == bootstrap.ProfileDesktop {
					allowed = allowed || origin == "wails://wails" || origin == "http://wails.localhost" || origin == "wails://localhost" || origin == "wails://wails.localhost"
				}
				for _, v := range strings.Split(os.Getenv("CANVAS_CORS_ORIGINS"), ",") {
					if strings.TrimSpace(v) == origin {
						allowed = true
					}
				}
			}
			if !allowed {
				reply(c.Writer, 403, nil, "不允许的请求来源", "origin_denied")
				c.Abort()
				return
			}
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Vary", "Origin")
		}
		c.Header("Access-Control-Allow-Headers", "Accept, Content-Type, Authorization, X-Aihubkit-Session, X-Aihubkit-Client, X-Desktop-Token, X-Beeftv-UI-Bootstrap, X-Beeftv-Ui-Session, X-Canvas-Scene, X-Idempotency-Key, X-Canvas-Trace-ID, Traceparent, X-Canvas-Upstream-URL, X-Canvas-Upstream-Format, X-Canvas-Upstream-Base-URL, X-Canvas-Upstream-Headers")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	}
}

func reply(w http.ResponseWriter, status int, data any, message, reason string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	code := status
	if status < 300 {
		code = 0
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "data": data, "msg": message, "reason": reason})
}
func sameSecret(a, b string) bool {
	return a != "" && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
func newSession() (string, error) { return httptransport.NewLaunchToken() }
func (h *Host) authenticated(r *http.Request) bool {
	if h.active == nil || h.session == "" {
		return false
	}
	if supplied := r.Header.Get(sessionHeader); supplied != "" {
		return sameSecret(supplied, h.session)
	}
	if h.launchToken != "" && sameSecret(r.Header.Get("X-Desktop-Token"), h.launchToken) &&
		(r.Method == "GET" || r.Method == "HEAD") && strings.HasPrefix(r.URL.Path, "/api/resources/") {
		return true
	}
	cookie, err := r.Cookie(cookieName)
	return err == nil && sameSecret(cookie.Value, h.session)
}
func (h *Host) sessionData() map[string]any {
	if h.active == nil {
		return map[string]any{"enabled": true, "authenticated": false}
	}
	return map[string]any{"enabled": true, "authenticated": true, "session": h.session, "scope": "aihubkit-" + accountScope(h.client.origin, h.account.user.ID), "user": h.account.user, "groups": h.account.groups}
}

func (h *Host) serve(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/health/") {
		reply(w, 200, map[string]any{"ready": true, "status": "ok"}, "", "")
		return
	}
	if h.launchToken != "" && !sameSecret(r.Header.Get("X-Desktop-Token"), h.launchToken) {
		reply(w, 403, nil, "桌面运行时授权无效", "desktop_token_required")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, apiPrefix)
	if r.URL.Path == apiPrefix+"session" && r.Method == "GET" {
		h.mu.RLock()
		defer h.mu.RUnlock()
		if h.active != nil && !h.authenticated(r) && h.launchToken == "" {
			reply(w, 200, map[string]any{"enabled": true, "authenticated": false}, "", "")
			return
		}
		reply(w, 200, h.sessionData(), "", "")
		return
	}
	if strings.HasPrefix(r.URL.Path, apiPrefix) && (path == "login" || path == "register" || path == "verification") {
		if r.Method != "POST" || r.Header.Get("X-Aihubkit-Client") != "1" {
			reply(w, 400, nil, "请求无效", "invalid_request")
			return
		}
		h.publicAction(w, r, path)
		return
	}
	if path == "logout" && strings.HasPrefix(r.URL.Path, apiPrefix) && r.Method == "POST" {
		h.transition.Lock()
		defer h.transition.Unlock()
		h.mu.RLock()
		valid := h.authenticated(r) && sameSecret(r.Header.Get(sessionHeader), h.session)
		cancel := h.cancel
		h.mu.RUnlock()
		if !valid {
			reply(w, 401, nil, "请先登录", "aihubkit_login_required")
			return
		}
		cancel() // Cancel SSE/HTTP before waiting for readers of the old runtime.
		h.mu.Lock()
		defer h.mu.Unlock()
		ctx, stop := context.WithTimeout(context.Background(), 10*time.Minute)
		defer stop()
		if err := h.active.Close(ctx); err != nil {
			h.session = ""
			reply(w, 503, nil, "工作区仍在关闭，请重启应用后登录", "workspace_close_failed")
			return
		}
		h.active = nil
		h.account = nil
		h.session = ""
		http.SetCookie(w, &http.Cookie{Name: cookieName, Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil})
		reply(w, 200, true, "", "")
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	if !h.authenticated(r) {
		reply(w, 401, nil, "请先登录 aihubkit", "aihubkit_login_required")
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" && !sameSecret(r.Header.Get(sessionHeader), h.session) {
		reply(w, 409, nil, "账号会话已变化，请重新加载", "aihubkit_session_changed")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stop := context.AfterFunc(h.accountCtx, cancel)
	defer stop()
	r = r.Clone(ctx)
	if strings.HasPrefix(r.URL.Path, apiPrefix) {
		h.accountAction(w, r, path)
		return
	}
	r.Header.Set("X-Desktop-Token", h.active.LaunchToken())
	if sameSecret(r.Header.Get("X-Beeftv-UI-Bootstrap"), h.uiToken) {
		r.Header.Set("X-Beeftv-UI-Bootstrap", h.active.UIBootstrapToken())
	}
	h.active.Handler().ServeHTTP(w, r)
}

func decode(r *http.Request, dst any) error {
	return json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(dst)
}

func (h *Host) Handler() http.Handler { return h.handler }
func (h *Host) Start() error {
	h.transition.Lock()
	defer h.transition.Unlock()
	if h.closed {
		return errors.New("账号宿主已关闭")
	}
	if h.listener != nil {
		return nil
	}
	l, err := net.Listen("tcp", h.cfg.ListenAddr)
	if err != nil {
		return err
	}
	h.listener = l
	h.server = &http.Server{Handler: h.handler, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		err := h.server.Serve(l)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			h.reportError(errors.New("账号宿主 HTTP 服务异常退出"))
		}
	}()
	return nil
}
func (h *Host) Ready() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.active != nil && h.active.Ready()
}
func (h *Host) BaseURL() string {
	if h.listener == nil {
		return ""
	}
	return "http://" + h.listener.Addr().String() + "/api"
}
func (h *Host) LaunchToken() string      { return h.launchToken }
func (h *Host) UIBootstrapToken() string { return h.uiToken }
func (h *Host) Errors() <-chan error     { return h.errors }
func (h *Host) reportError(err error) {
	select {
	case h.errors <- err:
	default:
	}
}
func (h *Host) Close(ctx context.Context) error {
	h.transition.Lock()
	if h.closed {
		h.transition.Unlock()
		return nil
	}
	h.closed = true
	h.mu.RLock()
	if h.cancel != nil {
		h.cancel()
	}
	h.mu.RUnlock()
	h.mu.Lock()
	var err error
	if h.active != nil {
		err = h.active.Close(ctx)
		h.active = nil
	}
	h.session = ""
	h.account = nil
	h.mu.Unlock()
	h.transition.Unlock()
	if h.server != nil {
		err = errors.Join(err, h.server.Shutdown(ctx))
	}
	if h.lock != nil {
		err = errors.Join(err, h.lock.Close())
	}
	return err
}
func (h *Host) DepthComponents() *depthcapture.Service {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.active == nil {
		return nil
	}
	return h.active.DepthComponents()
}
func (h *Host) CopyOwnedResourceTo(id, dest string) error {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.active == nil {
		return errors.New("请先登录")
	}
	return h.active.CopyOwnedResourceTo(id, dest)
}
func (h *Host) WriteOwnedArchiveTo(ctx context.Context, entries []bootstrap.OwnedArchiveEntry, dest string) error {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.active == nil {
		return errors.New("请先登录")
	}
	return h.active.WriteOwnedArchiveTo(ctx, entries, dest)
}
func (h *Host) PrepareStorageMigration(ctx context.Context) (func(), error) {
	h.transition.Lock()
	defer h.transition.Unlock()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.migrating {
		return nil, errors.New("工作区正在迁移")
	}
	resume := func() {}
	if h.active != nil {
		var err error
		resume, err = h.active.PrepareStorageMigration(ctx)
		if err != nil {
			return nil, err
		}
	}
	h.migrating = true
	return func() { resume(); h.mu.Lock(); h.migrating = false; h.mu.Unlock() }, nil
}

// AcquireWorkspace fences a whole native operation against logout, including
// its staging files and settings. Delegates use the pinned inner runtime.
func (h *Host) AcquireWorkspace() (bootstrap.HostRuntime, string, func(), error) {
	h.transition.Lock()
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.account == nil || h.closed || h.migrating || h.session == "" {
		h.transition.Unlock()
		return nil, "", nil, errors.New("请先登录，或等待工作区操作结束")
	}
	return h.active, h.account.dir, h.transition.Unlock, nil
}
