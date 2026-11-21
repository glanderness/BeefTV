import { beefTVVideoContract } from "@/lib/beeftv-video-contracts";
import { CANVAS_IMAGE_SLOT_KIND_SOURCE } from "@/lib/canvas/canvas-resource-references";
import { videoPrefersReferenceMode, videoReferencesForOperation, videoSupportsAdvancedControls, type VideoCapabilityConfig } from "@/lib/model-capabilities";
import { isBeefTVModelRoute } from "@/lib/model-selection";
import type { CanvasNodeMetadata, CanvasVideoReferenceMode } from "@/types/canvas";

export { isBeefTVModelRoute };

export type VideoReferenceCandidate = {
    nodeId: string;
    kind: "text" | "image" | "video" | "audio" | "character" | "skill";
    label: string;
    title?: string;
    active?: boolean;
};

export type VideoReferenceModeState = {
    mode: CanvasVideoReferenceMode;
    canSelectFrames: boolean;
    canSelectAll: boolean;
    framesDisabledReason?: string;
    allDisabledReason?: string;
    endFrameSupported: boolean;
    startFrameNodeId?: string;
    endFrameNodeId?: string;
    promptFirstFrameNodeId?: string;
};

const IMAGE_SLOT_MENTION_SOURCE = `@(?:${CANVAS_IMAGE_SLOT_KIND_SOURCE})(\\d+)`;
const FIRST_FRAME_CLAUSE_BODY = `(?:以\\s*)?(?:@\\[node:([^\\]]+)\\]|${IMAGE_SLOT_MENTION_SOURCE})\\s*(?:[:：]?\\s*)?作为(?:本镜头(?:的)?|起始)?首帧(?:画面)?`;

const PROMPT_FIRST_FRAME_CLAUSE = new RegExp(`(?:^|[，,。；;\\n\\s])${FIRST_FRAME_CLAUSE_BODY}`, "u");

const GLOBAL_FIRST_FRAME_CLAUSE = new RegExp(`(?:^|[，,。；;\\s]+)${FIRST_FRAME_CLAUSE_BODY}[，,。；;\\s]*`, "gu");

export function findPromptFirstFrameNodeId(prompt: string, imageRefs: VideoReferenceCandidate[]): string | undefined {
    const activeImages = imageRefs.filter((ref) => ref.active !== false && ref.kind === "image");
    const match = PROMPT_FIRST_FRAME_CLAUSE.exec(prompt);
    if (!match) return undefined;
    const [, nodeId, imageIndex] = match;
    if (nodeId) {
        return activeImages.find((ref) => ref.nodeId === nodeId)?.nodeId;
    }
    if (imageIndex) {
        return activeImages.find((ref) => ref.label.trim() === `图片${imageIndex}`)?.nodeId;
    }
    return undefined;
}

export function stripPromptFirstFrameClauses(prompt: string): string {
    return prompt
        .replace(GLOBAL_FIRST_FRAME_CLAUSE, (fullMatch, _nodeId: string | undefined, _imageIndex: string | undefined, offset: number) => {
            if (offset === 0) return "";
            const leadingPunct = /^[，,。；;\s]+/u.exec(fullMatch)?.[0] || "";
            return leadingPunct.includes("\n") ? "\n" : "，";
        })
        .replace(/^[，,。；;\s]+/u, "")
        .replace(/[，,。；;\s]+$/u, (tail) => (tail.includes("\n") ? "\n" : ""));
}

export type VideoCapabilityFlagSupport = "supported" | "unsupported" | "opaque";
export type VideoMiddleFrameSupport = VideoCapabilityFlagSupport;

// Resolve card groups only after character images/voices have been hydrated.
// Explicit prompt mentions may select a subset of the connected nodes.
export function resolveVideoReferenceOrder(order: string[] | undefined, media: Array<{ id: string; sourceNodeId?: string }>): string[] | undefined {
    if (!order) return undefined;
    const resolved: string[] = [];
    const append = (id: string) => {
        if (!resolved.includes(id)) resolved.push(id);
    };
    for (const nodeId of order) {
        for (const item of media) if (item.id === nodeId || item.sourceNodeId === nodeId) append(item.id);
    }
    for (const item of media) append(item.id);
    return resolved;
}

