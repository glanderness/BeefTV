package operations

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"

	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/providerpreset"
)

func resolveVideoMiddleFrameSupport(videoProfile *modelcatalog.VideoCapabilityConfig) string {
	if videoProfile != nil && videoProfile.MiddleFrame != nil {
		if *videoProfile.MiddleFrame {
			return "supported"
		}
		return "unsupported"
	}
	return "opaque"
}

func resolveVideoReferenceOrderSupport(videoProfile *modelcatalog.VideoCapabilityConfig) string {
	if videoProfile != nil && videoProfile.ReferenceOrder != nil {
		if *videoProfile.ReferenceOrder {
			return "supported"
		}
		return "unsupported"
	}
	return "opaque"
}

func resolveVideoControlsSupport(videoProfile *modelcatalog.VideoCapabilityConfig) string {
	if videoProfile != nil && videoProfile.Controls != nil {
		if videoProfile.Controls.HasAny() {
			return "supported"
		}
		return "unsupported"
	}
	return "opaque"
}

func normalizeVideoGenerationControls(controls *modelcatalog.VideoGenerationControlsCapability, raw any) (map[string]any, bool) {
	if controls == nil {
		return nil, false
	}
	source, ok := raw.(map[string]any)
	if !ok || len(source) == 0 {
		return nil, false
	}
	next := map[string]any{}
	if controls.Seed != nil && *controls.Seed {
		switch seed := source["seed"].(type) {
		case float64:
			if !math.IsNaN(seed) && !math.IsInf(seed, 0) && math.Trunc(seed) == seed && math.Abs(seed) <= 9007199254740991 {
				next["seed"] = seed
			}
		case int:
			next["seed"] = seed
		case int64:
			if seed >= -9007199254740991 && seed <= 9007199254740991 {
				next["seed"] = seed
			}
		case json.Number:
			if v, err := seed.Int64(); err == nil && v >= -9007199254740991 && v <= 9007199254740991 {
				next["seed"] = v
			}
		}
	}
	if mode, ok := source["prompt_expansion_mode"].(string); ok && len(controls.PromptExpansionModes) > 0 && slices.Contains(controls.PromptExpansionModes, mode) {
		next["prompt_expansion_mode"] = mode
	}
	if level, ok := source["damage_level"].(string); ok && len(controls.DamageLevels) > 0 && slices.Contains(controls.DamageLevels, level) {
		next["damage_level"] = level
	}
	if safety, ok := source["enable_safety_checker"].(bool); ok {
		next["enable_safety_checker"] = safety
	}
	if syncMode, ok := source["sync_mode"].(bool); ok {
		next["sync_mode"] = syncMode
	}
	if len(next) == 0 {
		return nil, false
	}
	return next, true
}

