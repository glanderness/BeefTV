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

/**
 * 索引只接受「右下严格大于左上」的矩形，而端口锚点落在节点边界上（分镜行、批量表端口
 * 也一样），所以零尺寸卡片和左右/上下反向的卡片都必须先补成有效矩形，否则会被整条丢掉。
 */
function snapBounds(node: CanvasNodeData): CanvasSpatialBounds {
    const bounds = canvasNodeBounds(node);
    const left = Math.min(bounds.left, bounds.right);
    const right = Math.max(bounds.left, bounds.right);
    const top = Math.min(bounds.top, bounds.bottom);
    const bottom = Math.max(bounds.top, bounds.bottom);
    return right > left && bottom > top ? { left, top, right, bottom } : { left: left - 1, top: top - 1, right: right + 1, bottom: bottom + 1 };
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
 * 索引的矩形相交是严格比较（`left < right`），而吸附圆判定是闭区间（`dx² + dy² <= r²`）。
 * 端口锚点落在节点边界上（`position.x` / `position.x + width`），所以指针正好在吸附圆
 * 左右相切位置时，节点边界与查询矩形只共边不重叠，会被索引整条丢掉：旧实现算命中，
 * 索引实现算「不靠近」，松手会误开快速创建菜单。把查询矩形外扩一点点，让闭区间的
 * 边界命中也进入候选；真正的命中仍由下面那一次精确的圆判定决定。
 */
function queryBounds(world: Position, handleRadius: number): CanvasSpatialBounds {
    const padding = Math.max(1e-6, Math.abs(world.x) * 1e-12, Math.abs(world.y) * 1e-12);
    return {
        left: world.x - handleRadius - padding,
        top: world.y - handleRadius - padding,
        right: world.x + handleRadius + padding,
        bottom: world.y + handleRadius + padding,
    };
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
    const candidates = nodeIndexFor(nodes).query(queryBounds(world, handleRadius));
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