export function resolveVideoMiddleFrameSupport(
    _model: string,
    videoProfile?: VideoCapabilityConfig | null,
    _hasDeclaredCapability = false,
    _isBeefTVRoute?: boolean,
): VideoMiddleFrameSupport {
    if (videoProfile?.middleFrame === true) return "supported";
    if (videoProfile?.middleFrame === false) return "unsupported";
    return "opaque";
}

export function resolveVideoReferenceOrderSupport(
    videoProfile?: VideoCapabilityConfig | null,
    _hasDeclaredCapability = false,
): VideoCapabilityFlagSupport {
    if (videoProfile?.referenceOrder === true) return "supported";
    if (videoProfile?.referenceOrder === false) return "unsupported";
    return "opaque";
}

export function resolveVideoControlsSupport(
    videoProfile?: VideoCapabilityConfig | null,
    _hasDeclaredCapability = false,
): VideoCapabilityFlagSupport {
    if (videoSupportsAdvancedControls(videoProfile)) return "supported";
    if (videoProfile?.controls !== undefined) return "unsupported";
    return "opaque";
}

export function resolveVideoReferenceCapabilities(
    model: string,
    videoProfile?: VideoCapabilityConfig | null,
    hasDeclaredCapability = false,
    isBeefTVRoute = isBeefTVModelRoute(model),
): {
    maxFrameImages: number;
    endFrameSupported: boolean;
    referenceVideoSupported: boolean;
    maxFrameAudios: number;
    middleFrameSupport: VideoMiddleFrameSupport;
    middleFrameSupported: boolean;
    referenceOrderSupport: VideoCapabilityFlagSupport;
    referenceOrderSupported: boolean;
    controlsSupport: VideoCapabilityFlagSupport;
    controlsSupported: boolean;
    preferReferenceMode: boolean;
} {
    const modelName = model.split("::").at(-1) || "";
    const contract = isBeefTVRoute ? beefTVVideoContract(modelName) : undefined;
    const middleFrameSupport = resolveVideoMiddleFrameSupport(model, videoProfile, hasDeclaredCapability, isBeefTVRoute);
    const middleFrameSupported = middleFrameSupport === "supported";
    const referenceOrderSupport = resolveVideoReferenceOrderSupport(videoProfile, hasDeclaredCapability);
    const referenceOrderSupported = referenceOrderSupport === "supported";
    const controlsSupport = resolveVideoControlsSupport(videoProfile, hasDeclaredCapability);
    const controlsSupported = controlsSupport === "supported";
    const preferReferenceMode = videoPrefersReferenceMode(videoProfile);
    const hasExplicitOpRefs = videoProfile?.operationReferences !== undefined;
    const frameRefs = videoProfile ? videoReferencesForOperation(videoProfile, "image_to_video") : undefined;

    const maxFrameImages = hasExplicitOpRefs && frameRefs
        ? Math.min(2, frameRefs.maxImages)
        : (hasDeclaredCapability || Boolean(videoProfile?.operations.includes("reference_to_video"))) && frameRefs
          ? Math.min(2, frameRefs.maxImages)
          : Math.min(2, contract?.maxReferences?.image ?? 2);
    const endFrameSupported = maxFrameImages >= 2;
    const referenceVideoSupported = Boolean(videoProfile?.operations.includes("reference_to_video"));
    const maxFrameAudios = hasExplicitOpRefs && frameRefs
        ? frameRefs.maxAudios
        : !referenceVideoSupported && hasDeclaredCapability && frameRefs
          ? frameRefs.maxAudios
          : 0;

    return {
        maxFrameImages,
        endFrameSupported,
        referenceVideoSupported,
        maxFrameAudios,
        middleFrameSupport,
        middleFrameSupported,
        referenceOrderSupport,
        referenceOrderSupported,
        controlsSupport,
        controlsSupported,
        preferReferenceMode,
    };
}