func reconcileCanvasVideoTarget(domain Domain, modelKey string, refs []string, graph generationDependencyGraph, nodeMeta map[string]any, parameters map[string]string, metadata map[string]any) (map[string]any, error) {
	if strings.TrimSpace(dependencyString(nodeMeta, "videoDraftTaskId")) != "" {
		return metadata, nil
	}
	var rawVideoProfile, videoProfile *modelcatalog.VideoCapabilityConfig
	declared := false
	chID, modelID := modelcatalog.SplitModelKey(modelKey)
	managedBeefTV := strings.EqualFold(strings.TrimSpace(chID), "beeftv")
	if reader, ok := domain.(ModelCatalogReader); ok && reader != nil {
		if catalog, err := reader.AgentModelCatalog(); err == nil && catalog != nil {
			if foundChID, foundModel, found := findEstimateModel(catalog, modelKey); found {
				if foundModel.ManagedBeefTV != nil {
					managedBeefTV = *foundModel.ManagedBeefTV
				} else {
					managedBeefTV = strings.EqualFold(strings.TrimSpace(foundChID), "beeftv")
				}
				if capCfg := estimateCapability(foundModel.CapabilityConfig); capCfg != nil && capCfg.Video != nil {
					rawVideoProfile = capCfg.Video
					declared = foundModel.CapabilityDeclared == nil || *foundModel.CapabilityDeclared
					if declared || slices.Contains(capCfg.Video.Operations, "reference_to_video") {
						videoProfile = capCfg.Video
					}
				}
			} else if len(catalog.Channels) > 0 {
				managedBeefTV = false
			}
		}
	}
	var contract providerpreset.VideoContract
	hasContract := false
	if managedBeefTV {
		if routeContract, ok := providerpreset.BeefTVVideoContract(modelID); ok {
			contract, hasContract = routeContract, true
		}
	}
	middleFrameSupport := resolveVideoMiddleFrameSupport(rawVideoProfile)
	if middleFrameSupport == "unsupported" {
		delete(parameters, "videoMiddleFrameNodeId")
		delete(metadata, "videoMiddleFrameTime")
	}
	if resolveVideoReferenceOrderSupport(rawVideoProfile) == "unsupported" {
		delete(metadata, "videoReferenceOrder")
	}
	switch resolveVideoControlsSupport(rawVideoProfile) {
	case "unsupported":
		delete(metadata, "videoH3Options")
	case "supported":
		if metadata != nil {
			if rawControls, present := metadata["videoH3Options"]; present {
				if normalized, ok := normalizeVideoGenerationControls(rawVideoProfile.Controls, rawControls); ok {
					metadata["videoH3Options"] = normalized
				} else {
					delete(metadata, "videoH3Options")
				}
			}
		}
	}
	storedOp := strings.TrimSpace(dependencyString(nodeMeta, "videoEditOperation"))
	if storedOp != "" && !slices.Contains([]string{"text_to_video", "image_to_video", "audio_to_video", "reference_to_video"}, storedOp) {
		return metadata, nil
	}
	var imageCount, characterCount, videoCount, audioCount int
	directImageRefIDs := make([]string, 0, len(refs))
	for _, refID := range refs {
		refMeta := dependencyMetadata(graph.nodes[refID])
		if dependencyString(refMeta, "workflowKind") == "character" {
			characterCount++
			continue
		}
		switch graph.label(refID) {
		case "角色":
			characterCount++
		case "图片", "绘图":
			imageCount++
			directImageRefIDs = append(directImageRefIDs, refID)
		case "视频":
			videoCount++
		case "音频":
			audioCount++
		}
	}
	visualCount := imageCount + characterCount
	supportsRefVideo := videoProfile != nil && slices.Contains(videoProfile.Operations, "reference_to_video")
	supportsImageVideo := videoProfile == nil || slices.Contains(videoProfile.Operations, "image_to_video")
	supportsAudioVideo := videoProfile != nil && slices.Contains(videoProfile.Operations, "audio_to_video")
	contractFrameMaxImages := 0
	if videoProfile == nil && hasContract && !declared {
		if maxImg, ok := contract.MaxReferences["image"]; ok {
			contractFrameMaxImages = min(2, maxImg)
		}
	}
	frameMaxImages, frameMaxAudios := modelcatalog.VideoFrameLimits(videoProfile, declared)
	if videoProfile == nil && contractFrameMaxImages > 0 {
		frameMaxImages = contractFrameMaxImages
	}
	audioMaxAudios := modelcatalog.VideoAudioMaxAudios(videoProfile)
	if declared && !supportsRefVideo {
		if err := validateDeclaredFrameOnlyReferences(visualCount, videoCount, audioCount, supportsImageVideo, supportsAudioVideo, frameMaxImages, frameMaxAudios, audioMaxAudios); err != nil {
			return nil, err
		}
	}
	if frameMaxImages < 2 && (declared || hasContract) {
		delete(parameters, "videoEndFrameNodeId")
	}
	hasMiddleFrame := middleFrameSupport == "supported" && parameters["videoMiddleFrameNodeId"] != ""
	hasExplicitFrame := parameters["videoStartFrameNodeId"] != "" || parameters["videoEndFrameNodeId"] != "" || parameters["videoMiddleFrameNodeId"] != ""
	nextOp := modelcatalog.ResolveVideoOperation(videoProfile, modelcatalog.VideoOperationInput{
		StoredOperation:  storedOp,
		ImageCount:       imageCount,
		CharacterCount:   characterCount,
		VideoCount:       videoCount,
		AudioCount:       audioCount,
		HasExplicitFrame: hasExplicitFrame,
		HasMiddleFrame:   hasMiddleFrame,
		Declared:         declared,
		ReconcileStored:  true,
		FrameMaxImages:   contractFrameMaxImages,
	})
	if nextOp != "" && nextOp != storedOp {
		if metadata == nil {
			metadata = map[string]any{}
		}
		metadata["videoEditOperation"] = nextOp
	}
	if nextOp == "image_to_video" && !hasExplicitFrame && videoCount == 0 && characterCount == 0 && len(directImageRefIDs) > 0 && len(directImageRefIDs) <= frameMaxImages && audioCount <= frameMaxAudios {
		parameters["videoStartFrameNodeId"] = directImageRefIDs[0]
		if frameMaxImages >= 2 && len(directImageRefIDs) == 2 {
			parameters["videoEndFrameNodeId"] = directImageRefIDs[1]
		}
	}
	if nextOp == "reference_to_video" && (middleFrameSupport == "unsupported" || nextOp != storedOp) && middleFrameSupport != "supported" {
		delete(parameters, "videoStartFrameNodeId")
		delete(parameters, "videoEndFrameNodeId")
		delete(parameters, "videoMiddleFrameNodeId")
		delete(metadata, "videoMiddleFrameTime")
	}
	return metadata, nil
}

func validateDeclaredFrameOnlyReferences(visualCount, videoCount, audioCount int, supportsImageVideo, supportsAudioVideo bool, frameMaxImages, frameMaxAudios, audioMaxAudios int) error {
	if videoCount > 0 {
		return InvalidArg("video_reference_video_unsupported", "当前视频模型不支持参考视频")
	}
	if visualCount > 0 {
		if !supportsImageVideo {
			return InvalidArg("video_reference_image_limit", "当前视频模型不支持参考图")
		}
		if visualCount > frameMaxImages {
			return InvalidArg("video_reference_image_limit", fmt.Sprintf("当前视频模型最多支持 %d 张首尾帧参考图", frameMaxImages))
		}
		if audioCount > frameMaxAudios {
			if frameMaxAudios == 0 {
				return InvalidArg("video_reference_audio_limit", "当前视频模型图生视频不支持参考音频")
			}
			return InvalidArg("video_reference_audio_limit", fmt.Sprintf("当前视频模型最多支持 %d 段参考音频", frameMaxAudios))
		}
		return nil
	}
	if audioCount > 0 {
		if !supportsAudioVideo || audioMaxAudios == 0 {
			return InvalidArg("video_reference_audio_limit", "当前视频模型不支持仅用音频生成视频")
		}
		if audioCount > audioMaxAudios {
			return InvalidArg("video_reference_audio_limit", fmt.Sprintf("当前视频模型最多支持 %d 段参考音频", audioMaxAudios))
		}
	}
	return nil
}
