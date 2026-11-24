package app

import (
	"strings"

	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/providerpreset"
)

func (s *Service) assistantGenerationConfig(target operations.GenerationTarget) (map[string]any, error) {
	body, err := s.ReadLocalModelConfig()
	if err != nil {
		return nil, err
	}
	channelID, modelID := modelcatalog.SplitModelKey(target.ModelKey)
	config, found, err := modelcatalog.LocalChannelConfig(body, channelID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, operations.PreconditionFailed("generation_model_unavailable", "制作模型已不可用", nil)
	}
	config["model"] = modelID
	for _, profile := range modelcatalog.ParseLocalChannelModels(body) {
		if profile.ChannelID == channelID && profile.Model == modelID && profile.Enabled {
			if profile.Protocol != "" {
				config["interfaceType"] = profile.Protocol
			}
			if profile.CapabilityConfig != nil {
				config["capabilityConfig"] = profile.CapabilityConfig
			}
			if target.Kind == "video" {
				if _, protocol, ok := providerpreset.HostedBeefTVVideoProfile(profile.BaseURL, modelID); ok {
					config["interfaceType"] = protocol
				}
			}
			break
		}
	}
	for key, value := range target.Parameters {
		switch key {
		case "seconds":
			key = "videoSeconds"
		case "generateAudio":
			key = "videoGenerateAudio"
		case "watermark":
			key = "videoWatermark"
		case "videoStartFrameNodeId", "videoEndFrameNodeId", "videoMiddleFrameNodeId":
			continue
		}
		config[key] = value
	}
	if strings.TrimSpace(stringValue(config["count"])) == "" {
		config["count"] = "1"
	}
	return config, nil
}
