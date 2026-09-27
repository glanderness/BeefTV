import type { CanvasNodeData } from "@/types/canvas";

export function isDepthCaptureResultNode(node: CanvasNodeData) {
    return Boolean(node.metadata?.depthSourceNodeId);
}

export function findDepthCaptureSourceNode(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const sourceNodeId = node.metadata?.depthSourceNodeId;
    return sourceNodeId ? nodes.find((candidate) => candidate.id === sourceNodeId) : undefined;
}
