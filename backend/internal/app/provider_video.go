package app

// 视频生成遗留手写路径；已有官方插件的接口类型走声明式协议。

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
)

func (s *Service) validateResolvedVideoCapability(input *canvasGenerationInput) error {
	return s.validateResolvedVideoCapabilityContext(context.Background(), input)
}

func (s *Service) validateResolvedVideoCapabilityContext(ctx context.Context, input *canvasGenerationInput) error {
	if err := s.resolveVideoCapability(ctx, input); err != nil {
		return err
	}
	if strings.TrimSpace(input.Config.ChannelID) == "" || input.VideoCapability == nil {
		return nil
	}
	return validateVideoTask(input.VideoCapability, *input)
}

func (s *Service) resolveVideoCapability(ctx context.Context, input *canvasGenerationInput) error {
	if input.Config.CredentialRef == managedBeefAPIRef {
		body, err := s.ReadLocalModelConfig()
		if err != nil {
			return err
		}
		// Only the saved account catalog can authorize a managed submission;
		// request-supplied versions and profiles are not trusted capabilities.
		input.Config.VideoCapabilitiesVersion = nil
		input.Config.CapabilityConfig = nil
		for _, item := range modelcatalog.ParseLocalChannelModels(body) {
			if item.ChannelID != "beefapi" || !item.Enabled || item.Model != input.Config.Model || item.VideoCapabilitiesVersion == nil || strings.TrimSpace(*item.VideoCapabilitiesVersion) == "" {
				continue
			}
			config, _ := item.CapabilityConfig.(map[string]any)
			rawVideo, _ := json.Marshal(config["video"])
			video, valid := beefapi.NormalizeVersionedVideoCapability(rawVideo, *item.VideoCapabilitiesVersion)
			if !valid {
				continue
			}
			raw, err := json.Marshal(map[string]any{"version": 1, "video": video})
			if err != nil {
				return err
			}
			input.Config.CapabilityConfig, err = DecodeModelCapabilityConfig(string(raw))
			if err != nil {
				return err
			}
			input.Config.VideoCapabilitiesVersion = item.VideoCapabilitiesVersion
			break
		}
		if input.Config.VideoCapabilitiesVersion == nil {
			return nil
		}
	}
	if input.Config.VideoCapabilitiesVersion != nil && strings.TrimSpace(*input.Config.VideoCapabilitiesVersion) != "" {
		profile := input.Config.CapabilityConfig
		if profile == nil || profile.Video == nil || modelcatalog.ValidateVideoCapabilityConfig(profile.Video) != nil {
			input.VideoCapability = nil
			return nil
		}
		input.VideoCapability = profile.Video
		applyFixedVideoResolution(input, profile.Video)
		return nil
	}
	channelID := strings.TrimSpace(input.Config.ChannelID)
	if channelID == "" {
		profile := input.Config.CapabilityConfig
		if profile == nil || profile.Video == nil {
			seedance2 := modelcatalog.IsSeedance2Family(input.Config.InterfaceType, input.Config.Model)
			if input.Config.InterfaceType != string(model.ChannelInterfaceAgnesVideo) && !seedance2 {
				return nil
			}
			profile = DefaultModelCapabilityConfigForModel(input.Config.InterfaceType, input.Config.Model)
		}
		normalized, err := NormalizeModelCapabilityConfigForModel("video", input.Config.InterfaceType, input.Config.Model, profile)
		if err != nil || normalized == nil || normalized.Video == nil {
			return nil
		}
		input.Config.CapabilityConfig = normalized
		restoreBeefAPISeedanceAudioControl(ctx, input.Config, normalized.Video)
		input.VideoCapability = normalized.Video
		applyFixedVideoResolution(input, normalized.Video)
		return nil
	}
	item, err := s.repo.ChannelModelByKey(channelID, providerChannelModelKey(input.Config))
	if err != nil {
		return errors.New("当前系统渠道模型未配置或已停用")
	}
	profile, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if err != nil || profile == nil || profile.Video == nil {
		return errors.New("当前视频模型尚未配置能力参数")
	}
	normalized, err := NormalizeModelCapabilityConfigForModel("video", string(item.Protocol), firstNonEmpty(item.ProviderModelKey, item.ModelKey), profile)
	if err != nil || normalized == nil || normalized.Video == nil {
		return errors.New("当前视频模型能力参数无效")
	}
	input.VideoCapability = normalized.Video
	restoreBeefAPISeedanceAudioControl(ctx, input.Config, normalized.Video)
	applyFixedVideoResolution(input, normalized.Video)
	return nil
}
