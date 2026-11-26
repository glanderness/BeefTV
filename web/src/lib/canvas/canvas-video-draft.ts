import { queryGenerationTask } from "@/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function canConvertCanvasVideoDraft(node: CanvasNodeData) {
    const metadata = node.metadata;
    return node.type === CanvasNodeType.Video && metadata?.draft === "true" && metadata.status !== "loading"
        && Boolean(metadata.content || metadata.storageKey)
        && Boolean(metadata.taskProviderRequestId?.trim() || metadata.taskId?.trim());
}

export async function resolveCanvasVideoDraftSource(node: CanvasNodeData, canvasId: string, getTask = queryGenerationTask) {
    if (!canConvertCanvasVideoDraft(node)) return undefined;
    const metadata = node.metadata;
    const storedId = metadata?.taskProviderRequestId?.trim();
    if (storedId) return { providerRequestId: storedId, model: metadata?.model };
    const taskId = metadata?.taskId?.trim();
    if (!taskId) return undefined;
    const task = await getTask(taskId);
    const providerRequestId = task.providerRequestId?.trim();
    if (!providerRequestId || task.id !== taskId || task.type !== "canvas_video" || task.status !== "succeeded"
        || (task.projectId && task.projectId !== canvasId)) return undefined;
    return { providerRequestId, model: task.model || metadata?.model };
}
