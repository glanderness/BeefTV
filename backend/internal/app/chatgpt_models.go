package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/buildinfo"
	"infinite-canvas/backend/internal/chatgptauth"
)

// chatGPTSubscriptionModelsResponse 是 Codex catalog 的响应形状。模型标识字段是
// slug 而不是 id，展示名是 display_name；这与 OpenAI 的 /v1/models 不同。
type chatGPTSubscriptionModelsResponse struct {
	Models []struct {
		Slug           string `json:"slug"`
		DisplayName    string `json:"display_name"`
		Description    string `json:"description"`
		SupportedInAPI *bool  `json:"supported_in_api"`
	} `json:"models"`
	Error *providerError `json:"error"`
}

// clientVersionPattern 从产品版本里提取纯数字三级版本。
var clientVersionPattern = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// chatGPTClientVersion 把产品版本（例如 "v1.6.22"）规范化为 Codex catalog 要求的
// 纯数字三级版本。上游对这个参数校验很严：带 "v" 前缀或 pre-release 后缀会直接
// 返回 HTTP 400 Invalid client_version format。
func chatGPTClientVersion() string {
	raw := strings.TrimSpace(buildinfo.Current().Version)
	if match := clientVersionPattern.FindStringSubmatch(raw); match != nil {
		return match[1] + "." + match[2] + "." + match[3]
	}
	// 开发构建没有正式版本号时仍需一个格式合法的值；上游接受 0.0.0。
	return "0.0.0"
}

// fetchChatGPTSubscriptionModelCatalog 读取 ChatGPT 订阅后端暴露的模型目录。
// 端点与请求头复刻 Codex 客户端：GET {base}/models?client_version=<版本>。
func fetchChatGPTSubscriptionModelCatalog(ctx context.Context, input ChannelModelsRequest) ([]ChannelModelCatalogItem, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(input.BaseURL), "/")
	if baseURL == "" {
		baseURL = chatgptauth.CodexBaseURL
	}
	target := baseURL + "/models?client_version=" + url.QueryEscape(chatGPTClientVersion())
	if _, err := ValidateOutboundURL(target); err != nil {
		return nil, err
	}
	headers, err := NormalizeOutboundHeaders(input.Headers)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, BadAuthRequest("模型服务地址无效")
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(input.APIKey))
	request.Header.Set("Accept", "application/json")
	if accountID := strings.TrimSpace(input.ChatGPTAccountID); accountID != "" {
		request.Header.Set("chatgpt-account-id", accountID)
	}
	if input.ChatGPTFedRAMP {
		request.Header.Set("X-OpenAI-Fedramp", "true")
	}
	request.Header.Set("originator", "codex_cli_rs")
	ApplyOutboundHeaders(request, headers)

	// 只代理固定的模型目录 GET；订阅访问令牌仅用于本次请求，不落库、不写日志。
	data, _, err := doBinary(request)
	if err != nil {
		return nil, channelModelsUpstreamError(err)
	}
	var payload chatGPTSubscriptionModelsResponse
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, WrapAppError(http.StatusBadGateway, "ChatGPT 订阅返回的不是有效模型目录", err)
	}
	if payload.Error != nil && strings.TrimSpace(payload.Error.Message) != "" {
		return nil, NewAppError(http.StatusBadGateway, "ChatGPT 订阅拒绝了模型目录请求，请重新连接")
	}

	seen := make(map[string]bool, len(payload.Models))
	all := make([]ChannelModelCatalogItem, 0, len(payload.Models))
	apiVisible := make([]ChannelModelCatalogItem, 0, len(payload.Models))
	for _, item := range payload.Models {
		slug := strings.TrimSpace(item.Slug)
		if slug == "" || seen[slug] {
			continue
		}
		seen[slug] = true
		// 订阅 catalog 不声明能力，宿主按事实标记为文本，避免前端无法归类而隐藏模型。
		entry := ChannelModelCatalogItem{ID: slug, DisplayName: strings.TrimSpace(item.DisplayName), ModelType: "text"}
		all = append(all, entry)
		// supported_in_api=false 是客户端内部模型；字段缺失时不据此排除。
		if item.SupportedInAPI == nil || *item.SupportedInAPI {
			apiVisible = append(apiVisible, entry)
		}
	}
	// 过滤不能把目录变成空；上游若整体标记为内部模型，仍返回原始列表供人工确认。
	if len(apiVisible) > 0 {
		all = apiVisible
	}
	sort.Slice(all, func(i, j int) bool { return all[i].ID < all[j].ID })
	return all, nil
}
