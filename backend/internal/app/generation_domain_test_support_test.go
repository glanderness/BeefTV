package app

// Test entry points delegate to the production domain implementation.
// These private wrappers have no production callers.
import (
	"context"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/protocol"
	"io"
	"mime/multipart"
	"net/http"
	"time"
)

func withHTTPRequestRuntime(req *http.Request) *http.Request {
	if req == nil {
		return req
	}
	return req.WithContext(bindRequestReceipts(req.Context()))
}

func postJSONWithSubmissionKey(ctx context.Context, config providerConfig, path string, body interface{}, target interface{}) error {
	ctx = bindRequestReceipts(ctx)
	if generation.SubmissionKeyFromContext(ctx) == "" {
		if key, ok := ctx.Value(providerSubmissionKeyContext{}).(string); ok {
			ctx = generation.WithSubmissionKey(ctx, key)
		}
	}
	return generation.PostJSONWithSubmissionKey(ctx, config, path, body, target)
}

func getJSON(ctx context.Context, config providerConfig, path string, target interface{}) error {
	return generation.GetJSON(bindRequestReceipts(ctx), config, path, target)
}

func doBinary(req *http.Request) ([]byte, string, error) {
	return generation.DoBinary(withHTTPRequestRuntime(req))
}

func providerPollingDeadline(ctx context.Context) time.Time {
	return generation.PollingDeadline(ctx)
}

func ChannelAPIURL(baseURL string, path string) string {
	return generation.ChannelAPIURL(baseURL, path)
}

func ChannelAPIURLForProtocol(baseURL string, path string, interfaceType model.ChannelInterfaceType) string {
	return generation.ChannelAPIURLForProtocol(baseURL, path, interfaceType)
}

func writeMediaPart(writer *multipart.Writer, field string, media providerMedia) error {
	return generation.WriteMediaPart(writer, field, media)
}

func mediaBytes(media providerMedia) ([]byte, string, error) {
	return generation.MediaBytes(media)
}

func providerRequestErrorDetails(err error) (string, string) {
	return generation.ProviderRequestErrorDetails(err)
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

func postJSON(ctx context.Context, config providerConfig, path string, body interface{}, target interface{}) error {
	return generation.PostJSON(bindRequestReceipts(ctx), config, path, body, target)
}

func getExternalBinary(ctx context.Context, rawURL string) ([]byte, string, error) {
	return generation.GetExternalBinary(bindRequestReceipts(ctx), rawURL)
}

func providerDownloadURL(baseURL string, rawURL string) string {
	return generation.ProviderDownloadURL(baseURL, rawURL)
}

func doJSON(req *http.Request, target interface{}) error {
	return generation.DoJSON(withHTTPRequestRuntime(req), target)
}

func runAgentToolTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunAgentToolTask(ctx, input)
}

func claudeAgentBody(request map[string]interface{}) map[string]interface{} {
	return generation.ClaudeAgentBody(request)
}

func parseAgentToolPayload(payload map[string]interface{}, protocol string) (map[string]interface{}, error) {
	return generation.ParseAgentToolPayload(payload, protocol)
}

func newStreamingAgentParser(protocol string, emit func(string)) *streamingAgentParser {
	return generation.NewStreamingAgentParser(protocol, emit)
}

func applyTextThinking(body map[string]interface{}, input canvasGenerationInput, protocol string) {
	generation.ApplyTextThinking(body, input, protocol)
}

func textResponseInput(input canvasGenerationInput) (interface{}, error) {
	return generation.TextResponseInput(input)
}

func textChatContent(input canvasGenerationInput) (interface{}, error) {
	return generation.TextChatContent(input)
}

func postStreamingText(ctx context.Context, config providerConfig, path string, body map[string]interface{}, protocol string, onDelta func(string)) (string, error) {
	return generation.PostStreamingText(ctx, config, path, body, protocol, onDelta)
}

func parseTextEventStream(data []byte, protocol string) (string, error) {
	return generation.ParseTextEventStream(data, protocol)
}

