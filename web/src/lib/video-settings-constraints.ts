import { isVideoReferenceMode, modelCapabilityConfigFor, videoSupportsMiddleFrame, type VideoCapabilityConfig } from "./model-capabilities";
import { resolveVideoOperation } from "./model-selection";
import { seedanceSettingsConstraints, type SeedanceSettingsConstraints } from "./seedance-task-constraints";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeMetadata } from "@/types/canvas";

export type VideoSettingsConstraints = SeedanceSettingsConstraints & { ratioHelp?: string };

function usesKeyframeRatioConstraints(videoProfile?: VideoCapabilityConfig | null): boolean {
    if (!videoProfile || videoProfile.taskTypeConstraints) return false;
    return (
        videoProfile.operationReferences?.image_to_video !== undefined ||
        videoProfile.middleFrame !== undefined ||
        videoProfile.preferReferenceMode !== undefined
    );
}

export function videoSettingsConstraints(
    config: AiConfig,
    input: { imageCount?: number; videoCount?: number; audioCount?: number; characterCount?: number },
    metadata?: Pick<CanvasNodeMetadata, "videoEditOperation" | "videoStartFrameNodeId" | "videoEndFrameNodeId" | "videoMiddleFrameNodeId">,
): VideoSettingsConstraints {
    const imageCount = input.imageCount || 0;
    const videoCount = input.videoCount || 0;
    const audioCount = input.audioCount || 0;
    const first = metadata?.videoStartFrameNodeId;
    const last = metadata?.videoEndFrameNodeId;
    const hasExplicitFrame = Boolean(first || last || metadata?.videoMiddleFrameNodeId);
    const videoProfile = modelCapabilityConfigFor(config, config.model).video;
    if (usesKeyframeRatioConstraints(videoProfile)) {
        // Canvas submission resolves the operation before building the provider payload.
        const counts = { textCount: 0, imageCount, videoCount, audioCount, characterCount: 0 };
        const resolvedOperation = resolveVideoOperation(counts, metadata?.videoEditOperation, videoProfile, { hasExplicitFrame });
        const referenceMode = isVideoReferenceMode(videoProfile, counts, { ...metadata, videoEditOperation: resolvedOperation });
        if (referenceMode) return {};
        if (input.characterCount) {
            // A card can expand into several views and change the submission mode.
            const supportsReferenceVideo = Boolean(videoProfile?.operations.includes("reference_to_video"));
            const ratioHelp = first || last
                ? videoSupportsMiddleFrame(videoProfile)
                    ? "首尾帧生成不能混用角色参考图；多素材参考生成可组合关键帧与角色参考图，使用所选比例。"
                    : "角色卡带参考图时，不能与指定的首尾帧同时使用。请移除角色卡，或取消首尾帧指定后再生成。"
                : !supportsReferenceVideo
                    ? "角色卡带参考图时，视频比例由参考图决定；所选比例只在没有参考图时生效。"
                    : "首尾帧生成时，比例随实际参考图；多素材参考生成使用所选比例。";
            return { ratioHelp };
        }
        if (!imageCount) return {};
        const frame = last && !first ? "尾帧" : "首帧";
        return {
            ratioLabel: `随${frame}图片`,
            ratioHelp: `视频比例由${frame}图片决定。需要其他比例时，请先裁切或扩图，再生成视频。`,
        };
    }
    return seedanceSettingsConstraints(videoProfile, imageCount, videoCount, audioCount, metadata?.videoEditOperation, Boolean(first || last));
}
