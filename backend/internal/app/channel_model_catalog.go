package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
)

type ChannelModelsRequest struct {
	BaseURL       string           `json:"baseUrl"`
	APIKey        string           `json:"apiKey"`
	APIFormat     string           `json:"apiFormat"`
	Headers       []OutboundHeader `json:"headers"`
	ChannelID     string           `json:"channelId"`
	CredentialRef string           `json:"credentialRef"`
}

func (s *Service) FetchChannelModels(ctx context.Context, actor *model.User, input ChannelModelsRequest) ([]string, error) {
	items, err := s.FetchChannelModelCatalog(ctx, actor, input)
	if err != nil {
		return nil, err
	}
	return modelcatalog.CatalogModelIDs(items), nil
}

func (s *Service) FetchChannelModelCatalog(ctx context.Context, actor *model.User, input ChannelModelsRequest) ([]ChannelModelCatalogItem, error) {
	if actor == nil || strings.TrimSpace(actor.ID) == "" {
		return nil, Unauthorized("请先登录")
	}
	if err := s.resolveChannelModelsRequest(&input); err != nil {
		return nil, err
	}
	headers, err := NormalizeOutboundHeaders(input.Headers)
	if err != nil {
		return nil, err
	}
	catalog, err := modelcatalog.LoadChannelModelCatalog(ctx, s.fetchChannelModelCatalogBytes, input.BaseURL, input.APIFormat, input.APIKey, headers)
	if err != nil {
		return nil, mapChannelModelCatalogError(err)
	}
	catalog = overlayCatalogVideoCapabilities(catalog)
	if s.isPluginEnabled() {
		baseURL, _, apiFormat, _ := modelcatalog.ValidateCatalogRequest(input.BaseURL, input.APIKey, input.APIFormat)
		catalog = extendChannelModelCatalog(baseURL, apiFormat, headers, catalog)
	}
	return catalog, nil
}

func (s *Service) fetchChannelModelCatalogBytes(ctx context.Context, baseURL, apiFormat, apiKey string, headers []modelcatalog.ChannelHeader) ([]byte, error) {
	target := apiURL(baseURL, "/models")
	if apiFormat == "gemini" {
		if !strings.HasSuffix(strings.ToLower(baseURL), "/v1beta") {
			baseURL += "/v1beta"
		}
		target = baseURL + "/models"
	}
	if _, err := ValidateOutboundURL(target); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, BadAuthRequest("模型服务地址无效")
	}
	if apiFormat == "gemini" {
		request.Header.Set("x-goog-api-key", apiKey)
	} else {
		request.Header.Set("Authorization", "Bearer "+apiKey)
	}
	ApplyOutboundHeaders(request, headers)
	data, _, err := doBinary(request)
	if err != nil {
		var httpErr providerHTTPError
		if errors.As(err, &httpErr) {
			return nil, modelcatalog.CatalogFetchError{StatusCode: httpErr.StatusCode, Cause: err}
		}
		return nil, modelcatalog.CatalogFetchError{Cause: err}
	}
	return data, nil
}

func overlayCatalogVideoCapabilities(items []ChannelModelCatalogItem) []ChannelModelCatalogItem {
	for index, item := range items {
		if video, ok := beefapi.NormalizeCatalogVideoCapability(item.VideoCapabilities); ok {
			if raw, err := json.Marshal(video); err == nil {
				items[index].VideoCapabilities = raw
				version := ""
				if item.VideoCapabilitiesVersion != nil {
					version = strings.TrimSpace(*item.VideoCapabilitiesVersion)
				}
				items[index].VideoCapabilitiesVersion = &version
				continue
			}
		}
		items[index].VideoCapabilities = nil
		items[index].VideoCapabilitiesVersion = nil
	}
	return items
}

func mapChannelModelCatalogError(err error) error {
	if err == nil {
		return nil
	}
	var fetchErr modelcatalog.CatalogFetchError
	if errors.As(err, &fetchErr) {
		return channelModelsUpstreamError(fetchErr.Cause)
	}
	var jsonErr modelcatalog.CatalogJSONError
	if errors.As(err, &jsonErr) {
		return WrapAppError(http.StatusBadGateway, jsonErr.Error(), jsonErr.Cause)
	}
	var rejected modelcatalog.CatalogUpstreamRejectedError
	if errors.As(err, &rejected) {
		return NewAppError(http.StatusBadGateway, rejected.Error())
	}
	return err
}

func channelModelsUpstreamError(err error) error {
	var authErr *AuthError
	if errors.As(err, &authErr) {
		return authErr
	}
	var httpErr providerHTTPError
	if !errors.As(err, &httpErr) {
		return WrapAppError(http.StatusBadGateway, "连接模型服务失败，请检查渠道地址和网络", err)
	}
	switch httpErr.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return NewAppError(http.StatusBadGateway, "模型服务鉴权失败，请检查 API Key")
	case http.StatusNotFound:
		return NewAppError(http.StatusBadGateway, "模型服务未提供 /models 接口")
	case http.StatusTooManyRequests:
		return NewAppError(http.StatusBadGateway, "模型服务请求过于频繁或额度不足")
	default:
		return WrapAppError(http.StatusBadGateway, httpErr.Error(), err)
	}
}
