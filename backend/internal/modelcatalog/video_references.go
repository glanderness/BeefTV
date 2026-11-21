package modelcatalog

import (
	"fmt"
	"slices"
	"strings"

	"infinite-canvas/backend/internal/kernel"
)

type VideoOperationInput struct {
	StoredOperation  string
	ImageCount       int
	CharacterCount   int
	VideoCount       int
	AudioCount       int
	HasExplicitFrame bool
	HasMiddleFrame   bool
	HasDraftTask     bool
	Declared         bool
	ReconcileStored  bool
	FrameMaxImages   int
}

// ResolveVideoOperation is the single backend resolver for video task operations
// across canvas target reconciliation, capability validation, and managed wire dispatch.
func ResolveVideoOperation(profile *VideoCapabilityConfig, input VideoOperationInput) string {
	if input.HasDraftTask {
		return "draft_to_final"
	}
	storedOp := strings.TrimSpace(input.StoredOperation)
	if storedOp != "" && (!input.ReconcileStored || !slices.Contains([]string{"text_to_video", "image_to_video", "audio_to_video", "reference_to_video"}, storedOp)) {
		return storedOp
	}
	visualCount := input.ImageCount + input.CharacterCount
	totalMedia := visualCount + input.VideoCount + input.AudioCount
	supportsRef := profile != nil && slices.Contains(profile.Operations, "reference_to_video")
	supportsImg := profile == nil || slices.Contains(profile.Operations, "image_to_video")
	supportsAud := profile != nil && slices.Contains(profile.Operations, "audio_to_video")
	preferRef := profile != nil && profile.PreferReferenceMode != nil && *profile.PreferReferenceMode

	frameMaxImages, frameMaxAudios := VideoFrameLimits(profile, input.Declared)
	if profile == nil && input.FrameMaxImages > 0 {
		frameMaxImages = min(2, input.FrameMaxImages)
	}
	frameMinImages := 0
	if profile != nil {
		frameMinImages = VideoReferencesForOperation(profile, "image_to_video").MinImages
	}
	audioMaxAudios := VideoAudioMaxAudios(profile)

	imageFrameAllowed := supportsImg && input.VideoCount == 0 && input.CharacterCount == 0 &&
		input.ImageCount > 0 && input.ImageCount >= frameMinImages && input.ImageCount <= frameMaxImages && input.AudioCount <= frameMaxAudios
	audioOnlyAllowed := supportsAud && visualCount == 0 && input.VideoCount == 0 &&
		input.AudioCount > 0 && (profile == nil || input.AudioCount <= audioMaxAudios)

	if supportsRef && totalMedia > 0 {
		needsRef := input.HasMiddleFrame ||
			input.VideoCount > 0 ||
			input.CharacterCount > 0 ||
			visualCount > frameMaxImages ||
			(visualCount > 0 && visualCount < frameMinImages) ||
			(visualCount > 0 && input.AudioCount > frameMaxAudios) ||
			(visualCount == 0 && input.VideoCount == 0 && input.AudioCount > 0 && !audioOnlyAllowed) ||
			(storedOp == "" && preferRef && visualCount > 0 && !input.HasExplicitFrame)
		if needsRef {
			return "reference_to_video"
		}
	}
	if imageFrameAllowed {
		switch {
		case storedOp == "reference_to_video" && input.Declared && !supportsRef:
			return "image_to_video"
		case storedOp == "text_to_video":
			return "image_to_video"
		case storedOp == "" && input.Declared && !input.HasExplicitFrame:
			return "image_to_video"
		}
	}
	if audioOnlyAllowed {
		switch {
		case storedOp == "reference_to_video" && input.Declared && !supportsRef:
			return "audio_to_video"
		case storedOp == "text_to_video":
			return "audio_to_video"
		case storedOp == "" && input.Declared:
			return "audio_to_video"
		}
	}
	return storedOp
}

