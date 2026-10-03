package app

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/chatgptauth"
)

// SetChatGPTAuth 注入 ChatGPT 订阅凭据服务。桌面组合根负责创建它。
func (s *Service) SetChatGPTAuth(service *chatgptauth.Service) {
	if s == nil {
		return
	}
	s.chatGPTAuth = service
}

func (s *Service) ChatGPTAuth() *chatgptauth.Service {
	if s == nil {
		return nil
	}
	return s.chatGPTAuth
}

// usesChatGPTSubscription 判定一个已解析的渠道配置是否指向 ChatGPT 订阅托管凭据。
func usesChatGPTSubscription(config providerConfig) bool {
	return strings.TrimSpace(config.CredentialRef) == chatgptauth.CredentialRef
}

// resolveChatGPTSubscriptionCredential 在执行前把渠道里的 credentialRef 换成短期
// access_token。调用方必须已经解析出用户，且不能把结果写回任务载荷。
//
// 解析放在执行期而不是任务创建期：access_token 只有约一小时有效期，排队、重试和恢复
// 都必须拿到当时的有效令牌；refresh_token 始终留在服务器侧加密存储里。
func (s *Service) resolveChatGPTSubscriptionCredential(ctx context.Context, userID string, config *providerConfig) error {
	if config == nil || !usesChatGPTSubscription(*config) {
		return nil
	}
	if s.chatGPTAuth == nil {
		return errors.New("ChatGPT 订阅服务尚未初始化")
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return errors.New("ChatGPT 订阅凭据缺少工作区用户标识")
	}
	credential, err := s.chatGPTAuth.AccessToken(ctx, userID)
	if err != nil {
		// 只有本地凭据缺失或失效才需要用户重新连接；网络和上游故障是可重试的服务端错误。
		if chatgptauth.IsCredentialError(err) {
			return BadAuthRequest(err.Error())
		}
		return NewAppError(http.StatusBadGateway, "无法获取 ChatGPT 订阅令牌，请稍后重试")
	}
	if strings.TrimSpace(credential.AccessToken) == "" {
		return BadAuthRequest("ChatGPT 订阅凭据无效，请重新连接")
	}
	config.APIKey = credential.AccessToken
	config.ChatGPTAccountID = credential.AccountID
	config.ChatGPTFedRAMP = credential.FedRAMP
	return nil
}

// resolveChatGPTModelsCredential 为订阅渠道的模型目录请求注入短期访问令牌。
// 与生成任务一样，令牌只在执行期存在于内存，不进渠道配置。
func (s *Service) resolveChatGPTModelsCredential(ctx context.Context, userID string, input *ChannelModelsRequest) error {
	if input == nil || strings.TrimSpace(input.CredentialRef) != chatgptauth.CredentialRef {
		return nil
	}
	if s.chatGPTAuth == nil {
		return errors.New("ChatGPT 订阅服务尚未初始化")
	}
	credential, err := s.chatGPTAuth.AccessToken(ctx, strings.TrimSpace(userID))
	if err != nil {
		if chatgptauth.IsCredentialError(err) {
			return BadAuthRequest(err.Error())
		}
		return NewAppError(http.StatusBadGateway, "无法获取 ChatGPT 订阅令牌，请稍后重试")
	}
	input.APIKey = credential.AccessToken
	input.ChatGPTAccountID = credential.AccountID
	input.ChatGPTFedRAMP = credential.FedRAMP
	input.APIFormat = "openai"
	if strings.TrimSpace(input.BaseURL) == "" {
		input.BaseURL = chatgptauth.CodexBaseURL
	}
	return nil
}
