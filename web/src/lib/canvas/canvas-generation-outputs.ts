import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { fitNodeSize } from "./canvas-node-size";
import { findAvailableGenerationGroupPosition } from "./canvas-generation-layout";
import type { GenerationOutput } from "@/lib/generation-outputs";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

export function generationOutputMetadata(output: GenerationOutput): CanvasNodeMetadata {
    if (!output.assetId || !output.storageKey?.startsWith("resource:")) throw new Error("生成输出素材尚未就绪，请重试");
    return {
        content: output.dataUrl || output.url, storageKey: output.storageKey,
        naturalWidth: output.width, naturalHeight: output.height, durationMs: output.durationMs,
        bytes: output.bytes, mimeType: output.mimeType, status: "success", primaryOutputId: output.id,
        assetId: output.assetId, videoPreview: undefined, hasAudio: undefined,
    };
}

export function addGenerationOutputNodes(nodes: CanvasNodeData[], source: CanvasNodeData, outputs: GenerationOutput[]) {
    const taskId = source.metadata?.generationOutputTaskId;
    if (!taskId) return nodes;
    let current = nodes;
    const added: CanvasNodeData[] = [];
    for (const output of outputs) {
        if (output.mediaType === "file" || !output.storageKey?.startsWith("resource:")) continue;
        const id = `output_${taskId}_${output.outputIndex}`;
        const existing = current.find((item) => item.id === id);
        if (existing) {
            // 修复旧版本添加的资源节点，保留用户移动、命名和连线。
            if (!existing.metadata?.assetId && existing.metadata?.generatedFromNodeId === source.id
                && existing.metadata?.storageKey === output.storageKey) {
                const patch = generationOutputMetadata(output);
                current = current.map((item) => item.id === id ? { ...item, metadata: { ...item.metadata, ...patch } } : item);
            }
            continue;
        }
        if (added.some((item) => item.id === id)) continue;
        const type = output.mediaType === "image" ? CanvasNodeType.Image : output.mediaType === "audio" ? CanvasNodeType.Audio : CanvasNodeType.Video;
        const bounds = NODE_DEFAULT_SIZE[type];
        const size = type === CanvasNodeType.Audio ? bounds : fitNodeSize(output.width || bounds.width, output.height || bounds.height, bounds.width, bounds.height);
        added.push({
            id, type, ...size, title: `${source.title || "工作流"} · 输出 ${output.outputIndex + 1}`,
            position: findAvailableGenerationGroupPosition([...current, ...added], {
                x: source.position.x + source.width + 64,
                y: added.length ? added[added.length - 1].position.y + added[added.length - 1].height + 48 : source.position.y,
            }, size),
            metadata: { ...generationOutputMetadata(output), workflowProvider: "model", generatedFromNodeId: source.id, nodeRole: "result", resultOrigin: "generated" },
        });
    }
    return added.length ? [...current, ...added] : current;
}
