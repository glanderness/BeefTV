package app

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"infinite-canvas/backend/internal/assistant"
	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/chatgptauth"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/workspace"
)

// assistantCredentialTimeout 限制助手凭据换取，避免宿主启动被上游拖死。
const assistantCredentialTimeout = 30 * time.Second

const (
	AssistantReasonModelNotConfigured  = assistant.ReasonModelNotConfigured
	AssistantReasonCredentialMissing   = assistant.ReasonCredentialMissing
	AssistantReasonProtocolUnsupported = assistant.ReasonProtocolUnsupported
)

type AssistantUnavailableError = assistant.UnavailableError
type AssistantProvider = assistant.Provider

func assistantUnavailable(reason, message string) error {
	return modelcatalog.AssistantUnavailable(reason, message)
}

type assistantModelProfile = modelcatalog.AssistantModelProfile
type assistantChannel = modelcatalog.AssistantChannel
type assistantConfigSnapshot = modelcatalog.AssistantConfigSnapshot

func (s *Service) assistantConfig() (assistantConfigSnapshot, error) {
	var snapshot assistantConfigSnapshot
	store, err := workspace.NewProviderConfig(s.dataDir)
	if err != nil {
		return snapshot, err
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		return snapshot, assistantUnavailable(AssistantReasonModelNotConfigured, "本地模型配置不可读")
	}
	body, err := json.Marshal(effective.Config)
	if err != nil {
		return snapshot, err
	}
	if len(body) == 0 {
		return snapshot, assistantUnavailable(AssistantReasonModelNotConfigured, "本地模型配置为空")
	}
	if err := json.Unmarshal(body, &snapshot); err != nil {
		return snapshot, assistantUnavailable(AssistantReasonModelNotConfigured, "本地模型配置无法解析")
	}
	snapshot.Revision = effective.Revision
	return snapshot, nil
}

func (s *Service) ResolveAssistantProvider() (AssistantProvider, error) {
	snapshot, err := s.assistantConfig()
	if err != nil {
		return AssistantProvider{}, err
	}
	for index, channel := range snapshot.Channels {
		if strings.TrimSpace(channel.Name) == "" && channel.ID == beefapi.ChannelID {
			snapshot.Channels[index].Name = "BeefAPI"
		}
	}
	provider, err := modelcatalog.ResolveAssistantProvider(snapshot, s.assistantManagedCredentialLookup())
	if err != nil {
		return provider, err
	}
	s.applyAssistantSubscriptionHeaders(&provider)
	return provider, nil
}

// applyAssistantSubscriptionHeaders 为订阅渠道补上账号隔离头。助手请求由
// agent-host 直连上游，只带 baseUrl + apiKey，所以账号头必须在这里从凭据派生。
func (s *Service) applyAssistantSubscriptionHeaders(provider *assistant.Provider) {
	if provider == nil || strings.TrimSpace(provider.Protocol) != chatgptauth.CredentialRef {
		return
	}
	accountID, fedramp, ok := s.assistantChatGPTAccount()
	if !ok {
		return
	}
	headers := map[string]string{"originator": "codex_cli_rs"}
	if accountID != "" {
		headers["chatgpt-account-id"] = accountID
	}
	if fedramp {
		headers["X-OpenAI-Fedramp"] = "true"
	}
	provider.Headers = headers
}

// assistantChatGPTAccount 从托管凭据解出账号 id。令牌本身已由凭据 lookup 注入，
// 这里只取非敏感元数据，失败时不阻断启动（账号头缺失会由上游明确拒绝）。
func (s *Service) assistantChatGPTAccount() (accountID string, fedramp bool, ok bool) {
	credential, credentialOK := s.assistantChatGPTCredential()
	if !credentialOK {
		return "", false, false
	}
	return credential.AccountID, credential.FedRAMP, true
}