export function resolveVideoReferenceModeState({
    metadata,
    preferredMode,
    references,
    endFrameSupported = true,
    referenceVideoSupported = true,
    maxFrameAudios = 0,
    preferReferenceMode = false,
    prompt = "",
}: {
    metadata?: CanvasNodeMetadata;
    preferredMode?: CanvasVideoReferenceMode;
    references: VideoReferenceCandidate[];
    endFrameSupported?: boolean;
    referenceVideoSupported?: boolean;
    maxFrameAudios?: number;
    preferReferenceMode?: boolean;
    prompt?: string;
}): VideoReferenceModeState {
    const active = references.filter((item) => item.active !== false && item.kind !== "skill");
    const imageRefs = active.filter((item) => item.kind === "image");
    const characterCount = active.filter((item) => item.kind === "character").length;
    const visualCount = imageRefs.length + characterCount;
    const videoCount = active.filter((item) => item.kind === "video").length;
    const audioCount = active.filter((item) => item.kind === "audio").length;
    const maxFrameImages = endFrameSupported ? 2 : 1;
    const allowedFrameAudios = maxFrameAudios;

    const canSelectFrames =
        imageRefs.length >= 1 &&
        characterCount === 0 &&
        visualCount <= maxFrameImages &&
        videoCount === 0 &&
        audioCount <= allowedFrameAudios;
    const canSelectAll = referenceVideoSupported && (visualCount > 0 || videoCount > 0 || audioCount > 0);

    let framesDisabledReason: string | undefined;
    if (!canSelectFrames) {
        if (videoCount > 0) {
            framesDisabledReason = "已连接参考视频，当前为全能参考模式。如需严格锁定开场首帧，请移除参考视频并只保留 1–2 张图";
        } else if (characterCount > 0) {
            framesDisabledReason = "已连接角色卡，当前为全能参考模式。如需严格锁定上段尾帧开场，请单独连接 1–2 张关键帧，或在提示词中用 @图片N 描述开场画面并保持同景构图";
        } else if (visualCount > maxFrameImages) {
            framesDisabledReason = "首尾帧锁定仅支持 1–2 张图；连接 3 张及以上图片时为全能参考（软引导）。如需严格接上段尾帧，请只连 1–2 张关键帧，或在提示词用 @图片N 写明开场并保持起幅同景";
        } else if (audioCount > allowedFrameAudios) {
            framesDisabledReason = allowedFrameAudios > 0
                ? `首尾帧模式最多支持 ${allowedFrameAudios} 段参考音频；超出时为全能参考模式。`
                : "当前模型连接参考音频时为全能参考模式。如需严格锁定首尾帧，请先移除参考音频并只保留 1–2 张图";
        } else {
            framesDisabledReason = "请先连接 1–2 张参考图";
        }
    }
    const allDisabledReason = !canSelectAll ? "当前模型仅支持首帧/首尾帧模式，不支持全能参考" : undefined;

    const prefersAll = metadata?.videoEditOperation === "reference_to_video"
        || (!metadata?.videoEditOperation && !metadata?.videoStartFrameNodeId && !metadata?.videoEndFrameNodeId && (preferredMode === "all" || preferReferenceMode));
    const mode: CanvasVideoReferenceMode = !canSelectAll
        ? "frames"
        : !canSelectFrames || prefersAll
          ? "all"
          : "frames";

    if (mode === "all") {
        return {
            mode,
            canSelectFrames,
            canSelectAll,
            framesDisabledReason,
            allDisabledReason,
            endFrameSupported,
            promptFirstFrameNodeId: findPromptFirstFrameNodeId(prompt, imageRefs),
        };
    }

    const explicitStart = imageRefs.find((ref) => ref.nodeId === metadata?.videoStartFrameNodeId)?.nodeId;
    const explicitEnd = endFrameSupported
        ? imageRefs.find((ref) => ref.nodeId === metadata?.videoEndFrameNodeId)?.nodeId
        : undefined;
    const hasExplicitFrame = Boolean(explicitStart || explicitEnd);
    const startFrameNodeId = hasExplicitFrame ? explicitStart : imageRefs[0]?.nodeId;
    const endFrameNodeId = hasExplicitFrame
        ? explicitEnd && explicitEnd !== startFrameNodeId
            ? explicitEnd
            : undefined
        : endFrameSupported && imageRefs.length === 2
          ? imageRefs[1]?.nodeId
          : undefined;

    return {
        mode,
        canSelectFrames,
        canSelectAll,
        framesDisabledReason,
        allDisabledReason,
        endFrameSupported,
        startFrameNodeId,
        endFrameNodeId,
    };
}
