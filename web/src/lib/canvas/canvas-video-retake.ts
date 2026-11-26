import { resolveCanvasGenerationModel } from "@/lib/canvas/canvas-generation-config";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { INLINE_VIDEO_TRIM_MIN_MS, type InlineVideoTrimRange } from "@/lib/canvas/canvas-video-inline-trim";
import { isSeedance25Model, modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

export function canvasVideoRetakeModel(node: CanvasNodeData, config: AiConfig) {
    if (node.type !== CanvasNodeType.Video || !(node.metadata?.content || node.metadata?.storageKey) || isCanvasNodeGenerating(node)) return;
    const model = resolveCanvasGenerationModel(config, node.metadata.model, "video");
    if (isSeedance25Model(modelOptionName(model)) && modelCapabilityConfigFor(config, model).video?.operations.includes("inpaint")) return model;
}

export function formatCanvasVideoRetakeTime(ms: number) {
    const minutes = String(Math.floor(ms / 60_000)).padStart(2, "0");
    const seconds = ((ms % 60_000) / 1000).toFixed(3).padStart(6, "0");
    return `${minutes}:${seconds}`;
}

export function buildCanvasVideoRetake(node: CanvasNodeData, config: AiConfig, range: InlineVideoTrimRange, durationMs: number, instruction: string) {
    const model = canvasVideoRetakeModel(node, config);
    const change = instruction.trim();
    if (!model || !change || !Number.isFinite(durationMs) ||
        !Number.isInteger(range.startMs) || !Number.isInteger(range.endMs) ||
        range.startMs < 0 || range.endMs > durationMs || range.endMs - range.startMs < INLINE_VIDEO_TRIM_MIN_MS) return;

    const time = `${formatCanvasVideoRetakeTime(range.startMs)}–${formatCanvasVideoRetakeTime(range.endMs)}`;
    const prompt = `编辑 @视频1，仅重拍 ${time}：${change}。保持其余时段的画面、声音和节奏，保证片段前后自然衔接。`;
    const metadata: CanvasNodeMetadata = {
        status: "idle",
        model,
        prompt,
        composerContent: prompt,
        size: "adaptive",
        seconds: "-1",
        vquality: node.metadata?.vquality,
        generateAudio: node.metadata?.generateAudio ?? "true",
        watermark: node.metadata?.watermark,
        draft: "false",
        videoEditOperation: "inpaint",
        videoRetakeSourceNodeId: node.id,
        videoRetakeSegments: [range],
        generationResultPlacement: "replace-node",
    };
    return { model, prompt, metadata, title: `片段重拍 · ${time}` };
}
