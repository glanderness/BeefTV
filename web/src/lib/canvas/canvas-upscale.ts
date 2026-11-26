import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { UpscaleMode, UpscaleParams } from "@/services/api/media-upscale";
import { isRegenerateAllowed, readNodeTaskOutcome } from "@/lib/task-outcome";

export type CanvasUpscaleSettings = {
    channelId: string;
    scale: number;
    videoTargetShortEdge?: number;
    image: { mode: UpscaleMode; model: string; outputFormat: string; enhancementStrength?: "low" | "medium" | "high" };
    video: { mode: UpscaleMode; model: string };
};
export type CanvasUpscaleBatchItem = {
    sourceNodeId: string; sourceTitle: string; mediaType: "image" | "video";
    outputNodeId: string; clientOperationId: string;
    status: "waiting" | "submitting" | "accepted" | "rejected" | "unknown";
    taskId?: string; error?: string;
    detachedResult?: "succeeded" | "failed" | "restartable" | "skipped";
    reservation?: number; quotedAt?: number;
    /** Frozen request: resuming a waiting item must not adopt edited settings. */
    params?: UpscaleParams;
};
export type CanvasUpscaleBatch = { id: string; createdAt: number; items: CanvasUpscaleBatchItem[] };
export function createDefaultUpscaleSettings(channelId = "beeftv"): CanvasUpscaleSettings {
    return { channelId, scale: 2, image: { mode: "precision", model: "Standard V2", outputFormat: "png" }, video: { mode: "precision", model: "Proteus" } };
}
export function getUpscaleInputNodes(processorId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData[] {
    const ids = new Set(connections.filter(c => c.toNodeId === processorId).map(c => c.fromNodeId));
    return nodes.filter(n => ids.has(n.id) && (n.type === CanvasNodeType.Image || n.type === CanvasNodeType.Video) && n.metadata?.status !== "loading" && Boolean(n.metadata?.storageKey || n.metadata?.content));
}
export function upscaleParamsForNode(settings: CanvasUpscaleSettings, node: CanvasNodeData, resourceId: string): UpscaleParams {
    const config = node.type === CanvasNodeType.Video ? settings.video : settings.image;
    return {
        resourceId, channelId: settings.channelId,
        scale: config.mode === "transparent" ? 4 : settings.scale,
        ...config,
        ...(node.type === CanvasNodeType.Video && settings.videoTargetShortEdge
            ? { targetShortEdge: settings.videoTargetShortEdge } : {}),
    };
}
export type CanvasUpscaleQuote = { sourceId: string; sourceKey: string; params: UpscaleParams; reservation: number };
export function upscaleSourceKey(node: CanvasNodeData) {
    return JSON.stringify([node.id, node.type, node.metadata?.storageKey, node.metadata?.content]);
}
export function createCachedUpscaleResourcePreparer(prepare: (node: CanvasNodeData) => Promise<string>) {
    const cache = new Map<string, Promise<string>>();
    return {
        prepare(node: CanvasNodeData) {
            const key = upscaleSourceKey(node);
            const cached = cache.get(key);
            if (cached) return cached;
            const pending = Promise.resolve().then(() => prepare(node)).catch((error) => {
                if (cache.get(key) === pending) cache.delete(key);
                throw error;
            });
            cache.set(key, pending);
            return pending;
        },
        clear() {
            cache.clear();
        },
    };
}
export function isUpscaleItemSettled(item: CanvasUpscaleBatchItem, output?: CanvasNodeData["metadata"]) {
    return Boolean(item.detachedResult || (output?.taskStatus === "succeeded" && (output.content || output.storageKey))
        || output?.taskStatus === "failed" || output?.taskStatus === "cancelled");
}
export function getUpscaleOutputPosition(processor: CanvasNodeData, index: number, nodes: CanvasNodeData[] = [], bounds = { width: 320, height: 320 }) {
    const x = processor.position.x + processor.width + 96;
    let y = processor.position.y + index * 360;
    while (nodes.some(n => n.position.x < x + bounds.width && n.position.x + n.width > x && n.position.y < y + bounds.height && n.position.y + n.height > y)) y += 360;
    return { x, y };
}
export function deriveUpscaleBatchState(batch: CanvasUpscaleBatch | undefined, nodes: CanvasNodeData[]) {
    const counts = { total: batch?.items.length ?? 0, waiting: 0, active: 0, succeeded: 0, failed: 0, unknown: 0 };
    let restartableFailures = 0;
    for (const item of batch?.items ?? []) {
        const output = nodes.find(n => n.id === item.outputNodeId)?.metadata;
        if (item.detachedResult === "succeeded") counts.succeeded++;
        else if (item.detachedResult === "skipped") restartableFailures++;
        else if (item.detachedResult) {
            counts.failed++;
            if (item.detachedResult === "restartable") restartableFailures++;
        }
        else if (output?.taskStatus === "succeeded" && (output.content || output.storageKey)) counts.succeeded++;
        else if (item.status === "rejected" || output?.taskStatus === "failed" || output?.taskStatus === "cancelled") {
            counts.failed++;
            if (item.status === "accepted" && isRegenerateAllowed(readNodeTaskOutcome(output))) restartableFailures++;
        }
        else if (item.status === "unknown" || item.status === "submitting") counts.unknown++;
        else if (item.status === "waiting") counts.waiting++;
        else counts.active++;
    }
    return { ...counts, running: counts.waiting + counts.active + counts.unknown > 0,
        complete: counts.total > 0 && counts.waiting + counts.active + counts.unknown === 0,
        canStartNewBatch: counts.total === counts.succeeded + restartableFailures };
}
