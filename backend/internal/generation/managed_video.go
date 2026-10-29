package generation

import (
	"context"
	"errors"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
)

func managedLegacyVideoInput(input Input) beefapi.LegacyVideoInput {
	resolution := videoResolutionNameRequest(input.VideoCapability, input.Config.VQuality)
	if input.VideoCapability == nil && !isAutomaticVideoResolution(input.Config.VQuality) {
		resolution = NormalizeVideoResolution(input.Config.VQuality)
	}
	request := beefapi.LegacyVideoInput{Model: input.Config.Model, Prompt: WithSystemPrompt(input.Config, strings.TrimSpace(input.Prompt)), Seconds: input.Config.VideoSeconds, Resolution: resolution, AspectRatio: input.Config.Size, Metadata: input.Metadata}
	if input.Config.VideoGenerateAudio != "" {
		value := ParseBool(input.Config.VideoGenerateAudio, true)
		request.GenerateAudio = &value
	}
	if input.Config.VideoWatermark != "" {
		value := ParseBool(input.Config.VideoWatermark, false)
		request.Watermark = &value
	}
	for _, group := range BeefAPISeedanceMediaGroups(&input) {
		for _, media := range group.items {
			request.References = append(request.References, beefapi.LegacyVideoReference{ID: media.ID, Kind: group.kind, URL: firstNonEmpty(media.URL, media.DataURL)})
		}
	}
	return request
}

func runManagedLegacyVideo(ctx context.Context, input Input, policy VideoPollPolicy) (map[string]any, error) {
	id := ResumedProviderRequestID(ctx)
	if id == "" {
		if SubmissionKeyFromContext(ctx) == "" {
			return nil, RequestPreparationError{Cause: errors.New("视频任务缺少持久化提交编号")}
		}
		createCtx := WithRequestKind(ctx, "create")
		var err error
		id, err = managedMediaClient(createCtx, input.Config).CreateLegacyVideo(createCtx, SubmissionKeyFromContext(ctx), managedLegacyVideoInput(input))
		if err != nil {
			if errors.Is(err, beefapi.ErrReferencesNotUploaded) || errors.Is(err, beefapi.ErrInvalidVideoReferences) {
				return nil, RequestPreparationError{Cause: err}
			}
			return nil, SubmissionUnknownError{Cause: legacyMediaError(err)}
		}
	}
	return RunVideoPollLoop(ctx, id, policy, func(ctx context.Context) (VideoPollOutcome, error) {
		result, _, _, err := queryManagedLegacyVideoWithPolicy(ctx, input, id, policy)
		return VideoPollOutcome{Done: result != nil, Result: result}, err
	})
}
