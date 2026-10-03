package chatgptauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// errDevicePending 表示设备码尚未被用户确认，调用方应继续轮询。
var errDevicePending = errors.New("device authorization pending")

// errRefreshRejected 表示 refresh_token 已被上游永久拒绝。
var errRefreshRejected = errors.New("refresh token rejected")

const oauthBodyLimit int64 = 1 << 20

// jsonNumberOrString 兼容上游把 interval 作为字符串下发的情况。
type jsonNumberOrString int

func (n *jsonNumberOrString) UnmarshalJSON(data []byte) error {
	trimmed := strings.Trim(strings.TrimSpace(string(data)), `"`)
	if trimmed == "" || trimmed == "null" {
		*n = 0
		return nil
	}
	value, err := strconv.Atoi(trimmed)
	if err != nil {
		return err
	}
	*n = jsonNumberOrString(value)
	return nil
}

type deviceCodeResponse struct {
	DeviceAuthID string             `json:"device_auth_id"`
	UserCode     string             `json:"user_code"`
	UserCodeAlt  string             `json:"usercode"`
	Interval     jsonNumberOrString `json:"interval"`
}

type deviceTokenResponse struct {
	AuthorizationCode string `json:"authorization_code"`
	CodeChallenge     string `json:"code_challenge"`
	CodeVerifier      string `json:"code_verifier"`
}

type tokenResponse struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

type oauthErrorBody struct {
	Error            any    `json:"error"`
	ErrorDescription string `json:"error_description"`
}

func (e oauthErrorBody) code() string {
	switch value := e.Error.(type) {
	case string:
		return strings.TrimSpace(value)
	case map[string]any:
		if code, _ := value["code"].(string); strings.TrimSpace(code) != "" {
			return strings.TrimSpace(code)
		}
		if value["message"] != nil {
			return strings.TrimSpace(fmt.Sprint(value["message"]))
		}
	}
	return strings.TrimSpace(e.ErrorDescription)
}

// deviceCodeStart 申请设备码与用户码。
func (s *Service) deviceCodeStart(ctx context.Context) (deviceCodeResponse, error) {
	payload, err := json.Marshal(map[string]string{"client_id": s.clientID})
	if err != nil {
		return deviceCodeResponse{}, err
	}
	var response deviceCodeResponse
	status, body, err := s.postJSON(ctx, s.issuer+"/api/accounts/deviceauth/usercode", payload)
	if err != nil {
		return deviceCodeResponse{}, err
	}
	if status == http.StatusNotFound {
		return deviceCodeResponse{}, errors.New("当前授权源未启用设备码登录")
	}
	if status >= 300 {
		return deviceCodeResponse{}, fmt.Errorf("申请 ChatGPT 设备码失败（HTTP %d）", status)
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return deviceCodeResponse{}, errors.New("ChatGPT 设备码响应无效")
	}
	response.UserCode = firstNonEmpty(response.UserCode, response.UserCodeAlt)
	if strings.TrimSpace(response.DeviceAuthID) == "" || strings.TrimSpace(response.UserCode) == "" {
		return deviceCodeResponse{}, errors.New("ChatGPT 设备码响应缺少必要字段")
	}
	return response, nil
}

// deviceTokenPoll 轮询一次设备码。未确认时返回 errDevicePending。
func (s *Service) deviceTokenPoll(ctx context.Context, deviceAuthID, userCode string) (deviceTokenResponse, error) {
	payload, err := json.Marshal(map[string]string{"device_auth_id": deviceAuthID, "user_code": userCode})
	if err != nil {
		return deviceTokenResponse{}, err
	}
	status, body, err := s.postJSON(ctx, s.issuer+"/api/accounts/deviceauth/token", payload)
	if err != nil {
		return deviceTokenResponse{}, err
	}
	if status == http.StatusForbidden || status == http.StatusNotFound {
		return deviceTokenResponse{}, errDevicePending
	}
	if status >= 300 {
		return deviceTokenResponse{}, fmt.Errorf("ChatGPT 设备码确认失败（HTTP %d）", status)
	}
	var response deviceTokenResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return deviceTokenResponse{}, errors.New("ChatGPT 设备码确认响应无效")
	}
	if strings.TrimSpace(response.AuthorizationCode) == "" {
		return deviceTokenResponse{}, errors.New("ChatGPT 设备码确认响应缺少授权码")
	}
	return response, nil
}

