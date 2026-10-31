package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/protocol"
)

func normalizeCapability(value string) string {
	return modelcatalog.NormalizeCapability(value)
}

func capabilityFromTaskType(taskType string) string {
	return modelcatalog.CapabilityFromTaskType(taskType)
}

func DefaultModelCapabilityConfig(protocol string) *ModelCapabilityConfig {
	return modelcatalog.DefaultModelCapabilityConfig(protocol)
}

func DefaultImageCapabilityConfig(protocol string, modelName string) *ImageCapabilityConfig {
	return modelcatalog.DefaultImageCapabilityConfig(protocol, modelName)
}

func DefaultModelCapabilityConfigForModel(protocol string, modelName string) *ModelCapabilityConfig {
	return modelcatalog.DefaultModelCapabilityConfigForModel(protocol, modelName)
}

func DecodeModelCapabilityConfig(raw string) (*ModelCapabilityConfig, error) {
	return modelcatalog.DecodeModelCapabilityConfig(raw)
}

func NormalizeModelCapabilityConfig(capability string, protocol string, input *ModelCapabilityConfig) (*ModelCapabilityConfig, error) {
	return modelcatalog.NormalizeModelCapabilityConfig(capability, protocol, input)
}

func NormalizeModelCapabilityConfigForModel(capability string, protocol string, modelName string, input *ModelCapabilityConfig) (*ModelCapabilityConfig, error) {
	return modelcatalog.NormalizeModelCapabilityConfigForModel(capability, protocol, modelName, input)
}

func CapabilitySpecFromModelCapabilityConfig(config *ModelCapabilityConfig, capability string) (CapabilitySpec, error) {
	return modelcatalog.CapabilitySpecFromModelCapabilityConfig(config, capability)
}

func applyFixedVideoResolution(input *canvasGenerationInput, profile *VideoCapabilityConfig) {
	if input == nil {
		return
	}
	task := taskInputFromCanvas(*input)
	modelcatalog.ApplyFixedVideoResolution(&task, profile)
	applyTaskConfigToCanvas(input, task)
}

func validateVideoTask(profile *VideoCapabilityConfig, input canvasGenerationInput) error {
	return modelcatalog.ValidateVideoTask(profile, taskInputFromCanvas(input))
}

func validateVideoTaskParameters(profile *VideoCapabilityConfig, input canvasGenerationInput) error {
	return modelcatalog.ValidateVideoTaskParameters(profile, taskInputFromCanvas(input))
}

func validateImageTask(profile *ImageCapabilityConfig, input canvasGenerationInput) error {
	return modelcatalog.ValidateImageTask(profile, taskInputFromCanvas(input))
}

func ModelRequestIntentFromTaskInput(input map[string]any, taskType string, operation string) ModelRequestIntent {
	return modelcatalog.ModelRequestIntentFromTaskInput(input, taskType, operation)
}

func DecodeCapabilitySpec(raw string) (CapabilitySpec, error) {
	return modelcatalog.DecodeCapabilitySpec(raw)
}

func ValidateCapabilitySpec(spec CapabilitySpec) error {
	return modelcatalog.ValidateCapabilitySpec(spec)
}

func NormalizeCapabilitySpec(spec CapabilitySpec) (CapabilitySpec, error) {
	return modelcatalog.NormalizeCapabilitySpec(spec)
}

func MatchCapability(spec CapabilitySpec, intent ModelRequestIntent) CapabilityMatch {
	return modelcatalog.MatchCapability(spec, intent)
}

func normalizeChannelModelContract(channel *model.ModelChannel, req ChannelModelRequest) (string, string, string, model.ChannelInterfaceType, error) {
	return normalizeChannelModelContractWithRegistry(protocol.Builtins(), channel, req)
}

func (s *Service) normalizeChannelModelContract(channel *model.ModelChannel, req ChannelModelRequest) (string, string, string, model.ChannelInterfaceType, error) {
	return normalizeChannelModelContractWithRegistry(s.protocolRegistry(), channel, req)
}

func normalizeChannelModelContractWithRegistry(registry *protocol.Registry, channel *model.ModelChannel, req ChannelModelRequest) (string, string, string, model.ChannelInterfaceType, error) {
	return modelcatalog.NormalizeChannelModelContract(modelcatalog.LookupFromRegistry(registry), channel, req)
}

func videoTestDefaults(profile *VideoCapabilityConfig) (string, string) {
	return modelcatalog.VideoTestDefaults(profile)
}

func imageTestDefaults(profile *ImageCapabilityConfig) (string, string) {
	return modelcatalog.ImageTestDefaults(profile)
}

func normalizeAdminChannelModelDeleteIDs(values []string) ([]string, error) {
	return modelcatalog.NormalizeAdminChannelModelDeleteIDs(values)
}

func retiredChannelModelKeys(raw string) map[string]bool {
	return modelcatalog.RetiredChannelModelKeys(raw)
}

func protocolCapabilityFromMetadata(metadata protocol.Metadata) string {
	primary := ""
	if len(metadata.Categories) > 0 {
		primary = string(metadata.Categories[0])
	}
	return modelcatalog.ProtocolCapabilityFromMetadata(modelcatalog.ProtocolMeta{
		ID:                metadata.ID,
		Enabled:           metadata.Enabled,
		UnavailableReason: metadata.UnavailableReason,
		PrimaryCapability: primary,
	})
}

func isRouteDispatchUncertain(err error) bool {
	return modelcatalog.IsDispatchUncertain(err)
}

func channelModelNames(channel model.ModelChannel) []string {
	return modelcatalog.ChannelModelNames(channel)
}

func mergeChannelRequest(req ChannelRequest, channel model.ModelChannel) ChannelRequest {
	return modelcatalog.MergeChannelRequest(req, channel)
}

func publicChannel(channel model.ModelChannel, admin bool, channelModels []model.ChannelModel) PublicModelChannel {
	return modelcatalog.PublicChannel(channel, admin, channelModels)
}

func validateChannelSortOrder(value int) error {
	return modelcatalog.ValidateChannelSortOrder(value)
}

func normalizeAdminPage(page int, limit int) (int, int) {
	return modelcatalog.NormalizeAdminPage(page, limit)
}

func channelFromRequest(req ChannelRequest, channel model.ModelChannel) (model.ModelChannel, error) {
	return modelcatalog.ApplyChannelRequest(req, channel)
}

func (s *Service) channelFromRequest(req ChannelRequest, channel model.ModelChannel) (model.ModelChannel, error) {
	return modelcatalog.ApplyChannelRequest(req, channel)
}