func runVideoTaskWithPolicy(ctx context.Context, input canvasGenerationInput, pollPolicy videoPollPolicy) (map[string]interface{}, error) {
	return generation.RunVideoTaskWithPolicy(ctx, input, pollPolicy)
}

func runSeedanceVideosTask(ctx context.Context, input canvasGenerationInput, pollPolicy videoPollPolicy) (map[string]interface{}, error) {
	return generation.RunSeedanceVideosTask(ctx, input, pollPolicy)
}

func seedancePollStatusAndURL(state map[string]interface{}) (string, string) {
	return generation.SeedancePollStatusAndURL(state)
}

func beefTVVideoRequestBody(input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.BeefTVVideoRequestBody(input)
}

func runSeedanceAgentPlanVideoTask(ctx context.Context, input canvasGenerationInput, pollPolicy videoPollPolicy) (map[string]interface{}, error) {
	return generation.RunSeedanceAgentPlanVideoTask(ctx, input, pollPolicy)
}

func shouldSendNewAPIVideoImages(input canvasGenerationInput) bool {
	return generation.ShouldSendNewAPIVideoImages(input)
}

func newAPIVideoPromptText(input canvasGenerationInput) string {
	return generation.NewAPIVideoPromptText(input)
}

func seedanceVideosRequestBody(input canvasGenerationInput) (seedanceVideosRequest, error) {
	return generation.SeedanceVideosRequestBody(input)
}

func seedancePromptText(input canvasGenerationInput) string {
	return generation.SeedancePromptText(input)
}

func seedanceVideosPromptText(input canvasGenerationInput) string {
	return generation.SeedanceVideosPromptText(input)
}

func beefTVAudioURL(media providerMedia) (string, error) {
	return generation.BeefTVAudioURL(media)
}

func seedanceErrorMessage(state map[string]interface{}) string {
	return generation.SeedanceErrorMessage(state)
}

func runDeclarativeProtocolTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunDeclarativeProtocolTask(ctx, input)
}

func declarativeProtocolPollPolicy(mode string) videoPollPolicy {
	return generation.DeclarativeProtocolPollPolicy(mode)
}

func runProtocolAdapterTaskWithPolicy(ctx context.Context, input canvasGenerationInput, adapter protocol.Adapter, policy videoPollPolicy) (map[string]interface{}, error) {
	return generation.RunProtocolAdapterTaskWithPolicy(ctx, input, adapter, policy)
}

func extractProviderTaskID(body []byte) (string, error) {
	return generation.ExtractProviderTaskID(body)
}

func protocolRequestFromInput(input canvasGenerationInput) protocol.GenerationRequest {
	return generation.ProtocolRequestFromInput(input)
}

func protocolRequestBody(ctx context.Context, config providerConfig, spec protocol.RequestSpec) (io.Reader, string, error) {
	return generation.ProtocolRequestBody(ctx, config, spec)
}

func protocolRequestURL(baseURL string, spec protocol.RequestSpec) (string, error) {
	return generation.ProtocolRequestURL(baseURL, spec)
}

func retryableProtocolMediaDownload(err error) bool {
	return generation.RetryableProtocolMediaDownload(err)
}

func protocolResultError(message, taskID string, bodies ...[]byte) error {
	return generation.ProtocolResultError(message, taskID, bodies...)
}

func canonicalAgentChatBody(source *canonicalAgentRequest, claude bool) map[string]interface{} {
	return generation.CanonicalAgentChatBody(source, claude)
}

func canonicalAgentResponsesBody(source *canonicalAgentRequest) map[string]interface{} {
	return generation.CanonicalAgentResponsesBody(source)
}

func canonicalAgentToolCalls(value interface{}) []map[string]interface{} {
	return generation.CanonicalAgentToolCalls(value)
}

func isProviderTaskNotReadyError(httpErr providerHTTPError) bool {
	return generation.IsProviderTaskNotReadyError(httpErr)
}

