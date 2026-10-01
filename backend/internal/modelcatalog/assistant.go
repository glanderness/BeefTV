package modelcatalog

import (
	"strings"

	"infinite-canvas/backend/internal/assistant"
)

const (
	AssistantReasonModelNotConfigured  = assistant.ReasonModelNotConfigured
	AssistantReasonCredentialMissing   = assistant.ReasonCredentialMissing
	AssistantReasonProtocolUnsupported = assistant.ReasonProtocolUnsupported
)

// assistantProtocols 是助手会话支持的文本协议。配置里历史上同时出现
// "responses" 与 "openai-response" 两种写法，这里都接受并归一。
var assistantProtocols = map[string]string{
	"chat-completion": "chat-completion",
	"claude-api":      "claude-api",
	"responses":       "responses",
	"openai-response": "responses",
}

type AssistantModelProfile struct {
	Model      string `json:"model"`
	Capability string `json:"capability"`
	Protocol   string `json:"protocol"`
}

type AssistantChannel struct {
	ID            string                  `json:"id"`
	Name          string                  `json:"name"`
	BaseURL       string                  `json:"baseUrl"`
	APIKey        string                  `json:"apiKey"`
	CredentialRef string                  `json:"credentialRef"`
	Enabled       bool                    `json:"enabled"`
	ModelProfiles []AssistantModelProfile `json:"modelProfiles"`
}

type AssistantConfigSnapshot struct {
	Revision       int64              `json:"-"`
	AssistantModel string             `json:"assistantModel"`
	TextModel      string             `json:"textModel"`
	ImageModel     string             `json:"imageModel"`
	VideoModel     string             `json:"videoModel"`
	BaseURL        string             `json:"baseUrl"`
	Channels       []AssistantChannel `json:"channels"`
}

// ManagedCredentialLookup fills hosted-channel secrets that are not stored in
// the local snapshot. The lookup is supplied by app; this domain never imports
// beefapi.
type ManagedCredentialLookup func(channelID, credentialRef, baseURL string) (apiKey, resolvedBaseURL string, ok bool)

func SplitModelKey(value string) (channelID, modelID string) {
	trimmed := strings.TrimSpace(value)
	if idx := strings.Index(trimmed, "::"); idx >= 0 {
		return strings.TrimSpace(trimmed[:idx]), strings.TrimSpace(trimmed[idx+2:])
	}
	return "", trimmed
}

func AssistantReasonMessage(reason string) string {
	switch reason {
	case AssistantReasonCredentialMissing:
		return "该渠道还没有可用的密钥"
	case AssistantReasonProtocolUnsupported:
		return "该模型的协议不支持内置助手会话"
	default:
		return "尚未选择可用的助手文本模型"
	}
}

func AssistantUnavailable(reason, message string) error {
	return &assistant.UnavailableError{Reason: reason, Message: message}
}

// ResolveAssistantProvider applies catalog selection to a loaded snapshot.
// Credential lookup for hosted channels is injected; secrets never appear in
// error messages.
func ResolveAssistantProvider(snapshot AssistantConfigSnapshot, lookup ManagedCredentialLookup) (assistant.Provider, error) {
	provider, reason := ResolveAssistantChannelModel(snapshot, strings.TrimSpace(snapshot.AssistantModel), lookup)
	if reason == AssistantReasonModelNotConfigured {
		provider, reason = ResolveAssistantChannelModel(snapshot, strings.TrimSpace(snapshot.TextModel), lookup)
	}
	if reason != "" {
		return assistant.Provider{}, AssistantUnavailable(reason, AssistantReasonMessage(reason))
	}
	return provider, nil
}

func ResolveAssistantChannelModel(snapshot AssistantConfigSnapshot, modelKey string, lookup ManagedCredentialLookup) (assistant.Provider, string) {
	if modelKey == "" {
		return assistant.Provider{}, AssistantReasonModelNotConfigured
	}
	channelID, modelID := SplitModelKey(modelKey)
	if modelID == "" {
		return assistant.Provider{}, AssistantReasonModelNotConfigured
	}
	channel, found := FindAssistantChannel(snapshot.Channels, channelID, modelID)
	if !found {
		return assistant.Provider{}, AssistantReasonModelNotConfigured
	}
	protocol, protocolOK := ChannelModelProtocol(channel, modelID)
	if !protocolOK {
		return assistant.Provider{}, AssistantReasonModelNotConfigured
	}
	if protocol == "" {
		return assistant.Provider{}, AssistantReasonProtocolUnsupported
	}
	provider := assistant.Provider{
		ChannelID: channel.ID, ChannelName: AssistantChannelName(channel),
		Model: modelID, ModelKey: modelKey, Protocol: protocol,
		BaseURL: strings.TrimSpace(channel.BaseURL), APIKey: strings.TrimSpace(channel.APIKey),
	}
	if provider.BaseURL == "" {
		provider.BaseURL = strings.TrimSpace(snapshot.BaseURL)
	}
	if lookup != nil {
		if apiKey, baseURL, ok := lookup(channel.ID, channel.CredentialRef, provider.BaseURL); ok {
			if strings.TrimSpace(apiKey) != "" {
				provider.APIKey = apiKey
			}
			if strings.TrimSpace(baseURL) != "" {
				provider.BaseURL = strings.TrimSpace(baseURL)
			}
		}
	}
	if provider.APIKey == "" {
		return assistant.Provider{}, AssistantReasonCredentialMissing
	}
	if provider.BaseURL == "" {
		return assistant.Provider{}, AssistantReasonModelNotConfigured
	}
	return provider, ""
}

func FindAssistantChannel(channels []AssistantChannel, channelID, modelID string) (AssistantChannel, bool) {
	if channelID != "" {
		for _, channel := range channels {
			if channel.ID == channelID && channel.Enabled {
				return channel, true
			}
		}
		return AssistantChannel{}, false
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
	return AssistantChannel{}, false
}

func ChannelModelProtocol(channel AssistantChannel, modelID string) (string, bool) {
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

func AssistantChannelName(channel AssistantChannel) string {
	if name := strings.TrimSpace(channel.Name); name != "" {
		return name
	}
	return channel.ID
}

func AssistantGenerationModelKey(snapshot AssistantConfigSnapshot, kind string) (display string, modelKey string) {
	switch kind {
	case "image":
		modelKey = strings.TrimSpace(snapshot.ImageModel)
	case "video":
		modelKey = strings.TrimSpace(snapshot.VideoModel)
	default:
		return "", ""
	}
	_, display = SplitModelKey(modelKey)
	return display, modelKey
}
