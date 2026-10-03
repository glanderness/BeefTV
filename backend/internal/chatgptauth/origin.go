// Package chatgptauth 实现 ChatGPT 订阅（Plus/Pro）的设备码 OAuth 登录、令牌刷新
// 和按用户隔离的本地令牌存储。它只负责凭据本身，不参与模型协议和渠道路由。
//
// 该流程复刻 OpenAI Codex CLI 使用的公开端点；ChatGPT 订阅没有官方 API，这些端点
// 未公开且可能随时变化。部署者必须自行确认账号使用条款。
package chatgptauth

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
)

const (
	// ProductionIssuer 是唯一允许的正式授权源。
	ProductionIssuer = "https://auth.openai.com"
	// CodexClientID 与 OpenAI Codex CLI 使用的公开 OAuth 客户端一致。
	CodexClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
	// CodexBaseURL 是 ChatGPT 订阅后端的模型接口根地址。
	CodexBaseURL = "https://chatgpt.com/backend-api/codex"
	// CredentialRef 是渠道配置中的托管凭据标记，与具体用户无关。
	CredentialRef = "chatgpt-subscription"

	IssuerEnvVar   = "CANVAS_CHATGPT_AUTH_ISSUER"
	ClientIDEnvVar = "CANVAS_CHATGPT_CLIENT_ID"
)

// CanonicalIssuer 收敛授权源：默认只允许正式源，只有显式配置的环回测试源可以在
// 本地验证中替换，避免把任意主机变成凭据出口。
func CanonicalIssuer(explicit string) (string, error) {
	candidate := strings.TrimRight(strings.TrimSpace(explicit), "/")
	if candidate == "" {
		candidate = strings.TrimRight(strings.TrimSpace(os.Getenv(IssuerEnvVar)), "/")
	}
	if candidate == "" || strings.EqualFold(candidate, ProductionIssuer) {
		return ProductionIssuer, nil
	}
	origin, err := parseSafeTestIssuer(candidate)
	if err != nil {
		return "", err
	}
	return origin, nil
}

func parseSafeTestIssuer(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("ChatGPT 授权测试源地址无效")
	}
	if parsed.User != nil || parsed.Opaque != "" || strings.Trim(parsed.Path, "/") != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("ChatGPT 授权测试源地址只能是纯源地址")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("ChatGPT 授权测试源地址只支持 HTTP 或 HTTPS")
	}
	if !IsLoopbackHost(parsed.Hostname()) {
		return "", fmt.Errorf("ChatGPT 授权测试源地址只能是本机环回地址")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

// IsLoopbackHost 判定主机是否为本机环回地址。
func IsLoopbackHost(host string) bool {
	trimmed := strings.Trim(strings.TrimSpace(host), "[]")
	if trimmed == "" {
		return false
	}
	if strings.EqualFold(trimmed, "localhost") {
		return true
	}
	if ip := net.ParseIP(trimmed); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// ClientID 返回生效的 OAuth 客户端标识。
func ClientID() string {
	if override := strings.TrimSpace(os.Getenv(ClientIDEnvVar)); override != "" {
		return override
	}
	return CodexClientID
}
