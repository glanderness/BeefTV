package app

import (
	"infinite-canvas/backend/internal/modelcatalog"
)

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
func MatchCapability(spec CapabilitySpec, intent ModelRequestIntent) CapabilityMatch {
	return modelcatalog.MatchCapability(spec, intent)
}
func isRouteDispatchUncertain(err error) bool { return modelcatalog.IsDispatchUncertain(err) }
