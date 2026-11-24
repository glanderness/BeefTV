package generation

import (
	"context"
	"errors"
	"slices"
	"strconv"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/protocol"
)

type managedClientContextKey struct{}

// A frozen legacy provider ID stays on its original query contract. Tasks
// already sent through the common media envelope keep it. A new task uses the
// envelope only when BeefTV currently lists its media type; otherwise it keeps
// the existing endpoint (BeefTV enables audio and upscale separately).
func useManagedMediaEnvelope(ctx context.Context, config Config, mediaType string) (*beeftv.MediaClient, bool, error) {
	if !managedConnection(config) {
		return nil, false, nil
	}
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.ManagedMedia == nil {
		return nil, false, nil
	}
	client, _ := ctx.Value(managedClientContextKey{}).(*beeftv.MediaClient)
	if client == nil {
		client = managedMediaClient(ctx, config)
	}
	sent, err := runtime.ManagedMedia.Sent(ctx)
	if err != nil || sent {
		return client, sent, err
	}
	if config.MediaProtocolVersion != beeftv.MediaProtocolVersion || ResumedProviderRequestID(ctx) != "" {
		return nil, false, nil
	}
	discovery, err := client.Discover(ctx)
	if err != nil {
		return nil, false, RequestPreparationError{Cause: err}
	}
	return client, slices.Contains(discovery.SupportedMediaTypes, mediaType), nil
}

// The envelope sends only the controls the account catalog declares, so a new
// submission resolves that declaration first, as images do. A sent task is only
// collected, and Execute owns its send fence.
func resolveManagedVideoCapability(ctx context.Context, runtime Runtime, input *Input) error {
	if runtime.Config == nil || runtime.ManagedMedia == nil {
		return nil
	}
	sent, err := runtime.ManagedMedia.Sent(ctx)
	if err != nil {
		return err
	}
	if sent {
		return nil
	}
	// Runtime capabilities are not persisted. Restore the account declaration before freezing a new request.
	input.Mode = "video"
	if err := runtime.Config.ApplyCapabilities(ctx, input); err != nil {
		return RequestPreparationError{Cause: err}
	}
	return nil
}

func runManagedVideoTask(ctx context.Context, client *beeftv.MediaClient, input Input) (map[string]any, error) {
	runtime, _ := RuntimeFromContext(ctx)
	if err := resolveManagedVideoCapability(ctx, runtime, &input); err != nil {
		return nil, err
	}
	intent := managedLegacyVideoInput(input)
	ordered, err := beeftv.VideoIntentReferences(intent)
	if err != nil {
		return nil, RequestPreparationError{Cause: err}
	}
	var sources []beeftv.LocalMediaReference
	var localLimit int64
	if runtime.Limits != nil {
		localLimit, err = runtime.Limits.ResourceUploadBytes(ctx)
		if err != nil {
			return nil, RequestPreparationError{Cause: err}
		}
	}
	for _, group := range BeefTVSeedanceMediaGroups(&input) {
		for _, media := range group.items {
			ref := managedReference(media, "reference")
			ref.Kind = group.kind
			// Only the local upload bound applies here; the media service judges
			// each reference against the model's limits.
			ref.MaxBytes = localLimit
			sources = append(sources, ref)
		}
	}
	refs := make([]beeftv.LocalMediaReference, 0, len(ordered))
	for _, selected := range ordered {
		ref := sources[selected.SourceIndex]
		ref.Role = selected.Role
		// The managed envelope uses the generic role for non-frame media.
		if ref.Role == "reference_"+ref.Kind {
			ref.Role = "reference"
		}
		refs = append(refs, ref)
	}
	operation, err := resolveManagedVideoOperation(input, refs)
	if err != nil {
		return nil, RequestPreparationError{Cause: err}
	}
	if operation == "image_to_video" {
		assignManagedVideoDefaultFrameRoles(refs, input.VideoCapability)
	}
	options := map[string]any{}
	if intent.Seconds != "" {
		value, err := strconv.ParseFloat(intent.Seconds, 64)
		if err != nil {
			return nil, RequestPreparationError{Cause: PreparationUserError{
				Category: CategoryInvalidParams,
				Reason:   "视频时长无效",
				Action:   "请选择当前模型支持的视频时长后重试",
				Cause:    err,
			}}
		}
		options["seconds"] = value
	}
	if intent.Resolution != "" {
		options["resolution"] = intent.Resolution
	}
	if intent.AspectRatio != "" {
		options["aspect_ratio"] = intent.AspectRatio
	}
	if intent.GenerateAudio != nil {
		options["generate_audio"] = *intent.GenerateAudio
	}
	if intent.Watermark != nil {
		options["watermark"] = *intent.Watermark
	}
	if intent.ReturnLastFrame != nil {
		options["return_last_frame"] = *intent.ReturnLastFrame
	}
	if intent.DraftTaskID != "" {
		operation = "draft_to_final"
		options["draft_task_id"] = intent.DraftTaskID
		delete(options, "seconds")
		delete(options, "aspect_ratio")
		delete(options, "generate_audio")
		delete(options, "draft")
		refs = nil
	} else if intent.Draft != nil && *intent.Draft {
		options["draft"] = true
	}
	if controls, ok := input.Metadata["videoH3Options"].(map[string]any); ok {
		for _, key := range []string{"seed", "prompt_expansion_mode", "damage_level", "enable_safety_checker"} {
			if value, exists := controls[key]; exists {
				options[key] = value
			}
		}
	}
	if value, exists := input.Metadata["videoMiddleFrameTime"]; exists {
		options["middle_frame_time"] = value
	}
	applyManagedVideoTaskTypeConstraints(input.VideoCapability, operation, refs, options)
	request := beeftv.MediaRequest{TaskRef: SubmissionKeyFromContext(ctx), MediaType: "video", Model: input.Config.Model, Operation: operation, Options: options}
	request.Input.Prompt = intent.Prompt
	return executeManagedMedia(ctx, client, request, refs)
}

