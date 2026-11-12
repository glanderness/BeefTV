import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-config";
import { normalizeImageValue, normalizeVideoValue, type ImageCapabilityConfig, type VideoCapabilityConfig } from "@/lib/model-capabilities";
import type { CostEstimate, CostEstimateTarget } from "@/services/api/cost-estimate";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasBatchRow, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";

export type InlineCostDisplay = {
    label: string;
    tooltip: string;
};

function cleanParameters(parameters: Record<string, string | undefined>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(parameters).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""),
    );
}

/**
 * 把后端 generation.estimate 返回的单项价格转成提交按钮旁的紧凑文案。
 * 自带 Key 或缺少价格表（含「暂无价格」）时不展示，避免在输入框制造噪音。
 */
export function formatInlineCostEstimate(
    estimate: CostEstimate | null | undefined,
    options?: { hideVariableRate?: boolean },
): InlineCostDisplay | null {
    const text = estimate?.text?.trim() || "";
    if (!estimate || !text || text.includes("暂无价格")) return null;
    if (typeof estimate.amount === "number") {
        const label = text.split("（")[0]?.trim() || text;
        return { label, tooltip: text };
    }
    if (typeof estimate.reserve === "number") {
        const reserveMatch = text.match(/先扣\s*¥[\d.]+/);
        const label = reserveMatch ? reserveMatch[0].replace(/\s+/g, " ") : (text.split("，")[0]?.trim() || text);
        return { label, tooltip: text };
    }
    if (options?.hideVariableRate) return null;
    const perLayerMatch = text.match(/每层\s*¥[\d.]+/);
    const label = perLayerMatch ? perLayerMatch[0].replace(/\s+/g, " ") : "按量结算";
    return { label, tooltip: text };
}

export function canvasNodeCostTarget({
    mode,
    config,
    referenceImages,
    referenceVideos,
    prompt = "",
}: {
    mode: CanvasGenerationMode;
    config: AiConfig;
    referenceImages: number;
    referenceVideos: number;
    prompt?: string;
}): CostEstimateTarget | null {
    const modelKey = config.model.trim();
    if (!modelKey || (mode !== "image" && mode !== "video" && mode !== "audio")) return null;
    if (mode === "audio") {
        const text = prompt.trim();
        if (!text) return null;
        return { modelKey, kind: "audio", parameters: { count: "1" }, text };
    }
    if (mode === "image") {
        return {
            modelKey,
            kind: "image",
            parameters: cleanParameters({
                size: config.size,
                quality: config.quality,
                count: config.count,
                seedreamMode: config.seedreamMode,
                seedreamMaxImages: config.seedreamMaxImages,
            }),
            referenceImages: Math.max(0, referenceImages),
        };
    }
    return {
        modelKey,
        kind: "video",
        parameters: cleanParameters({
            vquality: config.vquality,
            seconds: config.videoSeconds,
            count: "1",
        }),
        referenceImages: Math.max(0, referenceImages),
        referenceVideos: Math.max(0, referenceVideos),
    };
}

export function creationComposerCostTarget({
    mode,
    model,
    imageProfile,
    videoProfile,
    ratio,
    quality,
    count,
    seconds,
    videoQuality,
    referenceImages,
    referenceVideos,
}: {
    mode: "text" | "image" | "video";
    model: string;
    imageProfile: ImageCapabilityConfig;
    videoProfile: VideoCapabilityConfig;
    ratio: string;
    quality: string;
    count: string;
    seconds: string;
    videoQuality: string;
    referenceImages: number;
    referenceVideos: number;
}): CostEstimateTarget | null {
    const modelKey = model.trim();
    if (!modelKey || (mode !== "image" && mode !== "video")) return null;
    if (mode === "image") {
        const normalized = normalizeImageValue(imageProfile, { size: ratio, quality, count });
        return {
            modelKey,
            kind: "image",
            parameters: cleanParameters({
                size: normalized.size || ratio,
                quality: normalized.quality || quality,
                count: normalized.count || count,
            }),
            referenceImages: Math.max(0, referenceImages),
        };
    }
    const normalized = normalizeVideoValue(videoProfile, { seconds, ratio, resolution: videoQuality });
    return {
        modelKey,
        kind: "video",
        parameters: cleanParameters({
            vquality: (normalized.resolution ?? videoQuality).replace(/p$/i, ""),
            seconds: normalized.seconds || seconds,
            count: "1",
        }),
        referenceImages: Math.max(0, referenceImages),
        referenceVideos: Math.max(0, referenceVideos),
    };
}

export function batchTableCostTargets(
    config: AiConfig,
    rows: CanvasBatchRow[],
    nodes: CanvasNodeData[],
): CostEstimateTarget[] {
    const imageModel = buildGenerationConfig(config, undefined, "image").model;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return rows.map((row) => {
        const existing = row.outputNodeId ? byId.get(row.outputNodeId) : undefined;
        const outputNode = existing && existing.type === CanvasNodeType.Image
            ? ({ ...existing, metadata: { ...existing.metadata, model: imageModel } } as CanvasNodeData)
            : undefined;
        const generation = buildGenerationConfig(config, outputNode, "image");
        return {
            modelKey: generation.model,
            kind: "image",
            parameters: cleanParameters({
                size: generation.size,
                quality: generation.quality,
                count: generation.count,
                seedreamMode: generation.seedreamMode,
                seedreamMaxImages: generation.seedreamMaxImages,
            }),
            referenceImages: row.inputNodeIds.filter(Boolean).length,
        };
    });
}
