import { describe, expect, it } from "bun:test";

import { batchReferenceHandleY } from "@/lib/canvas/canvas-batch-table";
import { resolveBatchConnectionDropTarget, resolveConnectionDropTarget } from "@/lib/canvas/canvas-connection-target";
import { getConnectionTargetAnchor } from "@/lib/canvas/canvas-project-domain";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const SNAP_RADIUS = 56;

function node(id: string, type: CanvasNodeType, x: number, y: number, extra: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return { id, type, title: id, position: { x, y }, width: 320, height: 180, ...extra };
}

/** 从节点右边缘的输出端拖出的连线，目标是对方左边缘的输入端。 */
const dragging: { nodeId: string; handleType: "source" } = { nodeId: "source-node", handleType: "source" };

function resolve(nodes: CanvasNodeData[], world: { x: number; y: number }, connections: CanvasConnection[] = [], scale = 1) {
    return resolveConnectionDropTarget({
        nodes, connections, config: defaultConfig, world,
        handleRadius: SNAP_RADIUS / scale, current: dragging, scriptScrollTopById: {},
    });
}

const sourceNode = node("source-node", CanvasNodeType.Image, -4000, 0);

describe("画布连线落点", () => {
    it("只在输入端锚点的吸附圆内命中，节点本体和留白都不算", () => {
        const target = node("target", CanvasNodeType.Image, 1000, 0);
        const nodes = [sourceNode, target];
        // 输入端锚点在左边缘正中：(1000, 90)。
        expect(resolve(nodes, { x: 1000, y: 90 })).toEqual({ nodeId: "target", handleId: undefined, anchorRatio: undefined, isNearNode: true });
        // 节点正中离锚点 160 px，超出 56 px 吸附半径。
        expect(resolve(nodes, { x: 1160, y: 90 })).toEqual({ nodeId: null, handleId: undefined, anchorRatio: undefined, isNearNode: false });
        // 圆外一点点。
        expect(resolve(nodes, { x: 1000 - 57, y: 90 }).nodeId).toBeNull();
        expect(resolve(nodes, { x: 1000 - 55, y: 90 }).nodeId).toBe("target");
    });

    it("重叠时取文档顺序最靠后的节点", () => {
        const lower = node("lower", CanvasNodeType.Image, 1000, 0);
        const upper = node("upper", CanvasNodeType.Image, 1000, 0);
        expect(resolve([sourceNode, lower, upper], { x: 1000, y: 90 }).nodeId).toBe("upper");
        expect(resolve([sourceNode, upper, lower], { x: 1000, y: 90 }).nodeId).toBe("lower");
    });

    it("折叠批次里的子节点和折叠背板里的子节点都不是落点", () => {
        const batchRoot = node("batch-root", CanvasNodeType.Image, -2000, -2000, { metadata: { isBatchRoot: true, imageBatchExpanded: false } });
        const batchChild = node("batch-child", CanvasNodeType.Image, 1000, 0, { metadata: { batchRootId: "batch-root" } });
        const frame = node("frame", CanvasNodeType.Frame, -1000, -1000, { metadata: { frame: { collapsed: true } } });
        const frameChild = node("frame-child", CanvasNodeType.Image, 2000, 0, { parentId: "frame" });
        const nodes = [sourceNode, batchRoot, batchChild, frame, frameChild];
        expect(resolve(nodes, { x: 1000, y: 90 })).toEqual({ nodeId: null, handleId: undefined, anchorRatio: undefined, isNearNode: false });
        expect(resolve(nodes, { x: 2000, y: 90 }).nodeId).toBeNull();
        // 展开批次后子节点重新可命中。
        expect(resolve([sourceNode, { ...batchRoot, metadata: { isBatchRoot: true, imageBatchExpanded: true } }, batchChild, frame, frameChild], { x: 1000, y: 90 }).nodeId).toBe("batch-child");
        // 展开背板后子节点重新可命中。
        expect(resolve([sourceNode, batchRoot, batchChild, { ...frame, metadata: { frame: { collapsed: false } } }, frameChild], { x: 2000, y: 90 }).nodeId).toBe("frame-child");
    });

    it("背板本身不是落点", () => {
        const frame = node("frame", CanvasNodeType.Frame, 1000, 0);
        expect(resolve([sourceNode, frame], { x: 1000, y: 90 })).toEqual({ nodeId: null, handleId: undefined, anchorRatio: undefined, isNearNode: false });
    });

    it("分镜脚本按行返回端口，表头空白处不命中", () => {
        const rows = [{ id: "row-1" }, { id: "row-2" }];
        const script = node("script", CanvasNodeType.Script, 1000, 0, { height: 520, metadata: { storyboard: { rows } } });
        const textSource = node("text-source", CanvasNodeType.Text, -4000, 0);
        const current = { nodeId: "text-source", handleType: "source" as const };
        const resolveWithTextSource = (world: { x: number; y: number }) => resolveConnectionDropTarget({
            nodes: [textSource, script], connections: [], config: defaultConfig, world,
            handleRadius: SNAP_RADIUS, current, scriptScrollTopById: {},
        });
        // 第一行端口的实际锚点，避免把行高常量抄进测试。
        const row1Anchor = getConnectionTargetAnchor(script, current, "row:row-1");
        expect(row1Anchor.x).toBe(script.position.x);
        expect(resolveWithTextSource(row1Anchor)).toEqual({ nodeId: "script", handleId: "row:row-1", anchorRatio: undefined, isNearNode: true });
        // 表头区域没有行端口。
        expect(resolveWithTextSource({ x: 1000, y: script.position.y + 20 })).toEqual({ nodeId: null, handleId: undefined, anchorRatio: undefined, isNearNode: false });
    });

    it("批量创作表按参考列返回端口", () => {
        const table = node("batch-table", CanvasNodeType.BatchTable, 1000, 0, { height: 560 });
        const anchorY = batchReferenceHandleY(table, "batch-reference:reference-2")!;
        const hit = resolve([sourceNode, table], { x: 1000, y: anchorY });
        expect(hit.nodeId).toBe("batch-table");
        expect(hit.handleId).toBe("batch-reference:reference-2");
    });

    it("落在吸附圆内但连线不合法时仍然算「靠近」，不会误开快速创建菜单", () => {
        const audio = node("audio", CanvasNodeType.Audio, 1000, 0);
        const result = resolve([sourceNode, audio], { x: 1000, y: 90 });
        expect(result.nodeId).toBeNull();
        expect(result.isNearNode).toBe(true);
    });

    it("源节点自身不是落点，但仍算「靠近」（与原实现一致）", () => {
        const self = node("source-node", CanvasNodeType.Image, 1000, 0);
        expect(resolve([self], { x: 1000, y: 90 })).toEqual({ nodeId: null, handleId: undefined, anchorRatio: undefined, isNearNode: true });
    });

    it("零尺寸卡片也能被吸附圆命中", () => {
        const dot = { id: "dot", type: CanvasNodeType.Image, title: "dot", position: { x: 1000, y: 90 }, width: 0, height: 0 } as CanvasNodeData;
        expect(resolve([sourceNode, dot], { x: 1000, y: 90 }).nodeId).toBe("dot");
    });

    it("节点数组换新后索引跟着换，不保留上一份几何", () => {
        const before = [sourceNode, node("target", CanvasNodeType.Image, 1000, 0)];
        const after = [sourceNode, node("target", CanvasNodeType.Image, 5000, 0)];
        expect(resolve(before, { x: 1000, y: 90 }).nodeId).toBe("target");
        expect(resolve(after, { x: 1000, y: 90 }).nodeId).toBeNull();
        expect(resolve(after, { x: 5000, y: 90 }).nodeId).toBe("target");
        expect(resolve(before, { x: 1000, y: 90 }).nodeId).toBe("target");
    });

    it("命中判定只读指针附近的节点，不随节点总数线性增长", () => {
        // 每个节点的几何属性都被计数。旧实现每帧要对全部节点做隐藏判断，读数随节点数线性增长；
        // 走索引后每帧只读命中吸附圆的那几个节点。
        let reads = 0;
        const nodes = Array.from({ length: 2000 }, (_, index) => {
            const target = node(`n${index}`, CanvasNodeType.Image, index * 360, 0);
            Object.defineProperty(target, "position", { get() { reads += 1; return { x: index * 360, y: 0 }; } });
            Object.defineProperty(target, "width", { get() { reads += 1; return 320; } });
            Object.defineProperty(target, "height", { get() { reads += 1; return 180; } });
            return target;
        });
        const options = { nodes, connections: [] as CanvasConnection[], config: defaultConfig, handleRadius: SNAP_RADIUS, current: { nodeId: "n0", handleType: "source" as const }, scriptScrollTopById: {} };
        resolveConnectionDropTarget({ ...options, world: { x: -100_000, y: -100_000 } });
        reads = 0;
        expect(resolveConnectionDropTarget({ ...options, world: { x: -100_000, y: -100_000 } }).nodeId).toBeNull();
        expect(reads).toBeLessThan(50);
        reads = 0;
        expect(resolveConnectionDropTarget({ ...options, world: { x: 360 * 1000, y: 90 } }).nodeId).toBe("n1000");
        expect(reads).toBeLessThan(50);
    });

    it("缩放越大，世界坐标里的吸附半径越小", () => {
        const target = node("target", CanvasNodeType.Image, 1000, 0);
        const nodes = [sourceNode, target];
        // 300% 下半径 18.67 px：200 px 外的指针不命中。
        expect(resolve(nodes, { x: 1200, y: 90 }, [], 3).nodeId).toBeNull();
        // 50% 下半径 112 px：200 px 外仍不命中，但 100 px 内命中。
        expect(resolve(nodes, { x: 1100, y: 90 }, [], 0.5).nodeId).toBe("target");
    });
});

describe("批量连线落点", () => {
    const batchSource = node("batch-source", CanvasNodeType.Image, -4000, 0);
    const options = { nodes: [batchSource, node("target", CanvasNodeType.Image, 1000, 0)], connections: [] as CanvasConnection[], config: defaultConfig, handleRadius: SNAP_RADIUS, scriptScrollTopById: {} };

    it("没有可用连接源时直接返回空", () => {
        expect(resolveBatchConnectionDropTarget({ ...options, world: { x: 1000, y: 90 }, sourceNodeIds: [] })).toEqual({ nodeId: null, isNearNode: false });
    });

    it("命中合法目标节点", () => {
        expect(resolveBatchConnectionDropTarget({ ...options, world: { x: 1000, y: 90 }, sourceNodeIds: ["batch-source"] }).nodeId).toBe("target");
    });

    it("目标节点已是连接源之一时不算候选", () => {
        expect(resolveBatchConnectionDropTarget({ ...options, world: { x: 1000, y: 90 }, sourceNodeIds: ["target"] })).toEqual({ nodeId: null, isNearNode: true });
    });
});