func applyManagedVideoTaskTypeConstraints(profile *modelcatalog.VideoCapabilityConfig, operation string, refs []beeftv.LocalMediaReference, options map[string]any) {
	if profile == nil || !profile.TaskTypeConstraints || operation == "draft_to_final" {
		return
	}
	hasVideo := false
	hasFrameRole := false
	for _, ref := range refs {
		if ref.Kind == "video" {
			hasVideo = true
		}
		if ref.Kind == "image" && (ref.Role == "first_frame" || ref.Role == "last_frame") {
			hasFrameRole = true
		}
	}
	lockAdaptiveRatio, forceAutoDuration := protocol.ResolveVideoTaskTypeConstraints(operation, hasVideo, hasFrameRole)
	if forceAutoDuration {
		options["seconds"] = float64(-1)
	}
	if lockAdaptiveRatio {
		options["aspect_ratio"] = "adaptive"
	}
}

func resolveManagedVideoOperation(input Input, refs []beeftv.LocalMediaReference) (string, error) {
	storedOp := metadataString(input.Metadata, "videoEditOperation")
	var imageRefs, videoRefs, audioRefs int
	var hasExplicitFrame, hasMiddleFrame bool
	for _, ref := range refs {
		if ref.Role == "first_frame" || ref.Role == "last_frame" || ref.Role == "middle_frame" {
			hasExplicitFrame = true
			if ref.Role == "middle_frame" {
				hasMiddleFrame = true
			}
		}
		switch ref.Kind {
		case "image":
			imageRefs++
		case "video":
			videoRefs++
		case "audio":
			audioRefs++
		}
	}
	profile := input.VideoCapability
	if profile != nil {
		if profile.MiddleFrame == nil || !*profile.MiddleFrame {
			hasMiddleFrame = false
		}
		resolved := modelcatalog.ResolveVideoOperation(profile, modelcatalog.VideoOperationInput{
			StoredOperation:  storedOp,
			ImageCount:       imageRefs,
			VideoCount:       videoRefs,
			AudioCount:       audioRefs,
			HasExplicitFrame: hasExplicitFrame,
			HasMiddleFrame:   hasMiddleFrame,
			HasDraftTask:     metadataString(input.Metadata, "videoDraftTaskId") != "",
			Declared:         true,
		})
		if resolved != "" {
			if len(profile.Operations) > 0 && !slices.Contains(profile.Operations, resolved) {
				return "", errors.New("当前视频模型不支持该生成模式")
			}
			return resolved, nil
		}
		if len(refs) == 0 {
			defaultOp := profile.DefaultOperation
			if defaultOp == "" {
				defaultOp = "text_to_video"
			}
			if len(profile.Operations) > 0 && !slices.Contains(profile.Operations, defaultOp) {
				return "", errors.New("当前视频模型不支持该生成模式")
			}
			return defaultOp, nil
		}
		if hasExplicitFrame && slices.Contains(profile.Operations, "image_to_video") {
			return "image_to_video", nil
		}
		if slices.Contains(profile.Operations, "reference_to_video") {
			return "reference_to_video", nil
		}
		return "", errors.New("当前视频模型不支持当前参考素材组合")
	}
	if storedOp != "" {
		return storedOp, nil
	}
	if len(refs) == 0 {
		return "text_to_video", nil
	}
	if hasExplicitFrame {
		return "image_to_video", nil
	}
	return "reference_to_video", nil
}

func assignManagedVideoDefaultFrameRoles(refs []beeftv.LocalMediaReference, profile *modelcatalog.VideoCapabilityConfig) {
	var imageIndices []int
	for i, ref := range refs {
		if ref.Role == "first_frame" || ref.Role == "last_frame" || ref.Role == "middle_frame" {
			return
		}
		switch ref.Kind {
		case "video":
			return
		case "image":
			imageIndices = append(imageIndices, i)
		}
	}
	frameMaxImages, _ := modelcatalog.VideoFrameLimits(profile, profile != nil)
	if len(imageIndices) == 0 || len(imageIndices) > frameMaxImages {
		return
	}
	refs[imageIndices[0]].Role = "first_frame"
	if len(imageIndices) == 2 && frameMaxImages >= 2 {
		refs[imageIndices[1]].Role = "last_frame"
	}
}
