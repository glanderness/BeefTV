package aihubkit

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/bootstrap"
)

func (h *Host) publicAction(w http.ResponseWriter, r *http.Request, path string) {
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Email    string `json:"email"`
		Code     string `json:"verification_code"`
		AffCode  string `json:"aff_code"`
	}
	if decode(r, &input) != nil {
		reply(w, 400, nil, "输入格式无效", "invalid_request")
		return
	}
	if path != "login" {
		var err error
		if path == "verification" {
			err = h.client.call(ctx, "GET", "/api/verification?email="+url.QueryEscape(input.Email), nil, "", 0, nil)
		} else {
			err = h.client.call(ctx, "POST", "/api/user/register", map[string]string{"username": input.Username, "password": input.Password, "email": input.Email, "verification_code": input.Code, "aff_code": input.AffCode}, "", 0, nil)
		}
		if err != nil {
			reply(w, 400, nil, err.Error(), "aihubkit_account_failed")
			return
		}
		reply(w, 200, true, "", "")
		return
	}
	h.transition.Lock()
	defer h.transition.Unlock()
	h.mu.RLock()
	busy := h.active != nil || h.closed || h.migrating
	h.mu.RUnlock()
	if busy {
		reply(w, 409, nil, "此工作台已有账号运行，请先退出当前账号", "workspace_in_use")
		return
	}
	if strings.TrimSpace(input.Username) == "" || input.Password == "" {
		reply(w, 400, nil, "请输入用户名和密码", "invalid_request")
		return
	}
	user, token, err := h.client.login(ctx, input.Username, input.Password)
	if err != nil {
		reply(w, 401, nil, err.Error(), "aihubkit_login_failed")
		return
	}
	a := &account{client: h.client, user: user, token: token, dir: filepath.Join(h.cfg.DataDir, "aihubkit", "accounts", accountScope(h.client.origin, user.ID))}
	if err = a.prepare(ctx); err != nil {
		reply(w, 502, nil, err.Error(), "aihubkit_credentials_failed")
		return
	}
	cfg := h.cfg
	// The inner listener is independently token protected. Browser traffic
	// always crosses this gate; only the official assistant uses it directly.
	cfg.Profile = bootstrap.ProfileDesktop
	cfg.DataDir = a.dir
	cfg.ListenAddr = "127.0.0.1:0"
	cfg.LaunchToken = ""
	cfg.RouterMiddleware = nil
	cfg.ConfigureService = a.configure
	inner, err := bootstrap.Open(ctx, cfg)
	if err == nil {
		err = inner.Start()
	}
	if err != nil {
		if inner != nil {
			_ = inner.Close(context.Background())
		}
		reply(w, 503, nil, "账号工作区启动失败，请检查本地数据目录", "workspace_open_failed")
		return
	}
	session, err := newSession()
	if err != nil {
		_ = inner.Close(context.Background())
		reply(w, 500, nil, "无法创建登录会话", "session_failed")
		return
	}
	h.mu.Lock()
	h.active = inner
	h.account = a
	h.session = session
	h.accountCtx, h.cancel = context.WithCancel(context.Background())
	accountCtx := h.accountCtx
	data := h.sessionData()
	h.mu.Unlock()
	go func() {
		select {
		case err, ok := <-inner.Errors():
			if ok && err != nil && accountCtx.Err() == nil {
				h.reportError(errors.New("账号工作区 HTTP 服务异常退出，请重启应用"))
			}
		case <-accountCtx.Done():
		}
	}()
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: session, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil})
	reply(w, 200, data, "", "")
}

func (h *Host) accountAction(w http.ResponseWriter, r *http.Request, path string) {
	a := h.account
	var result any
	var err error
	switch {
	case path == "self" && r.Method == "GET":
		var user User
		err = a.client.call(r.Context(), "GET", "/api/user/self", nil, a.token, a.user.ID, &user)
		if err == nil && (user.ID != a.user.ID || user.Status != 1) {
			err = errors.New("账号状态已变化，请退出后重新登录")
		}
		result = user
	case path == "logs" && r.Method == "GET":
		query := url.Values{}
		for _, key := range []string{"p", "page_size", "start_timestamp", "end_timestamp"} {
			if v := r.URL.Query().Get(key); v != "" {
				if _, e := strconv.ParseInt(v, 10, 64); e != nil {
					reply(w, 400, nil, "分页或时间参数无效", "invalid_request")
					return
				}
				query.Set(key, v)
			}
		}
		var logs usagePage
		err = a.client.call(r.Context(), "GET", "/api/log/self?"+query.Encode(), nil, a.token, a.user.ID, &logs)
		result = logs
	case path == "topup" && r.Method == "POST":
		var input struct {
			Key string `json:"key"`
		}
		if decode(r, &input) != nil || strings.TrimSpace(input.Key) == "" {
			reply(w, 400, nil, "请输入兑换码", "invalid_request")
			return
		}
		err = a.client.call(r.Context(), "POST", "/api/user/topup", map[string]string{"key": input.Key}, a.token, a.user.ID, &result)
	case path == "catalog" && r.Method == "POST":
		var input struct {
			Group string `json:"group"`
		}
		if decode(r, &input) != nil {
			reply(w, 400, nil, "分组无效", "invalid_request")
			return
		}
		err = a.ensureKey(r.Context(), input.Group)
		if err == nil {
			var models []CatalogModel
			_, key, _, _ := a.resolve(credentialPrefix + input.Group)
			err = a.client.call(r.Context(), "GET", "/v1/models", nil, key, 0, &models)
			if err == nil {
				result = models
			}
		}
	default:
		reply(w, 404, nil, "接口不存在", "not_found")
		return
	}
	if err != nil {
		reply(w, 502, nil, err.Error(), "aihubkit_request_failed")
		return
	}
	reply(w, 200, result, "", "")
}

// Never expose remote IP addresses or internal provider diagnostics to the UI.
type usagePage struct {
	Page     int `json:"page"`
	PageSize int `json:"page_size"`
	Total    int `json:"total"`
	Items    []struct {
		ID               int    `json:"id"`
		CreatedAt        int64  `json:"created_at"`
		Type             int    `json:"type"`
		ModelName        string `json:"model_name"`
		Quota            int64  `json:"quota"`
		PromptTokens     int    `json:"prompt_tokens"`
		CompletionTokens int    `json:"completion_tokens"`
		UseTime          int    `json:"use_time"`
		Group            string `json:"group"`
	} `json:"items"`
}
