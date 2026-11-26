// Package assistant holds the canonical assistant-provider value, reason, and
// fingerprint contracts. Selection stays in app; process lifecycle stays in
// assistantruntime. Neither domain imports the other.
package assistant

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/outbound"
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
	Model         string
	ModelKey      string
	Protocol      string
	BaseURL       string
	APIKey        string
	Headers       []outbound.OutboundHeader
	ContextWindow int
	MaxTokens     int
}

// Fingerprint 是「当前生效的供应商配置」的稳定指纹：变化即说明宿主环境已过期。
// 密钥与自定义请求头只进哈希，不进任何可读输出。
func (p Provider) Fingerprint() string {
	sum := sha256.Sum256([]byte(p.APIKey))
	parts := []string{
		p.ChannelID, p.Model, p.BaseURL, p.Protocol, hex.EncodeToString(sum[:]),
		strconv.Itoa(p.ContextWindow), strconv.Itoa(p.MaxTokens),
	}
	for _, header := range p.Headers {
		hSum := sha256.Sum256([]byte(header.Name + "\x01" + header.Value))
		parts = append(parts, hex.EncodeToString(hSum[:]))
	}
	digest := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(digest[:])
}
