import { batchReferenceHandleAtY } from "@/lib/canvas/canvas-batch-table";
import { batchSourceRestriction, hasBatchConnectionCandidate } from "@/lib/canvas/canvas-batch-connection";
import { canvasConnectionError } from "@/lib/canvas/canvas-connection-policy";
import { isFrameNode, isNodeHiddenByCollapsedFrame } from "@/lib/canvas/canvas-frame";
import { getConnectionTargetAnchor, isHiddenBatchChild, normalizeConnection, storyboardHandleAtY } from "@/lib/canvas/canvas-project-domain";
import { buildCanvasSpatialIndex, canvasNodeBounds, type CanvasSpatialBounds, type CanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ConnectionHandle, type Position } from "@/types/canvas";

export type CanvasConnectionDropTarget = {
    nodeId: string | null;
    handleId?: string;
    anchorRatio?: number;
    isNearNode: boolean;
};

type DropTargetOptions = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    config: AiConfig;
    /** 指针位置（世界坐标）。 */
    world: Position;
    /** 吸附半径（世界坐标），调用方按视口倍率换算。 */
    handleRadius: number;
    current: ConnectionHandle;
    scriptScrollTopById: Record<string, number>;
};

type BatchDropTargetOptions = Omit<DropTargetOptions, "current"> & { sourceNodeIds: string[] };

// 落点判定只关心指针吸附半径内的少数节点，但每次 pointermove 都会问一次。
// 按节点数组身份缓存一份均匀网格索引：节点数组是整份替换的不可变更新，所以
// 索引既不会过期，也不需要额外的同步状态。
const nodeIndexCache = new WeakMap<CanvasNodeData[], CanvasSpatialIndex<CanvasNodeData>>();

/** 零尺寸卡片也必须能被吸附圆命中，否则索引会把它整条丢掉。 */
function snapBounds(node: CanvasNodeData): CanvasSpatialBounds {
    const bounds = canvasNodeBounds(node);
    return bounds.right > bounds.left && bounds.bottom > bounds.top
        ? bounds
        : { left: bounds.left - 1, top: bounds.top - 1, right: bounds.right + 1, bottom: bounds.bottom + 1 };
}

function nodeIndexFor(nodes: CanvasNodeData[]) {
    let index = nodeIndexCache.get(nodes);
    if (!index) {
        index = buildCanvasSpatialIndex(nodes.map((node) => ({ id: node.id, bounds: snapBounds(node), value: node })));
        nodeIndexCache.set(nodes, index);
    }
    return index;
}

/**
 * 连线落点。命中顺序与画布叠放一致：取文档顺序最靠后的可连接节点，而不是最近的一个。
 * 这里先按吸附圆查索引，再对命中的少数节点做可见性和连线策略判断；全量遍历会把
 * 「每个节点的隐藏判断内部再 find 一次」放大成每帧 O(n²)。
 */
function resolveDropTarget(
    { nodes, connections, config, world, handleRadius, current, scriptScrollTopById }: DropTargetOptions,
    isEligible: (node: CanvasNodeData) => boolean,
): CanvasConnectionDropTarget {
    const candidates = nodeIndexFor(nodes).query({
        left: world.x - handleRadius,
        top: world.y - handleRadius,
        right: world.x + handleRadius,
        bottom: world.y + handleRadius,
    });
    let isNearNode = false;
    let bestNodeId: string | null = null;
    let bestHandleId: string | undefined;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const node = candidates[index];
        if (isFrameNode(node) || isHiddenBatchChild(node, nodes) || isNodeHiddenByCollapsedFrame(node, nodes)) continue;
        const scrollTop = scriptScrollTopById[node.id] || 0;
        const targetHandleId = node.type === CanvasNodeType.Script ? storyboardHandleAtY(node, world.y, scrollTop) : node.type === CanvasNodeType.BatchTable ? batchReferenceHandleAtY(node, world.y, handleRadius) : undefined;
        // 普通节点只有一个居中端口；只有分镜行和批量表有有意义的纵向落点。
        if ((node.type === CanvasNodeType.Script || node.type === CanvasNodeType.BatchTable) && !targetHandleId) continue;
        const anchor = getConnectionTargetAnchor(node, current, targetHandleId, scrollTop);
        const dx = world.x - anchor.x;
        const dy = world.y - anchor.y;
        // 节点本体和矩形留白都不是落点：只认侧边端口上的圆形快速添加区。
        if (dx * dx + dy * dy > handleRadius * handleRadius) continue;
        isNearNode = true;
        if (bestNodeId) continue;
        if (!isEligible(node)) continue;
        bestNodeId = node.id;
        bestHandleId = targetHandleId;
    }
    return { nodeId: bestNodeId, handleId: bestHandleId, anchorRatio: undefined, isNearNode };
}

export function resolveConnectionDropTarget(options: DropTargetOptions): CanvasConnectionDropTarget {
    const { nodes, connections, config, current } = options;
    return resolveDropTarget(options, (node) => {
        if (node.id === current.nodeId) return false;
        const normalized = normalizeConnection(current.nodeId, node.id, nodes, current.handleType);
        return normalized !== null && !canvasConnectionError(config, nodes, connections, normalized);
    });
}

export function resolveBatchConnectionDropTarget({ sourceNodeIds, ...options }: BatchDropTargetOptions): CanvasConnectionDropTarget {
    const { nodes } = options;
    const source = sourceNodeIds
        .map((id) => nodes.find((node) => node.id === id))
        .find((node): node is CanvasNodeData => Boolean(node && !batchSourceRestriction(node)));
    if (!source) return { nodeId: null, isNearNode: false };
    return resolveDropTarget({ ...options, current: { nodeId: source.id, handleType: "source" } }, (node) => hasBatchConnectionCandidate(sourceNodeIds, node.id, nodes));
}
