/**
 * 画布交互三条路径的逻辑测量（可重放，不启动客户端、不联网、不调用模型）。
 *
 *   cd web && bun run scripts/canvas-interaction-bench.ts --nodes 300 --entries 60 --repeats 120
 *
 * 输出 JSON。`legacy*` 是从 v2.0.5（6a155448）源码逐行复刻的旧实现，用来给
 * 「改前」提供同条件基线；`*` 是当前源码里的实现。旧实现原本内联在
 * pages/canvas/use-canvas-connection-controller.ts 的 useCallback 里，无法直接
 * import，所以在这里复刻，只把 ref 解引用改成参数传入。
 */
import { batchReferenceHandleAtY } from "@/lib/canvas/canvas-batch-table";
import { batchSourceRestriction, hasBatchConnectionCandidate } from "@/lib/canvas/canvas-batch-connection";
import { canvasConnectionError } from "@/lib/canvas/canvas-connection-policy";
import { resolveConnectionDropTarget } from "@/lib/canvas/canvas-connection-target";
import { isFrameNode, isNodeHiddenByCollapsedFrame } from "@/lib/canvas/canvas-frame";
import { getConnectionTargetAnchor, isHiddenBatchChild, normalizeConnection, storyboardHandleAtY } from "@/lib/canvas/canvas-project-domain";
import { canvasNodeOperation, type OperationProgress } from "@/lib/operation-progress";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ConnectionHandle, type Position } from "@/types/canvas";

const argument = (name: string, fallback: number) => {
    const at = process.argv.indexOf(`--${name}`);
    return at >= 0 && process.argv[at + 1] ? Number(process.argv[at + 1]) : fallback;
};
const NODE_COUNTS = argument("nodes", 300) === 0 ? [100, 300, 500, 1000] : [argument("nodes", 300)];
const ENTRY_COUNTS = argument("entries", 0) === 0 ? [1, 10, 60, 200] : [argument("entries", 60)];
const REPEATS = argument("repeats", 120);
const MOUNTED_CARDS = argument("cards", 33);
const SNAP_RADIUS = 56;
const config = {} as AiConfig;

const gridPosition = (index: number, columns: number) => ({ x: (index % columns) * 360, y: Math.floor(index / columns) * 240 });

/**
 * 一份带真实结构的大画布：图片/视频/文本混合，含一个折叠的图片批次（根 + 子节点，
 * 子节点每帧都会触发一次 isHiddenBatchChild 的线性查找）和一个折叠背板（子节点触发
 * isNodeHiddenByCollapsedFrame 的线性查找），以及分镜脚本行。
 */
function buildCanvas(count: number, batchHeavy = false, rootLate = false) {
    const columns = Math.max(4, Math.ceil(Math.sqrt(count)));
    const nodes: CanvasNodeData[] = [];
    const batchRoot: CanvasNodeData = { id: "batch-root", type: CanvasNodeType.Image, title: "批量创作", position: { x: -800, y: -800 }, width: 320, height: 180, metadata: { isBatchRoot: true, imageBatchExpanded: false, batchChildIds: [] } };
    const frame: CanvasNodeData = { id: "frame-1", type: CanvasNodeType.Frame, title: "背板", position: { x: -1600, y: -1600 }, width: 1200, height: 900, metadata: { frame: { collapsed: true } } };
    // 根节点在数组里的位置决定每个子节点隐藏判断的线性查找长度。
    if (!rootLate) nodes.push(batchRoot, frame);
    const batchChildIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
        const position = gridPosition(index, columns);
        // 「批量创作」折叠后，每个子节点都会在隐藏判断里线性查找一次它的根节点。
        if (batchHeavy ? index % 2 === 1 : index % 25 === 24) {
            const id = `batch-child-${index}`;
            batchChildIds.push(id);
            nodes.push({ id, type: CanvasNodeType.Image, title: `批量结果 ${index}`, position, width: 320, height: 180, metadata: { batchRootId: "batch-root", content: "data:image/svg+xml,fixture" } });
            continue;
        }
        if (!batchHeavy && index % 25 === 23) {
            nodes.push({ id: `frame-child-${index}`, type: CanvasNodeType.Image, title: `背板内容 ${index}`, position, width: 320, height: 180, parentId: "frame-1", metadata: { content: "data:image/svg+xml,fixture" } });
            continue;
        }
        if (!batchHeavy && index % 25 === 22) {
            nodes.push({ id: `script-${index}`, type: CanvasNodeType.Script, title: `分镜 ${index}`, position, width: 320, height: 480, metadata: { storyboard: { rows: Array.from({ length: 6 }, (_, row) => ({ id: `row-${row}` })) } } });
            continue;
        }
        const type = index % 5 < 3 ? CanvasNodeType.Image : index % 5 === 3 ? CanvasNodeType.Video : CanvasNodeType.Text;
        nodes.push({ id: `node-${index}`, type, title: `节点 ${index}`, position, width: 320, height: 180, metadata: type === CanvasNodeType.Text ? { content: "分镜描述" } : { content: "data:image/svg+xml,fixture" } });
    }
    if (rootLate) nodes.push(batchRoot, frame);
    batchRoot.metadata!.batchChildIds = batchChildIds;
    const connections: CanvasConnection[] = [];
    for (let index = 1; index < count; index += 2) connections.push({ id: `e-${index}`, fromNodeId: `node-${index - 1}`, toNodeId: `node-${index}` });
    return { nodes, connections };
}