// exchangeAuthorizationCode 用授权码和上游下发的 PKCE 值换取令牌。
func (s *Service) exchangeAuthorizationCode(ctx context.Context, code, codeVerifier string) (tokenSet, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", s.clientID)
	form.Set("code", code)
	form.Set("redirect_uri", s.issuer+"/deviceauth/callback")
	if strings.TrimSpace(codeVerifier) != "" {
		form.Set("code_verifier", codeVerifier)
	}
	status, body, err := s.postForm(ctx, s.issuer+"/oauth/token", form.Encode())
	if err != nil {
		return tokenSet{}, err
	}
	if status >= 300 {
		return tokenSet{}, fmt.Errorf("ChatGPT 授权码换取令牌失败：%s", oauthFailureReason(body))
	}
	var response tokenResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return tokenSet{}, errors.New("ChatGPT 令牌响应无效")
	}
	if strings.TrimSpace(response.AccessToken) == "" || strings.TrimSpace(response.RefreshToken) == "" {
		return tokenSet{}, errors.New("ChatGPT 令牌响应缺少 access_token 或 refresh_token")
	}
	return s.tokenSetFromResponse(response, ""), nil
}

// refreshAccessToken 用 refresh_token 换取新的 access_token。
func (s *Service) refreshAccessToken(ctx context.Context, refreshToken string) (tokenSet, error) {
	payload, err := json.Marshal(map[string]string{
		"grant_type":    "refresh_token",
		"client_id":     s.clientID,
		"refresh_token": refreshToken,
	})
	if err != nil {
		return tokenSet{}, err
	}
	status, body, err := s.postJSON(ctx, s.issuer+"/oauth/token", payload)
	if err != nil {
		return tokenSet{}, err
	}
	if status == http.StatusUnauthorized || status == http.StatusBadRequest {
		return tokenSet{}, fmt.Errorf("%w：%s", errRefreshRejected, oauthFailureReason(body))
	}
	if status >= 300 {
		return tokenSet{}, fmt.Errorf("刷新 ChatGPT 订阅令牌失败（HTTP %d）", status)
	}
	var response tokenResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return tokenSet{}, errors.New("ChatGPT 刷新响应无效")
	}
	if strings.TrimSpace(response.AccessToken) == "" {
		return tokenSet{}, errors.New("ChatGPT 刷新响应缺少 access_token")
	}
	return s.tokenSetFromResponse(response, refreshToken), nil
}

// revokeToken 尽力撤销 refresh_token。失败不影响本地断开。
func (s *Service) revokeToken(ctx context.Context, token string) error {
	if strings.TrimSpace(token) == "" {
		return nil
	}
	payload, err := json.Marshal(map[string]string{
		"token": token, "token_type_hint": "refresh_token", "client_id": s.clientID,
	})
	if err != nil {
		return err
	}
	status, _, err := s.postJSON(ctx, s.issuer+"/oauth/revoke", payload)
	if err != nil {
		return err
	}
	if status >= 300 {
		return fmt.Errorf("撤销 ChatGPT 订阅令牌失败（HTTP %d）", status)
	}
	return nil
}

// tokenSetFromResponse 用令牌响应构造内存令牌集合；refresh_token 缺失时沿用旧值。
func (s *Service) tokenSetFromResponse(response tokenResponse, previousRefresh string) tokenSet {
	tokens := tokenSet{
		AccessToken:  strings.TrimSpace(response.AccessToken),
		RefreshToken: firstNonEmpty(strings.TrimSpace(response.RefreshToken), previousRefresh),
		IDToken:      strings.TrimSpace(response.IDToken),
		ConnectedAt:  s.now(),
	}
	claims, err := parseJWTClaims(tokens.IDToken)
	if err != nil {
		claims, err = parseJWTClaims(tokens.AccessToken)
	}
	if err == nil {
		tokens.AccountID = claims.accountID()
		tokens.PlanType = claims.planType()
		tokens.Email = claims.email()
		tokens.FedRAMP = claims.fedRAMP()
	}
	return tokens
}

func oauthFailureReason(body []byte) string {
	var parsed oauthErrorBody
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "上游拒绝了本次授权"
	}
	if code := parsed.code(); code != "" {
		return sanitizeOAuthReason(code)
	}
	return "上游拒绝了本次授权"
}

// sanitizeOAuthReason 只保留可安全展示的简短错误码，避免把上游原文写入日志或响应。
func sanitizeOAuthReason(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) > 120 {
		trimmed = trimmed[:120]
	}
	for _, r := range trimmed {
		if r < 32 || r == 127 {
			return "上游拒绝了本次授权"
		}
	}
	return trimmed
}

func (s *Service) postJSON(ctx context.Context, endpoint string, payload []byte) (int, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	return s.do(request)
}

func (s *Service) postForm(ctx context.Context, endpoint string, encoded string) (int, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(encoded))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	return s.do(request)
}

func (s *Service) do(request *http.Request) (int, []byte, error) {
	response, err := s.httpClient.Do(request)
	if err != nil {
		return 0, nil, errors.New("无法连接 ChatGPT 授权服务")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, oauthBodyLimit))
	if err != nil {
		return response.StatusCode, nil, errors.New("读取 ChatGPT 授权响应失败")
	}
	return response.StatusCode, body, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
