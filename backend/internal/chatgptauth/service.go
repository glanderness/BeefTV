package chatgptauth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// deviceLoginTimeout 与 Codex CLI 一致：设备码最长等待 15 分钟。
	deviceLoginTimeout = 15 * time.Minute
	// accessTokenRefreshWindow 在 access_token 到期前提前刷新。
	accessTokenRefreshWindow = 5 * time.Minute
	// refreshFallbackInterval 在无法解析 access_token 到期时间时的兜底刷新周期。
	refreshFallbackInterval = 8 * 24 * time.Hour

	defaultPollInterval = 5 * time.Second
	minPollInterval     = time.Second
	maxPollInterval     = 30 * time.Second
)

type Options struct {
	DataDir    string
	Issuer     string
	ClientID   string
	HTTPClient *http.Client
	Now        func() time.Time
}

type pendingLogin struct {
	deviceAuthID    string
	userCode        string
	verificationURI string
	expiresAt       time.Time
	interval        time.Duration
	cancel          context.CancelFunc
}

// Service 管理 ChatGPT 订阅的设备码登录、令牌刷新和本地加密存储。
// 令牌按工作区用户隔离，任何 Summary 都不会暴露令牌本身。
type Service struct {
	dataDir    string
	issuer     string
	clientID   string
	httpClient *http.Client
	now        func() time.Time

	mu         sync.Mutex
	state      persistedState
	pending    map[string]*pendingLogin
	lastErrors map[string]string
	closed     bool
}

func New(opts Options) (*Service, error) {
	dataDir := strings.TrimSpace(opts.DataDir)
	if dataDir == "" {
		return nil, errors.New("本地工作区数据目录不能为空")
	}
	issuer, err := CanonicalIssuer(opts.Issuer)
	if err != nil {
		return nil, err
	}
	clientID := strings.TrimSpace(opts.ClientID)
	if clientID == "" {
		clientID = ClientID()
	}
	state, err := loadState(dataDir)
	if err != nil {
		return nil, err
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		dataDir: dataDir, issuer: issuer, clientID: clientID, httpClient: httpClient,
		now: now, state: state,
		pending: map[string]*pendingLogin{}, lastErrors: map[string]string{},
	}, nil
}

func (s *Service) Issuer() string { return s.issuer }

// Close 停止所有后台设备码轮询。
func (s *Service) Close() error {
	s.mu.Lock()
	s.closed = true
	for _, login := range s.pending {
		login.cancel()
	}
	s.pending = map[string]*pendingLogin{}
	s.lastErrors = map[string]string{}
	s.mu.Unlock()
	return nil
}

// Status 返回指定用户的连接摘要。
func (s *Service) Status(userID string) Summary {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked(userID)
}

func (s *Service) statusLocked(userID string) Summary {
	if login, ok := s.pending[userID]; ok {
		return Summary{
			State: StatePending, UserCode: login.userCode,
			VerificationURI: login.verificationURI, ExpiresAt: formatTime(login.expiresAt),
			CredentialRef: CredentialRef,
		}
	}
	if reason := s.lastErrors[userID]; reason != "" {
		return Summary{State: StateError, ErrorReason: reason, CredentialRef: CredentialRef}
	}
	user, ok := s.state.Users[userID]
	if !ok {
		return Summary{State: StateDisconnected}
	}
	state := StateConnected
	if user.Revoked {
		state = StateRevoked
	}
	return Summary{
		State: state, AccountID: user.AccountID, PlanType: user.PlanType, Email: user.Email,
		ConnectedAt: user.ConnectedAt, CredentialRef: CredentialRef, HasCredential: true,
	}
}