function measure(run: () => void) {
    for (let index = 0; index < Math.min(20, REPEATS); index += 1) run();
    const durations: number[] = [];
    for (let index = 0; index < REPEATS; index += 1) {
        const begin = performance.now();
        run();
        durations.push(performance.now() - begin);
    }
    durations.sort((left, right) => left - right);
    return {
        medianMs: Number(durations[Math.floor(durations.length / 2)].toFixed(4)),
        p95Ms: Number(durations[Math.ceil(durations.length * 0.95) - 1].toFixed(4)),
    };
}

/** v2.0.5 use-canvas-connection-controller.ts 的 getConnectionDropTarget 逐行复刻。 */
function legacyResolveConnectionDropTarget({ nodes, connections, world, handleRadius, current, scriptScrollTopById }: {
    nodes: CanvasNodeData[]; connections: CanvasConnection[]; world: Position; handleRadius: number; current: ConnectionHandle; scriptScrollTopById: Record<string, number>;
}) {
    let isNearNode = false;
    let bestNodeId: string | null = null;
    let bestHandleId: string | undefined;
    let bestAnchorRatio: number | undefined;
    let bestPriority = Number.POSITIVE_INFINITY;

    [...nodes]
        .filter((node) => !isHiddenBatchChild(node, nodes) && !isNodeHiddenByCollapsedFrame(node, nodes) && !isFrameNode(node))
        .reverse()
        .forEach((node) => {
            const scrollTop = scriptScrollTopById[node.id] || 0;
            const targetHandleId = node.type === CanvasNodeType.Script ? storyboardHandleAtY(node, world.y, scrollTop) : node.type === CanvasNodeType.BatchTable ? batchReferenceHandleAtY(node, world.y, handleRadius) : undefined;
            if ((node.type === CanvasNodeType.Script || node.type === CanvasNodeType.BatchTable) && !targetHandleId) return;
            const targetAnchorRatio = undefined;
            const anchor = getConnectionTargetAnchor(node, current, targetHandleId, scrollTop);
            const dx = world.x - anchor.x;
            const dy = world.y - anchor.y;
            const hitsSnapZone = dx * dx + dy * dy <= handleRadius * handleRadius;
            if (!hitsSnapZone) return;
            isNearNode = true;
            const normalized = node.id === current.nodeId ? null : normalizeConnection(current.nodeId, node.id, nodes, current.handleType);
            if (!normalized || canvasConnectionError(config, nodes, connections, normalized)) return;
            if (1 < bestPriority) {
                bestNodeId = node.id;
                bestHandleId = targetHandleId;
                bestAnchorRatio = targetAnchorRatio;
                bestPriority = 1;
            }
        });
    return { nodeId: bestNodeId, handleId: bestHandleId, anchorRatio: bestAnchorRatio, isNearNode };
}

/** v2.0.5 lib/operation-progress.ts 的 canvasNodeOperation 逐行复刻。 */
function legacyCanvasNodeOperation(entries: Record<string, OperationProgress>, projectId: string | undefined, nodeId: string, taskId?: string) {
    return Object.values(entries).reverse().find(item => {
        if (!item.target || item.phase === "done" || item.phase === "error") return false;
        if (item.target.projectId !== projectId) return false;
        return item.target.taskId ? item.target.taskId === taskId && item.target.nodeId === nodeId : item.target.projectId === projectId && item.target.nodeId === nodeId;
    });
}

