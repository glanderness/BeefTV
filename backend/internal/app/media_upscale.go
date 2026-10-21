package app

import (
	"context"

	"infinite-canvas/backend/internal/generation"
)

func (s *Service) upscaleConfig(model string) (generation.Config, error) {
	key, base, _, _, err := s.lookupBeefAPICredential()
	if err != nil {
		return generation.Config{}, err
	}
	if key == "" {
		return generation.Config{}, BadAuthRequest("请先连接官方算力账号")
	}
	return generation.Config{BaseURL: base, APIKey: key, Model: model, InterfaceType: "newapi"}, nil
}

func (s *Service) MediaUpscaleCapabilities(ctx context.Context) (map[string]any, error) {
	config, err := s.upscaleConfig("")
	if err != nil {
		return nil, err
	}
	var result map[string]any
	err = generation.GetJSON(ctx, config, "/media-upscale/capabilities", &result)
	return result, err
}

func (s *Service) EstimateMediaUpscale(ctx context.Context, userID string, input generation.Input) (generation.UpscaleEstimate, error) {
	var estimate generation.UpscaleEstimate
	if generation.UpscaleMediaType(input.Config.Model) == "" {
		return estimate, BadAuthRequest("请选择可用的超分模型")
	}
	config, err := s.upscaleConfig(input.Config.Model)
	if err != nil {
		return estimate, err
	}
	input.Config = config
	ctx = s.bindGenerationRuntime(ctx, generation.CallMeta{UserID: userID, RequestKind: "estimate"})
	estimate, err = generation.EstimateUpscale(ctx, input)
	if err != nil {
		return estimate, BadAuthRequest(generation.ClassifyError(err).UserMessage())
	}
	return estimate, nil
}