func videoTaskOperation(profile *VideoCapabilityConfig, input TaskInput) string {
	hasMiddle := profile != nil && profile.MiddleFrame != nil && *profile.MiddleFrame && metadataString(input.Metadata, "videoMiddleFrameNodeId") != ""
	hasExplicitFrame := metadataString(input.Metadata, "videoStartFrameNodeId") != "" ||
		metadataString(input.Metadata, "videoEndFrameNodeId") != "" ||
		metadataString(input.Metadata, "videoMiddleFrameNodeId") != ""
	resolved := ResolveVideoOperation(profile, VideoOperationInput{
		StoredOperation:  metadataString(input.Metadata, "videoEditOperation"),
		ImageCount:       len(input.ReferenceImages),
		VideoCount:       len(input.ReferenceVideos),
		AudioCount:       len(input.ReferenceAudios),
		HasExplicitFrame: hasExplicitFrame,
		HasMiddleFrame:   hasMiddle,
		HasDraftTask:     metadataString(input.Metadata, "videoDraftTaskId") != "",
		Declared:         profile != nil,
	})
	if resolved != "" {
		return resolved
	}
	if len(input.ReferenceImages) == 0 && len(input.ReferenceVideos) == 0 && len(input.ReferenceAudios) == 0 {
		if profile != nil && profile.DefaultOperation != "" {
			return profile.DefaultOperation
		}
		return "text_to_video"
	}
	if hasExplicitFrame || len(input.ReferenceImages) > 0 {
		return "image_to_video"
	}
	if len(input.ReferenceAudios) > 0 && len(input.ReferenceVideos) == 0 {
		return "audio_to_video"
	}
	return "reference_to_video"
}

func VideoReferencesForOperation(profile *VideoCapabilityConfig, operation string) VideoReferenceConfig {
	return videoReferencesForOperation(profile, operation)
}

// VideoFrameLimits returns the image and audio reference bounds for image_to_video.
func VideoFrameLimits(profile *VideoCapabilityConfig, declared bool) (maxImages, maxAudios int) {
	maxImages, maxAudios = 2, 0
	if profile == nil {
		return maxImages, maxAudios
	}
	if profile.OperationReferences != nil {
		frameRefs := VideoReferencesForOperation(profile, "image_to_video")
		return min(2, frameRefs.MaxImages), frameRefs.MaxAudios
	}
	maxImages = min(2, profile.References.MaxImages)
	if !slices.Contains(profile.Operations, "reference_to_video") && declared {
		maxAudios = profile.References.MaxAudios
	}
	return maxImages, maxAudios
}

// VideoAudioMaxAudios returns the declared audio reference bound for audio_to_video.
func VideoAudioMaxAudios(profile *VideoCapabilityConfig) int {
	if profile == nil {
		return 0
	}
	if profile.OperationReferences != nil {
		if limits, ok := profile.OperationReferences["audio_to_video"]; ok && limits.MaxAudios != nil {
			return *limits.MaxAudios
		}
	}
	return profile.References.MaxAudios
}

func videoReferencesForOperation(profile *VideoCapabilityConfig, operation string) VideoReferenceConfig {
	refs := profile.References
	limits := profile.OperationReferences[operation]
	if limits.MinImages != nil {
		refs.MinImages = *limits.MinImages
	}
	if limits.MaxImages != nil {
		refs.MaxImages = *limits.MaxImages
	}
	if limits.MaxVideos != nil {
		refs.MaxVideos = *limits.MaxVideos
	}
	if limits.MaxAudios != nil {
		refs.MaxAudios = *limits.MaxAudios
	}
	return refs
}

func validateVideoReferenceCounts(refs VideoReferenceConfig, input TaskInput) error {
	if len(input.ReferenceImages) > refs.MaxImages {
		return kernel.BadAuthRequest(fmt.Sprintf("当前生成模式最多支持 %d 张参考图", refs.MaxImages))
	}
	if len(input.ReferenceVideos) > refs.MaxVideos {
		return kernel.BadAuthRequest(fmt.Sprintf("当前生成模式最多支持 %d 个参考视频", refs.MaxVideos))
	}
	if len(input.ReferenceAudios) > refs.MaxAudios {
		return kernel.BadAuthRequest(fmt.Sprintf("当前生成模式最多支持 %d 段参考音频", refs.MaxAudios))
	}
	if len(input.ReferenceImages) < refs.MinImages {
		return kernel.BadAuthRequest(fmt.Sprintf("当前生成模式至少需要 %d 张参考图", refs.MinImages))
	}
	return nil
}
