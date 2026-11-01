// Package aihubkit contains the optional account and storage integration. It
// deliberately does not replace the official provider/plugin implementations.
package aihubkit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

const Origin = "https://apimodel.aihubkit.com"
const credentialPrefix = "aihubkit:"

type User struct {
	ID          int    `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Group       string `json:"group"`
	Status      int    `json:"status"`
	Quota       int64  `json:"quota"`
	UsedQuota   int64  `json:"used_quota"`
}
type Group struct {
	Desc  string  `json:"desc"`
	Ratio float64 `json:"ratio"`
}
type CatalogModel struct {
	ID        string   `json:"id"`
	Type      string   `json:"model_type"`
	Endpoints []string `json:"supported_endpoint_types"`
}
type client struct {
	origin     string
	http       *http.Client
	uploadHTTP *http.Client
}

func newClient() *client {
	h := outbound.OutboundHTTPClient(45 * time.Second)
	h.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	uploadHTTP := outbound.OutboundHTTPClient(10 * time.Minute)
	uploadHTTP.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &client{origin: Origin, http: h, uploadHTTP: uploadHTTP}
}

// Remote error bodies and transport errors may contain credentials or signed
// URLs. Only bounded, structured data from successful responses crosses here.
func (c *client) call(ctx context.Context, method, path string, payload any, token string, userID int, result any) error {
	var body io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	r, err := http.NewRequestWithContext(ctx, method, c.origin+path, body)
	if err != nil {
		return errors.New("aihubkit 请求无效")
	}
	r.Header.Set("Accept", "application/json")
	if payload != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if userID > 0 {
		r.Header.Set("New-Api-User", strconv.Itoa(userID))
	}
	resp, err := c.http.Do(r)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("无法连接 aihubkit，请稍后重试")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errors.New("aihubkit 拒绝请求，请检查账号权限、凭据和额度")
	}
	var envelope struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
		Object  string          `json:"object"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&envelope); err != nil {
		return errors.New("aihubkit 响应格式无效")
	}
	if !envelope.Success && envelope.Object != "list" {
		return errors.New("aihubkit 操作未成功，请检查输入、账号状态或稍后重试")
	}
	if result != nil && json.Unmarshal(envelope.Data, result) != nil {
		return errors.New("aihubkit 响应数据无效")
	}
	return nil
}

func (c *client) login(ctx context.Context, username, password string) (User, string, error) {
	// The dashboard session is used only to acquire the management token. It is
	// never copied to the WebView or the general-purpose object upload client.
	jar, _ := cookiejar.New(nil)
	loginHTTP := *c.http
	loginHTTP.Jar = jar
	loginClient := &client{origin: c.origin, http: &loginHTTP}
	var user User
	err := loginClient.call(ctx, "POST", "/api/user/login", map[string]string{"username": username, "password": password}, "", 0, &user)
	if err != nil {
		return User{}, "", err
	}
	if user.ID <= 0 || user.Status != 1 {
		return User{}, "", errors.New("账号不可用，或该账号需要其他登录验证")
	}
	var token string
	if err := loginClient.call(ctx, "GET", "/api/user/token", nil, "", user.ID, &token); err != nil {
		return User{}, "", err
	}
	if strings.TrimSpace(token) == "" {
		return User{}, "", errors.New("未取得账号管理凭据")
	}
	return user, token, nil
}
