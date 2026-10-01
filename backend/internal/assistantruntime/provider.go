package assistantruntime

import (
	"errors"
	"os"
	"strings"

	"infinite-canvas/backend/internal/app"
)

// ProviderService 是宿主解析模型/凭据时需要的窄端口；*app.Service 满足该接口。
type ProviderService interface {
	DataDir() string
	ResolveAssistantProvider() (app.AssistantProvider, error)
}

// ResolveProvider 按用户选中的渠道解析模型与凭据（app 层拥有规则），
// 并允许显式环境变量覆盖，便于开发与受控测试。
//
// 失败时返回的 reason 直接就是 /assistant/status 契约里的机器可读原因。
func ResolveProvider(resolve func() (app.AssistantProvider, error)) (app.AssistantProvider, string) {
	override := app.AssistantProvider{
		BaseURL:  strings.TrimSpace(os.Getenv("BEEFTV_AGENT_BASE_URL")),
		APIKey:   strings.TrimSpace(os.Getenv("BEEFTV_AGENT_API_KEY")),
		Model:    strings.TrimSpace(os.Getenv("BEEFTV_AGENT_MODEL")),
		Protocol: strings.TrimSpace(os.Getenv("BEEFTV_AGENT_PROTOCOL")),
	}
	if override.BaseURL != "" && override.APIKey != "" && override.Model != "" {
		if override.Protocol == "" {
			override.Protocol = "chat-completion"
		}
		override.ChannelID = "env"
		override.ChannelName = "环境变量"
		override.ModelKey = override.Model
		return override, ""
	}
	if resolve == nil {
		return app.AssistantProvider{}, app.AssistantReasonModelNotConfigured
	}
	provider, err := resolve()
	if err != nil {
		var unavailable *app.AssistantUnavailableError
		if errors.As(err, &unavailable) {
			return app.AssistantProvider{}, unavailable.Reason
		}
		return app.AssistantProvider{}, app.AssistantReasonModelNotConfigured
	}
	return provider, ""
}

func (h *Host) ResolveProvider() (app.AssistantProvider, string) {
	if h != nil && h.opts.ResolveProvider != nil {
		return h.opts.ResolveProvider()
	}
	return ResolveProvider(nil)
}
