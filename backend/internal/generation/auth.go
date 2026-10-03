package generation

import (
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/chatgptauth"
)

func ApplyAuth(req *http.Request, config Config) {
	if req == nil {
		return
	}
	if config.APIFormat == "claude" {
		req.Header.Set("x-api-key", config.APIKey)
		req.Header.Set("anthropic-version", "2023-06-01")
		return
	}
	if config.APIFormat == "gemini" {
		req.Header.Set("x-goog-api-key", config.APIKey)
		return
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	ApplyChatGPTSubscriptionHeaders(req, config)
}

// ApplyChatGPTSubscriptionHeaders 在订阅渠道上补齐账号隔离头。账号 id 只存在于
// 执行期内存中，不进渠道配置，也不会随任务载荷落库。
func ApplyChatGPTSubscriptionHeaders(req *http.Request, config Config) {
	if req == nil || strings.TrimSpace(config.CredentialRef) != chatgptauth.CredentialRef {
		return
	}
	if accountID := strings.TrimSpace(config.ChatGPTAccountID); accountID != "" {
		req.Header.Set("chatgpt-account-id", accountID)
	}
	if config.ChatGPTFedRAMP {
		req.Header.Set("X-OpenAI-Fedramp", "true")
	}
	if strings.TrimSpace(req.Header.Get("originator")) == "" {
		req.Header.Set("originator", "codex_cli_rs")
	}
}