// Start 申请设备码并启动后台轮询。返回的摘要包含 user_code 和验证地址。
func (s *Service) Start(ctx context.Context, userID string) (Summary, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return Summary{}, errors.New("缺少工作区用户标识")
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return Summary{}, errors.New("ChatGPT 订阅服务已关闭")
	}
	if _, exists := s.pending[userID]; exists {
		summary := s.statusLocked(userID)
		s.mu.Unlock()
		return summary, nil
	}
	s.mu.Unlock()

	response, err := s.deviceCodeStart(ctx)
	if err != nil {
		return Summary{}, err
	}
	interval := clampInterval(time.Duration(int(response.Interval)) * time.Second)
	loginCtx, cancel := context.WithCancel(context.Background())
	login := &pendingLogin{
		deviceAuthID: response.DeviceAuthID, userCode: response.UserCode,
		verificationURI: s.issuer + "/codex/device",
		expiresAt:       s.now().Add(deviceLoginTimeout),
		interval:        interval, cancel: cancel,
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		cancel()
		return Summary{}, errors.New("ChatGPT 订阅服务已关闭")
	}
	delete(s.lastErrors, userID)
	s.pending[userID] = login
	summary := s.statusLocked(userID)
	s.mu.Unlock()

	go s.runDeviceLogin(loginCtx, userID, response.DeviceAuthID, response.UserCode, interval)
	return summary, nil
}

// Cancel 取消指定用户正在进行的设备码登录。
func (s *Service) Cancel(userID string) Summary {
	s.mu.Lock()
	defer s.mu.Unlock()
	if login, ok := s.pending[userID]; ok {
		login.cancel()
		delete(s.pending, userID)
	}
	delete(s.lastErrors, userID)
	return s.statusLocked(userID)
}

// Disconnect 撤销并删除指定用户的本地令牌。
func (s *Service) Disconnect(ctx context.Context, userID string) (Summary, error) {
	s.mu.Lock()
	if login, ok := s.pending[userID]; ok {
		login.cancel()
		delete(s.pending, userID)
	}
	user, hasUser := s.state.Users[userID]
	delete(s.state.Users, userID)
	saveErr := s.persistLocked()
	summary := s.statusLocked(userID)
	s.mu.Unlock()

	if hasUser {
		if tokens, err := decodeUser(s.dataDir, user); err == nil {
			// 上游撤销失败不应阻止本地断开。
			_ = s.revokeToken(ctx, tokens.RefreshToken)
		}
	}
	if saveErr != nil {
		return summary, saveErr
	}
	return summary, nil
}

// HasCredential 报告指定用户是否存在已保存的令牌。
func (s *Service) HasCredential(userID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	user, ok := s.state.Users[userID]
	return ok && !user.Revoked
}

// IsCredentialError 报告错误是否表示本地凭据缺失或已失效。
// 调用方据此区分「需要用户重新连接」和「上游暂时不可用」。
func IsCredentialError(err error) bool {
	return errors.Is(err, errNotConnected) || errors.Is(err, errConnectionLost)
}

// AccessToken 返回一次模型调用可用的短期凭据，必要时先刷新。
func (s *Service) AccessToken(ctx context.Context, userID string) (Credential, error) {
	tokens, lastRefresh, revoked, err := s.snapshot(userID)
	if err != nil {
		return Credential{}, err
	}
	if revoked {
		return Credential{}, errConnectionLost
	}
	if !s.needsRefresh(tokens, lastRefresh) {
		return credentialOf(tokens), nil
	}
	refreshed, err := s.refreshAccessToken(ctx, tokens.RefreshToken)
	if err != nil {
		if errors.Is(err, errRefreshRejected) {
			s.markRevoked(userID)
			return Credential{}, errConnectionLost
		}
		return Credential{}, err
	}
	// 刷新响应可能省略 id_token；沿用已知的账号元数据。
	if refreshed.AccountID == "" {
		refreshed.AccountID = tokens.AccountID
		refreshed.PlanType = tokens.PlanType
		refreshed.Email = tokens.Email
		refreshed.FedRAMP = tokens.FedRAMP
	}
	if refreshed.ConnectedAt.IsZero() {
		refreshed.ConnectedAt = tokens.ConnectedAt
	}
	if err := s.storeTokens(userID, refreshed); err != nil {
		return Credential{}, err
	}
	return credentialOf(refreshed), nil
}