// assistantChatGPTCredential 换取订阅短期令牌。凭据服务按工作区 owner 隔离，
// 与生成任务共用同一份存储，因此不存在第二套信任根。
func (s *Service) assistantChatGPTCredential() (chatgptauth.Credential, bool) {
	if s.chatGPTAuth == nil {
		return chatgptauth.Credential{}, false
	}
	owner, err := s.LocalWorkspaceOwner()
	if err != nil || strings.TrimSpace(owner.ID) == "" {
		return chatgptauth.Credential{}, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), assistantCredentialTimeout)
	defer cancel()
	credential, err := s.chatGPTAuth.AccessToken(ctx, owner.ID)
	if err != nil || strings.TrimSpace(credential.AccessToken) == "" {
		return chatgptauth.Credential{}, false
	}
	return credential, true
}

func (s *Service) assistantManagedCredentialLookup() modelcatalog.ManagedCredentialLookup {
	return func(channelID, credentialRef, baseURL string) (string, string, bool) {
		// ChatGPT 订阅：用同一套凭据服务在执行期换取短期令牌。
		if strings.TrimSpace(credentialRef) == chatgptauth.CredentialRef {
			credential, ok := s.assistantChatGPTCredential()
			if !ok {
				return "", "", false
			}
			return credential.AccessToken, chatgptauth.CodexBaseURL, true
		}
		if !(beefapi.IsManagedChannel(channelID, credentialRef, baseURL) || channelID == beefapi.ChannelID) {
			return "", "", false
		}
		apiKey, resolvedBaseURL, _, _, lookupErr := s.lookupBeefAPICredential()
		if lookupErr != nil || strings.TrimSpace(apiKey) == "" {
			return "", "", false
		}
		return apiKey, resolvedBaseURL, true
	}
}

func assistantReasonMessage(reason string) string {
	return modelcatalog.AssistantReasonMessage(reason)
}

func (s *Service) resolveAssistantChannelModel(snapshot assistantConfigSnapshot, modelKey string) (AssistantProvider, string) {
	for index, channel := range snapshot.Channels {
		if strings.TrimSpace(channel.Name) == "" && channel.ID == beefapi.ChannelID {
			snapshot.Channels[index].Name = "BeefAPI"
		}
	}
	return modelcatalog.ResolveAssistantChannelModel(snapshot, modelKey, s.assistantManagedCredentialLookup())
}

func findAssistantChannel(channels []assistantChannel, channelID, modelID string) (assistantChannel, bool) {
	return modelcatalog.FindAssistantChannel(channels, channelID, modelID)
}

func channelModelProtocol(channel assistantChannel, modelID string) (string, bool) {
	return modelcatalog.ChannelModelProtocol(channel, modelID)
}

func assistantChannelName(channel assistantChannel) string {
	if name := modelcatalog.AssistantChannelName(channel); name != "" && name != channel.ID {
		return name
	}
	if channel.ID == beefapi.ChannelID {
		return "BeefAPI"
	}
	return modelcatalog.AssistantChannelName(channel)
}

func (s *Service) AssistantGenerationModel(kind string) (display string, modelKey string) {
	display, modelKey, _, _, _ = s.ResolveAssistantGenerationModel(kind, "")
	return display, modelKey
}

func (s *Service) AssistantGenerationModelSnapshot(kind string) (display string, modelKey string, revision int64, err error) {
	display, modelKey, revision, _, err = s.ResolveAssistantGenerationModel(kind, "")
	return
}

func (s *Service) ResolveAssistantGenerationModel(kind, selectedModel string) (display string, modelKey string, revision int64, kindMismatch bool, err error) {
	snapshot, err := s.assistantConfig()
	if err != nil {
		return "", "", 0, false, err
	}
	choice := modelcatalog.ResolveAssistantGenerationModel(snapshot, kind, selectedModel)
	return choice.Display, choice.ModelKey, snapshot.Revision, choice.KindMismatch, nil
}
