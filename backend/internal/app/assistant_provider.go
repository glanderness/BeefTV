package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
)

// 内置创作助手的模型解析：用户在设置里选的是「渠道内的某个模型」，
// 因此凭据必须按该渠道解析（托管 BeefAPI 走已连接的企业凭据，自建渠道用自己的 key），
// 而不是读顶层 apiKey —— 顶层在托管形态下永远是空串。

// 助手不可用的机器可读原因；UI 按 reason 映射文案，不解析 msg。
const (
	AssistantReasonModelNotConfigured  = "model_not_configured"
	AssistantReasonCredentialMissing   = "credential_missing"
	AssistantReasonProtocolUnsupported = "model_protocol_unsupported"
)

// AssistantUnavailableError 承载稳定 reason，让 handler 直接投影成契约里的状态。
type AssistantUnavailableError struct {
	Reason  string
	Message string
}

func (e *AssistantUnavailableError) Error() string {
	if strings.TrimSpace(e.Message) != "" {
		return e.Message
	}
	return e.Reason
}

func assistantUnavailable(reason, message string) error {
	return &AssistantUnavailableError{Reason: reason, Message: message}
}

// AssistantProvider 是助手宿主要用的一次性连接信息（含密钥，只在进程内传递）。
type AssistantProvider struct {
	ChannelID   string
	ChannelName string
	// Model 是渠道内的模型 id（不含 channel:: 前缀）；ModelKey 是配置里的原值。
	Model    string
	ModelKey string
	Protocol string
	BaseURL  string
	APIKey   string
}

// Fingerprint 是「当前生效的供应商配置」的稳定指纹：变化即说明宿主环境已过期。
// 密钥只进哈希，不进任何可读输出。
func (p AssistantProvider) Fingerprint() string {
	sum := sha256.Sum256([]byte(p.APIKey))
	digest := sha256.Sum256([]byte(strings.Join([]string{
		p.ChannelID, p.Model, p.BaseURL, p.Protocol, hex.EncodeToString(sum[:]),
	}, "\x00")))
	return hex.EncodeToString(digest[:])
}

// assistantProtocols 是助手会话支持的文本协议。配置里历史上同时出现
// "responses" 与 "openai-response" 两种写法，这里都接受并归一。
var assistantProtocols = map[string]string{
	"chat-completion": "chat-completion",
	"claude-api":      "claude-api",
	"responses":       "responses",
	"openai-response": "responses",
}

type assistantModelProfile struct {
	Model      string `json:"model"`
	Capability string `json:"capability"`
	Protocol   string `json:"protocol"`
}

type assistantChannel struct {
	ID            string                  `json:"id"`
	Name          string                  `json:"name"`
	BaseURL       string                  `json:"baseUrl"`
	APIKey        string                  `json:"apiKey"`
	CredentialRef string                  `json:"credentialRef"`
	Enabled       bool                    `json:"enabled"`
	ModelProfiles []assistantModelProfile `json:"modelProfiles"`
}

type assistantConfigSnapshot struct {
	AssistantModel string             `json:"assistantModel"`
	TextModel      string             `json:"textModel"`
	ImageModel     string             `json:"imageModel"`
	VideoModel     string             `json:"videoModel"`
	BaseURL        string             `json:"baseUrl"`
	Channels       []assistantChannel `json:"channels"`
}

func (s *Service) assistantConfig() (assistantConfigSnapshot, error) {
	var snapshot assistantConfigSnapshot
	body, err := s.ReadLocalModelConfig()
	if err != nil {
		return snapshot, assistantUnavailable(AssistantReasonModelNotConfigured, "本地模型配置不可读")
	}
	if len(body) == 0 {
		return snapshot, assistantUnavailable(AssistantReasonModelNotConfigured, "本地模型配置为空")
	}
	if err := json.Unmarshal(body, &snapshot); err != nil {
		return snapshot, assistantUnavailable(AssistantReasonModelNotConfigured, "本地模型配置无法解析")
	}
	return snapshot, nil
}

// splitModelKey 把 "channelId::modelId" 拆开；没有前缀时渠道为空，交由调用方按默认渠道处理。
func splitModelKey(value string) (channelID, modelID string) {
	trimmed := strings.TrimSpace(value)
	if idx := strings.Index(trimmed, "::"); idx >= 0 {
		return strings.TrimSpace(trimmed[:idx]), strings.TrimSpace(trimmed[idx+2:])
	}
	return "", trimmed
}

// ResolveAssistantProvider 解析内置助手当前生效的模型与凭据。
// 失败时返回 *AssistantUnavailableError，reason 与 /assistant/status 契约一一对应。
func (s *Service) ResolveAssistantProvider() (AssistantProvider, error) {
	snapshot, err := s.assistantConfig()
	if err != nil {
		return AssistantProvider{}, err
	}
	// 助手模型解析不出来（渠道被停用/删掉、模型不在能力表里）时，等同于没设置助手模型，
	// 直接退回画布的文本模型；只有两者都解析不出来才算未配置。
	provider, reason := s.resolveAssistantChannelModel(snapshot, strings.TrimSpace(snapshot.AssistantModel))
	if reason == AssistantReasonModelNotConfigured {
		provider, reason = s.resolveAssistantChannelModel(snapshot, strings.TrimSpace(snapshot.TextModel))
	}
	if reason != "" {
		return AssistantProvider{}, assistantUnavailable(reason, assistantReasonMessage(reason))
	}
	return provider, nil
}

