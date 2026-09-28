import type { CanvasNodeMetadata } from "@/types/canvas";

export type CanvasWorkflowProvider = "model" | "runninghub" | "comfyui";

/**
 * 统一解析画布节点的工作流渠道；旧节点可能没有 workflowProvider，
 * 但已经保存了具体工作流 ID，此时不能退回普通模型的首尾帧逻辑。
 */
export function resolveCanvasWorkflowProvider(metadata?: CanvasNodeMetadata): CanvasWorkflowProvider {
    if (metadata?.workflowProvider) return metadata.workflowProvider;
    if (metadata?.runningHubWorkflowId?.trim()) return "runninghub";
    if (metadata?.comfyUIWorkflowId?.trim()) return "comfyui";
    return "model";
}

// 除普通模型外的提供方都按工作流字段槽位接收输入，新增 provider 只需扩展联合类型。
export function isCanvasWorkflowProvider(metadata?: CanvasNodeMetadata) {
    return resolveCanvasWorkflowProvider(metadata) !== "model";
}
