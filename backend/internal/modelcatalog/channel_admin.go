package modelcatalog

import (
	"encoding/json"
	"errors"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
)

func ChannelModelNames(channel model.ModelChannel) []string {
	models := []string{}
	_ = json.Unmarshal([]byte(channel.ModelsJSON), &models)
	return kernel.UniqueNonEmpty(models)
}

func PublicChannel(channel model.ModelChannel, admin bool, channelModels []model.ChannelModel) PublicModelChannel {
	models := make([]string, 0, len(channelModels))
	modelProfiles := make([]PublicChannelModelProfile, 0, len(channelModels))
	for _, item := range channelModels {
		if !item.Enabled {
			continue
		}
		models = append(models, item.ModelKey)
		capabilityConfig, decodeErr := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
		if decodeErr == nil && capabilityConfig != nil {
			if normalized, normalizeErr := NormalizeModelCapabilityConfigForModel(item.Capability, string(item.Protocol), kernel.FirstNonEmpty(item.ProviderModelKey, item.ModelKey), capabilityConfig); normalizeErr == nil {
				capabilityConfig = normalized
			}
		}
		modelProfiles = append(modelProfiles, PublicChannelModelProfile{Model: item.ModelKey, DisplayName: item.DisplayName, Icon: item.Icon, Capability: item.Capability, Protocol: item.Protocol, CapabilityConfig: capabilityConfig})
	}
	if len(models) == 0 {
		_ = json.Unmarshal([]byte(channel.ModelsJSON), &models)
	}
	apiKey := ""
	baseURL := channel.BaseURL
	var headers []ChannelHeader
	if channel.Scope == model.ChannelScopeSystem {
		if !admin {
			apiKey = "system"
			baseURL = "/api/ai/system/" + channel.ID
		}
		if admin {
			headers, _ = ParseChannelHeadersJSON(channel.HeadersJSON)
		}
	} else if admin {
		apiKey = channel.APIKey
	}
	name, alias := channel.PublicName(), ""
	if admin {
		name, alias = channel.Name, channel.PublicAlias
	}
	return PublicModelChannel{
		ID:               channel.ID,
		UserID:           channel.UserID,
		Scope:            channel.Scope,
		Enabled:          channel.Enabled,
		Name:             name,
		PublicAlias:      alias,
		SortOrder:        channel.SortOrder,
		BaseURL:          baseURL,
		APIKey:           apiKey,
		APIFormat:        channel.APIFormat,
		ConcurrencyLimit: channel.ConcurrencyLimit,
		Models:           models,
		ModelProfiles:    modelProfiles,
		Headers:          headers,
		HasAPIKey:        strings.TrimSpace(channel.APIKey) != "",
		HasSecretKey:     strings.TrimSpace(channel.SecretKey) != "",
		CreatedAt:        channel.CreatedAt,
		UpdatedAt:        channel.UpdatedAt,
	}
}

func ParseChannelHeadersJSON(raw string) ([]ChannelHeader, error) {
	decoded, err := outbound.ParseOutboundHeadersJSON(raw)
	return decoded, mapOutboundError(err)
}

func mapOutboundError(err error) error {
	if err == nil {
		return nil
	}
	var req *outbound.BadRequestError
	if errors.As(err, &req) {
		return kernel.BadAuthRequest(req.Message)
	}
	return err
}
