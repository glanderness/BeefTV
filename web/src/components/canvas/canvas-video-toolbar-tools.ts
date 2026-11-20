import type { ReactNode } from "react";
import type { NodeToolbarGroup } from "@/lib/canvas/tool-registry";

export type ToolbarTool = {
    section?: string;
    description?: string;
    id: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    group: NodeToolbarGroup;
    order: number;
    active?: boolean;
    danger?: boolean;
    disabled?: boolean;
};

// Conservative horizontal footprint (including 20px outer margin) for the core
// video dock items (AI超分 + 关键帧截取 + 视频二创 + 视频处理 + 视频后期 + 视频设置 + 3 utility icons).
export const VIDEO_TOOLBAR_BASE_WIDTH = 796;
const DRAFT_TO_FINAL_BUTTON_WIDTH = 112;

export type VideoToolbarInput = {
    containerWidth: number;
    registryToolbarTools: ToolbarTool[];
    canDraftToFinal?: boolean;
    onExtractVideoFrames: (preset: "current" | "first" | "last") => void;
};

export type VideoToolbarSections = {
    videoCompact: boolean;
    requiredWidth: number;
    videoProcessingTools: ToolbarTool[];
    videoSettingsTools: ToolbarTool[];
    videoPostProductionTools: ToolbarTool[];
    inlineKeyframeTools: ToolbarTool[];
};

const VIDEO_PROCESSING_IDS = [
    "trimRegenerate",
    "cropVideo",
    "extractAudio",
    "subtitleErase",
    "watermarkErase",
    "privacyProtect",
    "depthCapture",
];
const VIDEO_POST_PRODUCTION_IDS = ["subtitles", "timeline"];

function selectTools(tools: ToolbarTool[], ids: string[]) {
    return ids.flatMap((id) => {
        const tool = tools.find((entry) => entry.id === id);
        return tool ? [tool] : [];
    });
}

export function resolveMediaNodeSettingsTools(tools: ToolbarTool[], media: "image" | "video") {
    const [replace, aspectRatio] = media === "image" ? ["replace", "resize"] : ["uploadVideo", "video-aspect-ratio"];
    return selectTools(tools, [replace, aspectRatio, "node-lock", "info"]);
}

/**
 * Include draft conversion in the width so keyframe extraction folds into
 *「视频处理」before the dock runs out of space.
 */
export function resolveVideoToolbarSections(input: VideoToolbarInput): VideoToolbarSections {
    const requiredWidth = VIDEO_TOOLBAR_BASE_WIDTH + (input.canDraftToFinal ? DRAFT_TO_FINAL_BUTTON_WIDTH : 0);
    const videoCompact = input.containerWidth < requiredWidth;
    const videoProcessingTools = selectTools(input.registryToolbarTools, VIDEO_PROCESSING_IDS);
    const videoSettingsTools = resolveMediaNodeSettingsTools(input.registryToolbarTools, "video");
    const videoPostProductionTools = selectTools(input.registryToolbarTools, VIDEO_POST_PRODUCTION_IDS);
    const videoKeyframeTool = input.registryToolbarTools.find((tool) => tool.id === "extractFrames");
    const keyframeTools: ToolbarTool[] = videoKeyframeTool
        ? [
              { ...videoKeyframeTool, id: "keyframe-current", label: "截取当前帧", onClick: () => input.onExtractVideoFrames("current") },
              { ...videoKeyframeTool, id: "keyframe-first", label: "截取首帧", onClick: () => input.onExtractVideoFrames("first") },
              { ...videoKeyframeTool, id: "keyframe-last", label: "截取尾帧", onClick: () => input.onExtractVideoFrames("last") },
          ]
        : [];

    return {
        videoCompact,
        requiredWidth,
        videoSettingsTools,
        videoPostProductionTools,
        videoProcessingTools: videoCompact ? [...keyframeTools, ...videoProcessingTools] : videoProcessingTools,
        inlineKeyframeTools: videoCompact ? [] : keyframeTools,
    };
}