func (s *Service) snapshot(userID string) (tokenSet, time.Time, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	user, ok := s.state.Users[userID]
	if !ok {
		return tokenSet{}, time.Time{}, false, errNotConnected
	}
	if user.Revoked {
		return tokenSet{}, time.Time{}, true, nil
	}
	tokens, err := decodeUser(s.dataDir, user)
	if err != nil {
		return tokenSet{}, time.Time{}, false, err
	}
	if strings.TrimSpace(tokens.RefreshToken) == "" {
		return tokenSet{}, time.Time{}, false, errNotConnected
	}
	return tokens, parseTime(user.LastRefresh), false, nil
}

func (s *Service) needsRefresh(tokens tokenSet, lastRefresh time.Time) bool {
	if claims, err := parseJWTClaims(tokens.AccessToken); err == nil {
		if expiry, ok := claims.expiry(); ok {
			return !expiry.After(s.now().Add(accessTokenRefreshWindow))
		}
	}
	if lastRefresh.IsZero() {
		return true
	}
	return s.now().Sub(lastRefresh) >= refreshFallbackInterval
}

func (s *Service) storeTokens(userID string, tokens tokenSet) error {
	encoded, err := encodeUser(s.dataDir, tokens, s.now())
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.Users[userID] = encoded
	return s.persistLocked()
}

func (s *Service) markRevoked(userID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	user, ok := s.state.Users[userID]
	if !ok {
		return
	}
	user.Revoked = true
	user.AccessToken = ""
	user.RefreshToken = ""
	user.IDToken = ""
	s.state.Users[userID] = user
	_ = s.persistLocked()
}

func (s *Service) persistLocked() error {
	return saveState(s.dataDir, s.state)
}

func (s *Service) runDeviceLogin(ctx context.Context, userID, deviceAuthID, userCode string, interval time.Duration) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
		if s.loginExpired(userID) {
			s.finishPending(userID, "设备码已过期，请重新发起连接")
			return
		}
		result, err := s.deviceTokenPoll(ctx, deviceAuthID, userCode)
		if err == nil {
			s.completeDeviceLogin(ctx, userID, result)
			return
		}
		if errors.Is(err, errDevicePending) {
			continue
		}
		if ctx.Err() != nil {
			return
		}
		s.finishPending(userID, "设备码确认失败，请重试")
		return
	}
}

func (s *Service) loginExpired(userID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	login, ok := s.pending[userID]
	if !ok {
		return true
	}
	return !s.now().Before(login.expiresAt)
}

func (s *Service) completeDeviceLogin(ctx context.Context, userID string, result deviceTokenResponse) {
	tokens, err := s.exchangeAuthorizationCode(ctx, result.AuthorizationCode, result.CodeVerifier)
	if err != nil {
		s.finishPending(userID, "授权码换取令牌失败，请重新连接")
		return
	}
	if strings.TrimSpace(tokens.RefreshToken) == "" {
		s.finishPending(userID, "授权响应缺少刷新令牌，请重新连接")
		return
	}
	encoded, err := encodeUser(s.dataDir, tokens, s.now())
	if err != nil {
		s.finishPending(userID, "保存 ChatGPT 订阅凭据失败")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.pending, userID)
	s.state.Users[userID] = encoded
	_ = s.persistLocked()
}

func (s *Service) finishPending(userID, reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if login, ok := s.pending[userID]; ok {
		login.cancel()
	}
	delete(s.pending, userID)
	s.lastErrors[userID] = reason
}

func credentialOf(tokens tokenSet) Credential {
	return Credential{
		AccessToken: tokens.AccessToken, AccountID: tokens.AccountID,
		PlanType: tokens.PlanType, FedRAMP: tokens.FedRAMP,
	}
}

func clampInterval(value time.Duration) time.Duration {
	if value < minPollInterval {
		return defaultPollInterval
	}
	if value > maxPollInterval {
		return maxPollInterval
	}
	return value
}
