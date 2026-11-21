package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/protocol"
)

func normalizeCapability(value string) string { return modelcatalog.NormalizeCapability(value) }
func capabilityFromTaskType(taskType string) string {
	return modelcatalog.CapabilityFromTaskType(taskType)
}
func DefaultModelCapabilityConfig(p string) *ModelCapabilityConfig {
	return modelcatalog.DefaultModelCapabilityConfig(p)
}
func DefaultImageCapabilityConfig(p, m string) *ImageCapabilityConfig {
	return modelcatalog.DefaultImageCapabilityConfig(p, m)
}
func DefaultModelCapabilityConfigForModel(p, m string) *ModelCapabilityConfig {
	return modelcatalog.DefaultModelCapabilityConfigForModel(p, m)
}
func DecodeModelCapabilityConfig(raw string) (*ModelCapabilityConfig, error) {
	return modelcatalog.DecodeModelCapabilityConfig(raw)
}
func NormalizeModelCapabilityConfig(c, p string, in *ModelCapabilityConfig) (*ModelCapabilityConfig, error) {
	return modelcatalog.NormalizeModelCapabilityConfig(c, p, in)
}
func NormalizeModelCapabilityConfigForModel(c, p, m string, in *ModelCapabilityConfig) (*ModelCapabilityConfig, error) {
	return modelcatalog.NormalizeModelCapabilityConfigForModel(c, p, m, in)
}
func CapabilitySpecFromModelCapabilityConfig(c *ModelCapabilityConfig, cap string) (CapabilitySpec, error) {
	return modelcatalog.CapabilitySpecFromModelCapabilityConfig(c, cap)
}
func applyFixedVideoResolution(input *canvasGenerationInput, profile *VideoCapabilityConfig) {
	if input != nil {
		task := taskInputFromCanvas(*input)
		modelcatalog.ApplyFixedVideoResolution(&task, profile)
		applyTaskConfigToCanvas(input, task)
	}
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
func ModelRequestIntentFromTaskInput(input map[string]any, taskType, op string) ModelRequestIntent {
	return modelcatalog.ModelRequestIntentFromTaskInput(input, taskType, op)
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
func protocolCapabilityFromMetadata(metadata protocol.Metadata) string {
	primary := ""
	if len(metadata.Categories) > 0 {
		primary = string(metadata.Categories[0])
	}
	return modelcatalog.ProtocolCapabilityFromMetadata(modelcatalog.ProtocolMeta{ID: metadata.ID, Enabled: metadata.Enabled, UnavailableReason: metadata.UnavailableReason, PrimaryCapability: primary})
}
func isRouteDispatchUncertain(err error) bool { return modelcatalog.IsDispatchUncertain(err) }
func publicChannel(c model.ModelChannel, admin bool, models []model.ChannelModel) PublicModelChannel {
	return modelcatalog.PublicChannel(c, admin, models)
}
