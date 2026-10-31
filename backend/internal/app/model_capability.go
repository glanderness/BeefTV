package app

import (
	"context"
	"encoding/json"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
)

func (s *Service) ValidateTaskCapability(input map[string]any) error {
	encoded, err := json.Marshal(input)
	if err != nil {
		return BadAuthRequest("任务输入格式无效")
	}
	var taskInput canvasGenerationInput
	if err := json.Unmarshal(encoded, &taskInput); err != nil {
		return BadAuthRequest("任务参数格式无效，请检查模型设置后重新提交")
	}
	if taskInput.Mode != "image" && taskInput.Mode != "video" && taskInput.Mode != "audio" {
		return nil
	}
	// Stamp only newly admitted commands. Frozen tasks without this marker keep
	// their original execution protocol; resolving credentials must not upgrade it.
	if taskInput.Config.CredentialRef == managedBeefAPIRef {
		if config, ok := input["config"].(map[string]any); ok {
			config["mediaProtocolVersion"] = beefapi.MediaProtocolVersion
		}
	}
	if taskInput.Mode == "video" && taskInput.Config.CredentialRef == managedBeefAPIRef {
		if err := s.resolveVideoCapability(context.Background(), &taskInput); err != nil {
			return err
		}
		if config, ok := input["config"].(map[string]any); ok {
			config["capabilityConfig"] = taskInput.Config.CapabilityConfig
			config["videoCapabilitiesVersion"] = taskInput.Config.VideoCapabilitiesVersion
		}
	}
	if isWorkflowProviderInterface(taskInput.Config.InterfaceType) {
		return validateWorkflowProviderConfig(taskInput.Mode, taskInput.Config)
	}
	validated, err := modelcatalog.ValidateConfiguredTask(taskInputFromCanvas(taskInput), s.channelModelLookup())
	if err != nil {
		return err
	}
	if config, ok := input["config"].(map[string]any); ok {
		config["vquality"] = validated.Config.VQuality
	}
	return nil
}

func (s *Service) channelModelLookup() modelcatalog.ChannelModelLookup {
	return func(channelID, modelKey string) (*model.ChannelModel, error) {
		return s.repo.ChannelModelByKey(channelID, modelKey)
	}
}