function operationEntries(count: number) {
    const entries: Record<string, OperationProgress> = {};
    for (let index = 0; index < count; index += 1) {
        entries[`entry-${index}`] = {
            id: `entry-${index}`, title: "参考视频", detail: "正在上传", phase: "transferring",
            loadedBytes: 1024 * index, totalBytes: 1024 * 1024, bytesPerSecond: 4096, startedAt: 1000, updatedAt: 2000,
            target: { projectId: "canvas-a", nodeId: `node-${index}`, taskId: `task-${index}` },
        };
    }
    return entries;
}

const connectionResults: Record<string, unknown> = {};
for (const fixture of ["mixed", "batch-heavy", "root-late"] as const) {
    for (const count of NODE_COUNTS) {
        const { nodes, connections } = buildCanvas(count, fixture !== "mixed", fixture === "root-late");
        const current: ConnectionHandle = { nodeId: "node-0", handleType: "source" };
        const cases: Record<string, Position> = {
            "pointer-empty-space": { x: 40 * 360 + 180, y: 40 * 240 + 90 },
            "pointer-on-node-edge": { x: nodes.find((node) => node.id === `node-${count - 4}`)!.position.x, y: nodes.find((node) => node.id === `node-${count - 4}`)!.position.y + 90 },
        };
        for (const scale of [1, 0.3]) {
            const handleRadius = SNAP_RADIUS / scale;
            for (const [label, world] of Object.entries(cases)) {
                connectionResults[`fixture=${fixture}|nodes=${count}|scale=${scale}|${label}`] = {
                    legacy: measure(() => legacyResolveConnectionDropTarget({ nodes, connections, world, handleRadius, current, scriptScrollTopById: {} })),
                    current: measure(() => resolveConnectionDropTarget({ nodes, connections, config, world, handleRadius, current, scriptScrollTopById: {} })),
                };
            }
        }
    }
}

const progressResults: Record<string, unknown> = {};
for (const count of ENTRY_COUNTS) {
    const entries = operationEntries(count);
    progressResults[`entries=${count}|lookups-per-frame=${MOUNTED_CARDS}`] = {
        legacy: measure(() => { for (let index = 0; index < MOUNTED_CARDS; index += 1) legacyCanvasNodeOperation(entries, "canvas-a", `node-${index}`, `task-${index}`); }),
        current: measure(() => { for (let index = 0; index < MOUNTED_CARDS; index += 1) canvasNodeOperation(entries, "canvas-a", `node-${index}`, `task-${index}`); }),
    };
}

// 行为等价性：改前改后必须在同一批指针位置上给出同一个落点（节点、端口、是否邻近）。
let paritySamples = 0;
let parityMismatches = 0;
const parityExamples: Array<{ fixture: string; nodes: number; scale: number; world: Position; legacy: string | null; current: string | null }> = [];
// 固定序列的伪随机，保证可重放。
let seed = 20261028;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
for (const fixture of ["mixed", "batch-heavy", "root-late"] as const) {
    for (const count of [100, 300, 500]) {
        const { nodes, connections } = buildCanvas(count, fixture !== "mixed", fixture === "root-late");
        const current: ConnectionHandle = { nodeId: `node-${count - 4}`, handleType: "source" };
        for (let index = 0; index < 200; index += 1) {
            const world = { x: random() * count * 40, y: random() * count * 12 };
            for (const scale of [1, 0.3, 2.5]) {
                const handleRadius = SNAP_RADIUS / scale;
                const legacy = legacyResolveConnectionDropTarget({ nodes, connections, world, handleRadius, current, scriptScrollTopById: {} });
                const next = resolveConnectionDropTarget({ nodes, connections, config, world, handleRadius, current, scriptScrollTopById: {} });
                paritySamples += 1;
                if (legacy.nodeId === next.nodeId && legacy.handleId === next.handleId && legacy.isNearNode === next.isNearNode && legacy.anchorRatio === next.anchorRatio) continue;
                parityMismatches += 1;
                if (parityExamples.length < 10) parityExamples.push({ fixture, nodes: count, scale, world, legacy: legacy.nodeId, current: next.nodeId });
            }
        }
    }
}

console.log(JSON.stringify({
    scope: "纯 JS 逻辑耗时（performance.now 包裹的单次调用），不含渲染、绘制、网络与原生宿主；同机负载会影响绝对值，改前改后在同一次运行内交替测量",
    repeats: REPEATS,
    nodeCounts: NODE_COUNTS,
    entryCounts: ENTRY_COUNTS,
    connectionDropTarget: connectionResults,
    nodeOperationLookup: progressResults,
    parity: { samples: paritySamples, mismatches: parityMismatches, examples: parityExamples },
}, null, 2));
