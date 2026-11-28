import type { CanonicalPlanOptions } from "./timeline-canonical-plan";
import { getVisibleMediaClips } from "./timeline-to-ffmpeg";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineProject } from "@/types/timeline";

export type TimelineOutputPresetKey = "auto" | "16:9" | "9:16" | "1:1" | "custom";

export const TIMELINE_OUTPUT_PRESETS: ReadonlyArray<{
    key: Exclude<TimelineOutputPresetKey, "custom">;
    label: string;
    width?: number;
    height?: number;
}> = [
    { key: "auto", label: "自适应首素材" },
    { key: "16:9", label: "16:9 横屏 (1920×1080)", width: 1920, height: 1080 },
    { key: "9:16", label: "9:16 竖屏 (1080×1920)", width: 1080, height: 1920 },
    { key: "1:1", label: "1:1 方形 (1080×1080)", width: 1080, height: 1080 },
];

export const TIMELINE_FPS_OPTIONS = [24, 30, 60] as const;

export function getOutputPresetKey(output?: TimelineProject["output"]): TimelineOutputPresetKey {
    const width = output?.width;
    const height = output?.height;
    if (!width && !height) return "auto";
    if (width === 1920 && height === 1080) return "16:9";
    if (width === 1080 && height === 1920) return "9:16";
    if (width === 1080 && height === 1080) return "1:1";
    return "custom";
}

export function applyOutputPreset(
    current: TimelineProject["output"] | undefined,
    presetKey: Exclude<TimelineOutputPresetKey, "custom">,
): TimelineProject["output"] {
    const preset = TIMELINE_OUTPUT_PRESETS.find((item) => item.key === presetKey);
    const next: NonNullable<TimelineProject["output"]> = { ...(current || {}) };
    if (!preset || preset.key === "auto") {
        delete next.width;
        delete next.height;
    } else {
        next.width = preset.width;
        next.height = preset.height;
    }
    return next;
}

function normalizeEvenDimension(value: number | undefined, max: number): number | undefined {
    if (!value || !Number.isFinite(value) || value < 2) return undefined;
    const clamped = Math.min(max, Math.max(2, Math.round(value)));
    return clamped - (clamped % 2);
}

/**
 * 解析当前草稿的有效输出规格：显式预设直接透传；「自适应首素材」时读取首个可见视觉片段的实际尺寸。
 */
export function resolveEffectiveOutputOptions(
    draft: TimelineProject,
    nodes: CanvasNodeData[],
): CanonicalPlanOptions {
    const base = draft.output || {};
    let width = normalizeEvenDimension(base.width, 7680);
    let height = normalizeEvenDimension(base.height, 4320);

    if (!width || !height) {
        const firstVisual = getVisibleMediaClips(draft)
            .filter((clip) => clip.kind === "video" || clip.kind === "image")
            .sort((a, b) => a.startMs - b.startMs)[0];
        if (firstVisual) {
            const sourceNode = nodes.find((item) => item.id === firstVisual.nodeId);
            const rawW = firstVisual.directMedia?.width || sourceNode?.metadata?.naturalWidth;
            const rawH = firstVisual.directMedia?.height || sourceNode?.metadata?.naturalHeight;
            const resolvedW = normalizeEvenDimension(rawW, 7680);
            const resolvedH = normalizeEvenDimension(rawH, 4320);
            if (resolvedW && resolvedH) {
                width = resolvedW;
                height = resolvedH;
            }
        }
    }

    return {
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(base.fps ? { fps: base.fps } : {}),
        ...(base.sampleRate ? { sampleRate: base.sampleRate } : {}),
        burnSubtitles: base.burnSubtitles !== false,
    };
}
