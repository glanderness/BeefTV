import { nanoid } from "nanoid";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";

import { findAvailableGenerationGroupPosition } from "@/lib/canvas/canvas-generation-layout";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { createDefaultUpscaleSettings } from "@/lib/canvas/canvas-upscale";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

function canUpscale(node: CanvasNodeData) {
    return (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) && Boolean(node.metadata?.content || node.metadata?.storageKey);
}

export type CanvasUpscaleProcessorPlan = {
    processor: CanvasNodeData;
    connections: CanvasConnection[];
};

/**
 * 在来源右侧放一个超分处理节点，并把当前选中的可读图片或视频都连上去。
 * 来源自己没被选中时，只连接来源这一张。
 */
export function planUpscaleProcessingNode(
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    source: CanvasNodeData,
    selectedNodeIds: ReadonlySet<string>,
    createId: () => string = () => nanoid(),
): CanvasUpscaleProcessorPlan {
    const selectedSources = selectedNodeIds.has(source.id) ? nodes.filter((node) => selectedNodeIds.has(node.id) && canUpscale(node)) : [source];
    const position = findAvailableGenerationGroupPosition(nodes, { x: source.position.x + source.width + 120, y: source.position.y }, NODE_DEFAULT_SIZE[CanvasNodeType.Upscale]);
    const processor = createCanvasNode(CanvasNodeType.Upscale, {
        x: position.x + NODE_DEFAULT_SIZE[CanvasNodeType.Upscale].width / 2,
        y: position.y + NODE_DEFAULT_SIZE[CanvasNodeType.Upscale].height / 2,
    }, { upscale: createDefaultUpscaleSettings(), status: "idle" });
    return {
        processor,
        connections: [...connections, ...selectedSources.map((node) => ({ id: createId(), fromNodeId: node.id, toNodeId: processor.id }))],
    };
}