func assistantReasonMessage(reason string) string {
	switch reason {
	case AssistantReasonCredentialMissing:
		return "该渠道还没有可用的密钥"
	case AssistantReasonProtocolUnsupported:
		return "该模型的协议不支持内置助手会话"
	default:
		return "尚未选择可用的助手文本模型"
	}
}

func (s *Service) resolveAssistantChannelModel(snapshot assistantConfigSnapshot, modelKey string) (AssistantProvider, string) {
	if modelKey == "" {
		return AssistantProvider{}, AssistantReasonModelNotConfigured
	}
	channelID, modelID := splitModelKey(modelKey)
	if modelID == "" {
		return AssistantProvider{}, AssistantReasonModelNotConfigured
	}
	channel, found := findAssistantChannel(snapshot.Channels, channelID, modelID)
	if !found {
		return AssistantProvider{}, AssistantReasonModelNotConfigured
	}
	protocol, protocolOK := channelModelProtocol(channel, modelID)
	if !protocolOK {
		return AssistantProvider{}, AssistantReasonModelNotConfigured
	}
	if protocol == "" {
		return AssistantProvider{}, AssistantReasonProtocolUnsupported
	}
	provider := AssistantProvider{
		ChannelID: channel.ID, ChannelName: assistantChannelName(channel),
		Model: modelID, ModelKey: modelKey, Protocol: protocol,
		BaseURL: strings.TrimSpace(channel.BaseURL), APIKey: strings.TrimSpace(channel.APIKey),
	}
	if provider.BaseURL == "" {
		provider.BaseURL = strings.TrimSpace(snapshot.BaseURL)
	}
	// 托管渠道的密钥不在配置文件里：必须走已连接的企业凭据解析。
	if beefapi.IsManagedChannel(channel.ID, channel.CredentialRef, provider.BaseURL) || channel.ID == beefapi.ChannelID {
		apiKey, baseURL, _, _, lookupErr := s.lookupBeefAPICredential()
		if lookupErr == nil && strings.TrimSpace(apiKey) != "" {
			provider.APIKey = apiKey
			if strings.TrimSpace(baseURL) != "" {
				provider.BaseURL = strings.TrimSpace(baseURL)
			}
		}
	}
	if provider.APIKey == "" {
		return AssistantProvider{}, AssistantReasonCredentialMissing
	}
	if provider.BaseURL == "" {
		return AssistantProvider{}, AssistantReasonModelNotConfigured
	}
	return provider, ""
}

// findAssistantChannel 优先按 channelId 精确匹配；没有前缀时退回「声明了该文本模型的启用渠道」。
func findAssistantChannel(channels []assistantChannel, channelID, modelID string) (assistantChannel, bool) {
	if channelID != "" {
		for _, channel := range channels {
			if channel.ID == channelID && channel.Enabled {
				return channel, true
			}
		}
		return assistantChannel{}, false
	}
	for _, channel := range channels {
		if !channel.Enabled {
			continue
		}
		for _, profile := range channel.ModelProfiles {
			if profile.Model == modelID {
				return channel, true
			}
		}
	}
	return assistantChannel{}, false
}

// channelModelProtocol 返回该模型归一化后的协议。
// found=false 表示渠道没有声明这个模型（或它不是文本模型）；
// protocol 为空串表示声明了但协议不被内置助手支持。
// 渠道层对文本模型的缺省协议就是 chat-completion，这里保持一致，不把缺省当成不支持。
func channelModelProtocol(channel assistantChannel, modelID string) (string, bool) {
	for _, profile := range channel.ModelProfiles {
		if profile.Model != modelID {
			continue
		}
		capability := strings.TrimSpace(profile.Capability)
		if capability != "" && capability != "text" {
			return "", false
		}
		declared := strings.TrimSpace(profile.Protocol)
		if declared == "" {
			return "chat-completion", true
		}
		normalized, supported := assistantProtocols[declared]
		if !supported {
			return "", true
		}
		return normalized, true
	}
	return "", false
}

func assistantChannelName(channel assistantChannel) string {
	if name := strings.TrimSpace(channel.Name); name != "" {
		return name
	}
	if channel.ID == beefapi.ChannelID {
		return "BeefAPI"
	}
	return channel.ID
}

// AssistantGenerationModel 返回画布默认的图片/视频模型：付费生成提议要把它原样告诉用户。
// modelKey 保留 "channel::model" 原值，display 去掉渠道前缀。
func (s *Service) AssistantGenerationModel(kind string) (display string, modelKey string) {
	snapshot, err := s.assistantConfig()
	if err != nil {
		return "", ""
	}
	switch kind {
	case "image":
		modelKey = strings.TrimSpace(snapshot.ImageModel)
	case "video":
		modelKey = strings.TrimSpace(snapshot.VideoModel)
	default:
		return "", ""
	}
	_, display = splitModelKey(modelKey)
	return display, modelKey
}
