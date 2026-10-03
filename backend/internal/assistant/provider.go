// Package assistant holds the canonical assistant-provider value, reason, and
// fingerprint contracts. Selection stays in app; process lifecycle stays in
// assistantruntime. Neither domain imports the other.
package assistant

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
)

// 助手不可用的机器可读原因；UI 按 reason 映射文案，不解析 msg。
const (
	ReasonModelNotConfigured  = "model_not_configured"
	ReasonCredentialMissing   = "credential_missing"
	ReasonProtocolUnsupported = "model_protocol_unsupported"
)

// UnavailableError 承载稳定 reason，让 handler 直接投影成契约里的状态。
type UnavailableError struct {
	Reason  string
	Message string
}

func (e *UnavailableError) Error() string {
	if e == nil {
		return ""
	}
	if strings.TrimSpace(e.Message) != "" {
		return e.Message
	}
	return e.Reason
}

// Provider 是助手宿主要用的一次性连接信息（含密钥，只在进程内传递）。
type Provider struct {
	ChannelID   string
	ChannelName string
	// Model 是渠道内的模型 id（不含 channel:: 前缀）；ModelKey 是配置里的原值。
	Model    string
	ModelKey string
	Protocol string
	BaseURL  string
	APIKey   string
	// Headers 是上游要求的额外请求头（例如订阅渠道的账号隔离头）。
	// 与 APIKey 一样只在进程内传递，不写日志、不落盘。
	Headers map[string]string
}

// Fingerprint 是「当前生效的供应商配置」的稳定指纹：变化即说明宿主环境已过期。
// 密钥只进哈希，不进任何可读输出。
func (p Provider) Fingerprint() string {
	sum := sha256.Sum256([]byte(p.APIKey))
	// 额外请求头（例如账号 id）变化时宿主必须重启，因此一并纳入指纹。
	headerKeys := make([]string, 0, len(p.Headers))
	for key := range p.Headers {
		headerKeys = append(headerKeys, key)
	}
	sort.Strings(headerKeys)
	headerParts := make([]string, 0, len(headerKeys))
	for _, key := range headerKeys {
		headerSum := sha256.Sum256([]byte(p.Headers[key]))
		headerParts = append(headerParts, key+"="+hex.EncodeToString(headerSum[:]))
	}
	digest := sha256.Sum256([]byte(strings.Join([]string{
		p.ChannelID, p.Model, p.BaseURL, p.Protocol, hex.EncodeToString(sum[:]),
		strings.Join(headerParts, ","),
	}, "\x00")))
	return hex.EncodeToString(digest[:])
}