func isSeedanceVideoConfig(config providerConfig) bool {
	return generation.IsSeedanceVideoConfig(config)
}

func normalizePixelSize(value string) string {
	return generation.NormalizePixelSize(value)
}

func normalizeSeedanceDuration(value string) int {
	return generation.NormalizeSeedanceDuration(value)
}

func normalizeSeedanceResolution(value string, interfaceType string) string {
	return generation.NormalizeSeedanceResolution(value, interfaceType)
}

func arkPrivateAssetUpstreamDetail(response map[string]interface{}) string {
	return generation.ArkPrivateAssetUpstreamDetail(response)
}

func arkPrivateAssetControlPlaneURL(ctx context.Context, region string) (string, error) {
	return generation.ArkPrivateAssetControlPlaneURL(ctx, region)
}

func requestAsMap(value interface{}) (map[string]interface{}, error) {
	return generation.RequestAsMap(value)
}

func applyModelSpecificVideoCapability(profile *VideoCapabilityConfig, protocol string, modelName string) *VideoCapabilityConfig {
	return modelcatalog.ApplyModelSpecificVideoCapability(profile, protocol, modelName)
}

func validateVideoReferenceMedia(profile *VideoCapabilityConfig, input canvasGenerationInput) error {
	return modelcatalog.ValidateVideoReferenceMedia(profile, taskInputFromCanvas(input))
}

func channelModelVariantForIntent(channelModel model.ChannelModel, intent ModelRequestIntent) *model.ChannelModelVariant {
	return modelcatalog.ChannelModelVariantForIntent(channelModel, intent)
}

func skuSelectorForIntent(intent ModelRequestIntent) map[string]string {
	return modelcatalog.SKUSelectorForIntent(intent)
}

func normalizeModelRequestOption(name string, value any) any {
	return modelcatalog.NormalizeModelRequestOption(name, value)
}

func channelModelCapabilitySpec(channelModel model.ChannelModel) (CapabilitySpec, error) {
	return modelcatalog.ChannelModelCapabilitySpec(channelModel)
}

func capabilitySpecWithVariants(spec CapabilitySpec, channelModel model.ChannelModel) CapabilitySpec {
	return modelcatalog.CapabilitySpecWithVariants(spec, channelModel)
}

func validateProductSpecWithinRoutes(product CapabilitySpec, routeSpecs []CapabilitySpec) error {
	return modelcatalog.ValidateProductSpecWithinRoutes(product, routeSpecs)
}

func capabilitySpecWithRoutePresets(spec CapabilitySpec, routes []CapabilitySpec) CapabilitySpec {
	return modelcatalog.CapabilitySpecWithRoutePresets(spec, routes)
}

func videoResolutionNameRequest(profile *VideoCapabilityConfig, value string) string {
	return modelcatalog.VideoResolutionNameRequest(profile, value)
}

func videoCapabilityAllowsAudioOnly(profile *VideoCapabilityConfig) bool {
	return modelcatalog.VideoCapabilityAllowsAudioOnly(profile)
}

func validateImageCapabilityConfig(value *ImageCapabilityConfig) error {
	return modelcatalog.ValidateImageCapabilityConfig(value)
}

func containsCapabilityString(values []string, target string) bool {
	return modelcatalog.ContainsCapabilityString(values, target)
}

func legacyImageSizeValues() []string {
	return modelcatalog.LegacyImageSizeValues()
}

func normalizeResolution(value string) string {
	return modelcatalog.NormalizeResolution(value)
}

func capabilityOptionValuesEqual(name string, candidate any, value any) bool {
	return modelcatalog.CapabilityOptionValuesEqual(name, candidate, value)
}

func validateReferenceDuration(kind string, index int, durationMs int64, minimum, maximum float64) error {
	return modelcatalog.ValidateReferenceDuration(kind, index, durationMs, minimum, maximum)
}

func enabledLogicalRouteSpecs(routes []cachedLogicalRoute) []CapabilitySpec {
	return modelcatalog.EnabledLogicalRouteSpecs(routes)
}
