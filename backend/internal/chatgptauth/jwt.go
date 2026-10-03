package chatgptauth

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

// id_token / access_token 的声明命名空间。字段名来自 Codex CLI 的
// codex-rs/login/src/token_data.rs（serde rename）。
const (
	authClaimNamespace    = "https://api.openai.com/auth"
	profileClaimNamespace = "https://api.openai.com/profile"
)

type jwtClaims struct {
	payload map[string]any
}

// parseJWTClaims 只读取载荷用于提取账号元数据。签名由 TLS 通道和上游保证，
// 本地不做校验，也绝不把令牌内容写入日志。
func parseJWTClaims(token string) (jwtClaims, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) < 2 {
		return jwtClaims{}, errInvalidToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return jwtClaims{}, errInvalidToken
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return jwtClaims{}, errInvalidToken
	}
	return jwtClaims{payload: payload}, nil
}

func (c jwtClaims) namespace(name string) map[string]any {
	if c.payload == nil {
		return nil
	}
	value, _ := c.payload[name].(map[string]any)
	return value
}

func (c jwtClaims) authValue(key string) string {
	return stringField(c.namespace(authClaimNamespace), key)
}

func (c jwtClaims) accountID() string {
	return c.authValue("chatgpt_account_id")
}

func (c jwtClaims) planType() string {
	return c.authValue("chatgpt_plan_type")
}

func (c jwtClaims) fedRAMP() bool {
	value, _ := c.namespace(authClaimNamespace)["chatgpt_account_is_fedramp"].(bool)
	return value
}

func (c jwtClaims) email() string {
	if value := stringField(c.payload, "email"); value != "" {
		return value
	}
	return stringField(c.namespace(profileClaimNamespace), "email")
}

// expiry 返回 exp 声明。令牌不是 JWT 或缺少 exp 时返回 false。
func (c jwtClaims) expiry() (time.Time, bool) {
	raw, ok := c.payload["exp"]
	if !ok {
		return time.Time{}, false
	}
	switch value := raw.(type) {
	case float64:
		return time.Unix(int64(value), 0).UTC(), true
	case json.Number:
		seconds, err := value.Int64()
		if err != nil {
			return time.Time{}, false
		}
		return time.Unix(seconds, 0).UTC(), true
	default:
		return time.Time{}, false
	}
}

func stringField(source map[string]any, key string) string {
	if source == nil {
		return ""
	}
	value, _ := source[key].(string)
	return strings.TrimSpace(value)
}
