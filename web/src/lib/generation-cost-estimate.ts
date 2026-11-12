import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-config";
import { normalizeImageValue, normalizeVideoValue, type ImageCapabilityConfig, type VideoCapabilityConfig } from "@/lib/model-capabilities";
import { estimateGenerationCost, type CostEstimate, type CostEstimateTarget, type GenerationCostEstimate } from "@/services/api/cost-estimate";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasBatchRow, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";

export type InlineCostDisplay = {
    label: string;
    tooltip: string;
};

export const MAX_ESTIMATE_TARGETS_PER_REQUEST = 200;

function cleanParameters(parameters: Record<string, string | undefined>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(parameters).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""),
    );
}

function roundFour(value: number): number {
    return Math.round(value * 10000) / 10000;
}

export function formatCnyTotal(value: number): string {
    const rounded = value < 1 ? roundFour(value) : Math.round(value * 100) / 100;
    return `¥${Number(rounded.toFixed(value < 1 ? 4 : 2))}`;
}

/**
 * 把后端 generation.estimate 返回的单项价格转成提交按钮旁的紧凑文案。
 * 定价与预冻结金额直接由结构化字段格式化，不依赖解释说明句式；自带 Key 或缺少价格表时不展示。
 */
export function formatInlineCostEstimate(
    estimate: CostEstimate | null | undefined,
    options?: { hideVariableRate?: boolean },
): InlineCostDisplay | null {
    if (!estimate) return null;
    const text = estimate.text?.trim() || "";
    if (typeof estimate.amount === "number" && Number.isFinite(estimate.amount)) {
        const label = `${estimate.approx ? "约 " : "预计 "}${formatCnyTotal(estimate.amount)}`;
        return { label, tooltip: text || label };
    }
    if (typeof estimate.reserve === "number" && Number.isFinite(estimate.reserve)) {
        const label = `先扣 ${formatCnyTotal(estimate.reserve)}`;
        return { label, tooltip: text || label };
    }
    if (!text || text.includes("暂无价格") || options?.hideVariableRate) return null;
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

const BATCH_ESTIMATE_FALLBACK_TEXT = "预计费用：暂时算不出，按所选渠道实际计费";

export async function estimateBatchCostSummaryText(
    targets: CostEstimateTarget[],
    signal?: AbortSignal,
    fetcher: (batch: CostEstimateTarget[], abortSignal?: AbortSignal) => Promise<GenerationCostEstimate> = estimateGenerationCost,
): Promise<string> {
    if (!targets.length) return BATCH_ESTIMATE_FALLBACK_TEXT;
    try {
        if (targets.length <= MAX_ESTIMATE_TARGETS_PER_REQUEST) {
            const single = await fetcher(targets, signal);
            return single?.summary?.text?.trim() || BATCH_ESTIMATE_FALLBACK_TEXT;
        }
        let amount = 0;
        let priced = 0;
        let unknown = 0;
        let approx = false;
        for (let offset = 0; offset < targets.length; offset += MAX_ESTIMATE_TARGETS_PER_REQUEST) {
            if (signal?.aborted) return BATCH_ESTIMATE_FALLBACK_TEXT;
            const chunk = targets.slice(offset, offset + MAX_ESTIMATE_TARGETS_PER_REQUEST);
            const result = await fetcher(chunk, signal);
            const summary = result?.summary;
            if (!summary) return BATCH_ESTIMATE_FALLBACK_TEXT;
            amount += summary.amount;
            priced += summary.priced;
            unknown += summary.unknown;
            approx = approx || Boolean(summary.approx);
        }
        const prefix = approx ? "约 " : "";
        const formatted = formatCnyTotal(roundFour(amount));
        if (priced === 0) return "预计费用：暂无价格，按所选渠道实际计费";
        if (unknown === 0) return `预计费用：${prefix}${formatted}`;
        return `预计费用：已知部分${prefix}${formatted}，另有 ${unknown} 项暂无价格`;
    } catch {
        return BATCH_ESTIMATE_FALLBACK_TEXT;
    }
}
