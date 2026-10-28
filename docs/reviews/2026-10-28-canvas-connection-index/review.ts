import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { resolveConnectionDropTarget, resolveBatchConnectionDropTarget } from "@/lib/canvas/canvas-connection-target";
import { batchReferenceHandleY } from "@/lib/canvas/canvas-batch-table";
import { getConnectionTargetAnchor } from "@/lib/canvas/canvas-project-domain";
import { batchSourceRestriction, planBatchConnections } from "@/lib/canvas/canvas-batch-connection";
import { updateCanvasNode } from "@/lib/canvas/canvas-node-timestamps";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType as T, type CanvasNodeData } from "@/types/canvas";
import { baselineConnection, baselineBatch, reachableStoryboardGroup } from "./review-baseline";

const output = process.env.REVIEW_OUTPUT!;
const node = (id: string, type = T.Image, x = 1000, y = 0, patch: Partial<CanvasNodeData> = {}): CanvasNodeData => ({ id, type, title: id, position: { x, y }, width: 320, height: 180, ...patch });
const src = node("source", T.Image, -4000);
const options = (nodes: CanvasNodeData[], world = { x: 1000, y: 90 }, scale = 1, patch = {}) => ({ nodes, connections: [], config: defaultConfig, world, handleRadius: 56 / Math.max(scale, .05), current: { nodeId: "source", handleType: "source" }, scriptScrollTopById: {}, sourceNodeIds: ["source"], ...patch });
const save = (name: string, value: unknown) => writeFileSync(`${output}/${name}.json`, JSON.stringify(value, null, 2) + "\n");

function differential() {
    let checked = 0;
    const mismatches: any[] = [];
    const compare = (name: string, o: any) => {
        for (const [kind, before, after] of [["ordinary", baselineConnection, resolveConnectionDropTarget], ["batch", baselineBatch, resolveBatchConnectionDropTarget]] as const) {
            const oldResult = before(o), result = after(o);
            checked++;
            if (!isDeepStrictEqual(oldResult, result)) mismatches.push({ name, kind, world: o.world, radius: o.handleRadius, oldResult, result });
        }
    };
    const target = node("target");
    for (const scale of [.05, .25, .6, 1, 2, 3]) {
        const radius = 56 / scale;
        for (const fraction of [0, .2, .7, .99, 1.001, 1.1]) {
            for (let angle = 0; angle < 360; angle += 15) {
                const world = { x: 1000 + Math.cos(angle * Math.PI / 180) * radius * fraction, y: 90 + Math.sin(angle * Math.PI / 180) * radius * fraction };
                compare(`圆周取样-${scale}-${fraction}-${angle}`, options([src, target], world, scale));
            }
        }
        compare(`左侧精确相切-${scale}`, options([src, target], { x: 1000 - radius, y: 90 }, scale));
        const text = node("text", T.Text, -4000);
        const current = { nodeId: "text", handleType: "target" };
        compare(`反向右侧精确相切-${scale}`, options([text, target], { x: 1320 + radius, y: 90 }, scale, { current, sourceNodeIds: ["source"] }));
    }
    for (const type of [T.Image, T.Video, T.Audio, T.Text, T.Drawing, T.Config, T.Frame, T.Workflow]) {
        compare(`节点类型-${type}`, options([src, node("target", type)]));
    }
    const lower = node("lower"), upper = node("upper");
    compare("相同位置后者优先", options([src, lower, upper]));
    compare("调整顺序后者优先", options([src, upper, lower]));
    compare("上层不合法仍可命中下层", options([src, lower, node("upper", T.Audio)]));
    compare("源自身靠近", options([node("source")]));
    compare("已有相同连线", options([src, target], undefined, 1, { connections: [{ id: "e", fromNodeId: "source", toNodeId: "target" }] }));
    for (const collapsed of [false, true]) {
        const frame = node("frame", T.Frame, -2000, -2000, { metadata: { frame: { collapsed } } });
        const root = node("root", T.Image, -1000, -1000, { metadata: { isBatchRoot: true, imageBatchExpanded: !collapsed } });
        compare(`背板折叠-${collapsed}`, options([src, frame, { ...target, parentId: "frame" }]));
        compare(`批次折叠-${collapsed}`, options([src, root, { ...target, metadata: { batchRootId: "root" } }]));
    }
    const script = node("script", T.Script, 1000, 0, { height: 520, metadata: { storyboard: { rows: [{ id: "r0" }, { id: "r1" }, { id: "r2" }] } } });
    const text = node("source", T.Text, -4000);
    for (const scroll of [0, 20, 144, 260]) {
        for (let y = -50; y < 600; y += 7) compare(`脚本滚动-${scroll}-${y}`, options([text, script], { x: 980, y }, 1, { scriptScrollTopById: { script: scroll } }));
    }
    const table = node("table", T.BatchTable, 1000, 0, { height: 560 });
    for (let y = -50; y < 650; y += 7) compare(`参考列-${y}`, options([src, table], { x: 980, y }));
    const before = [src, target];
    compare("移动前", options(before));
    const after = updateCanvasNode(before, "target", n => ({ ...n, position: { x: 5000, y: 0 } }));
    compare("移动后原位置", options(after));
    compare("移动后新位置", options(after, { x: 5000, y: 90 }));
    compare("新数组重排", options([src, target, lower].reverse()));
    compare("零尺寸", options([src, { ...target, width: 0, height: 0 }], { x: 1000, y: 0 }));

    // 通过实际更新 helper 验证：标题/进度改变数组身份，查询因此重新读全体几何。
    let geometryReads = 0;
    const measured = Array.from({ length: 300 }, (_, i) => {
        const n = node(i === 0 ? "source" : `n${i}`, T.Image, i * 360);
        Object.defineProperty(n, "position", { enumerable: true, get() { geometryReads++; return { x: i * 360, y: 0 }; } });
        return n;
    });
    const o = options(measured, { x: -10000, y: -10000 });
    resolveConnectionDropTarget(o as any);
    geometryReads = 0;
    resolveConnectionDropTarget(o as any);
    const hotReads = geometryReads;
    const changed = updateCanvasNode(measured, "n299", n => ({ ...n, metadata: { taskProgress: 51 } }));
    geometryReads = 0;
    resolveConnectionDropTarget({ ...o, nodes: changed } as any);
    const progressRebuildReads = geometryReads;
    assert.notEqual(measured, changed);
    assert.equal(hotReads, 0);
    assert(progressRebuildReads >= 299 * 4);
    assert(mismatches.some(m => m.name === "左侧精确相切-1" && m.kind === "ordinary"));
    assert(mismatches.every(m => m.name.includes("精确相切")), "出现预期之外的行为差异，请逐项检查");
    save("differential", { checked, mismatchCount: mismatches.length, mismatches, lifecycle: { nodeCount: 300, hotReads, progressRebuildReads, immutableUpdateReturnsNewArray: changed !== measured }, scope: "纯函数差分，旧回调自动提取；不证明桌面事件与渲染" });
    console.log(`已比较 ${checked} 次，发现 ${mismatches.length} 个精确相切差异；进度更新后几何读取 ${progressRebuildReads} 次。`);
}

const stats = (samples: number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * .95)], samples: samples.length };
};

function fixture(count: number, layout: string) {
    const nodes = Array.from({ length: count }, (_, i) => node(i === 0 ? "source" : `n${i}`, T.Image, (i % 20) * 400, Math.floor(i / 20) * 240));
    if (layout === "batch-roots-first") {
        nodes[0] = { ...nodes[0], metadata: { isBatchRoot: true, imageBatchExpanded: true } };
        for (let i = 1; i < count; i++) nodes[i] = { ...nodes[i], metadata: { batchRootId: "source" } };
    }
    if (layout === "frame-first") {
        nodes[0] = node("frame", T.Frame, -400, -400, { width: 9000, height: Math.ceil(count / 20) * 240 + 800, metadata: { frame: { collapsed: false } } });
        for (let i = 1; i < count; i++) nodes[i] = { ...nodes[i], parentId: "frame" };
        nodes[1] = { ...nodes[1], id: "source" };
    }
    if (layout === "storyboard-group") {
        return reachableStoryboardGroup(nodes.map(n => ({ ...n, metadata: { content: "data:image/svg+xml,fixture" } })));
    }
    return nodes;
}

function bench() {
    const rows: any[] = [];
    let checksum = 0;
    for (const count of [100, 300, 1000, 5000]) for (const layout of ["ordinary", "batch-roots-first", "frame-first", "storyboard-group"]) {
        const nodes = fixture(count, layout);
        const target = nodes.findLast(n => n.type === T.Image)!;
        const world = { x: target.position.x - 10, y: target.position.y + target.height / 2 };
        const initial = options(nodes, world);
        for (let i = 0; i < 40; i++) { baselineConnection(initial); resolveConnectionDropTarget(initial as any); }
        for (const mode of ["hot", "first-query", "progress-update", "title-update", "geometry-update", "60-query-drag", "60-query-drag-progress-every-15", "batch-preview-20"] ) {
            const repeats = layout === "storyboard-group" && count >= 1000 ? (mode.startsWith("60-query") ? 12 : 40) : 160;
            const samples = { baseline: [] as number[], candidate: [] as number[] };
            for (let r = 0; r < repeats; r++) {
                // 前后交替，避免一种实现固定承受首轮热身。
                for (const which of r % 2 ? ["candidate", "baseline"] as const : ["baseline", "candidate"] as const) {
                    let o = initial;
                    if (mode === "first-query" || mode.startsWith("60-query")) o = { ...initial, nodes: [...nodes] };
                    const start = performance.now();
                    if (mode.endsWith("update")) {
                        o = { ...initial, nodes: updateCanvasNode(nodes, target.id, n => mode === "progress-update" ? { ...n, metadata: { ...n.metadata, taskProgress: r % 100 } } : mode === "title-update" ? { ...n, title: `改名${r}` } : { ...n, position: { x: n.position.x + 1, y: n.position.y } }) };
                    }
                    const resolve = which === "baseline" ? baselineConnection : resolveConnectionDropTarget;
                    const calls = mode.startsWith("60-query") ? 60 : 1;
                    for (let i = 0; i < calls; i++) {
                        if (mode.includes("every-15") && i > 0 && i % 15 === 0) o = { ...o, nodes: updateCanvasNode(o.nodes, target.id, n => ({ ...n, metadata: { ...n.metadata, taskProgress: i } })) };
                        if (mode === "batch-preview-20") {
                            const sources = o.nodes.slice(1, 21).map(n => n.id);
                            const result = (which === "baseline" ? baselineBatch : resolveBatchConnectionDropTarget)({ ...o, sourceNodeIds: sources } as any);
                            if (result.nodeId) planBatchConnections({ ...o, sourceNodeIds: sources, targetNodeId: result.nodeId, targetHandleId: result.handleId });
                            sources.filter(id => { const n = o.nodes.find(n => n.id === id); return n && !batchSourceRestriction(n); });
                            checksum += Number(result.isNearNode);
                        } else checksum += Number(resolve(o as any).isNearNode);
                    }
                    samples[which].push(performance.now() - start);
                }
            }
            rows.push({ count, actualNodes: nodes.length, layout, mode, baseline: stats(samples.baseline), candidate: stats(samples.candidate) });
        }
    }
    save("independent-bench", { engine: `Bun ${Bun.version}`, unit: "ms", rows, checksum, notes: ["同进程交替，分位数反映本机逻辑函数成本，非 FPS", "first-query 包含索引首次建立与查询，不含创建节点；update 包含现有 updateCanvasNode 的更新成本", "60-query 总耗时包含首次建立，第二种每15次换一份进度数组，共4份", "batch-preview 包含真实规划函数和源资格检查，未包含 DOM、React 与绘制", "storyboard-group 自动提取真实 createStoryboardGroup 回调，对已有图片创建分镜组；其 frame 在末尾，共 count+1 个节点", "为控制验证成本，1000/5000 分镜组的60次查询用12组配对样本，其余分镜组用40组；其他条件160组，不把12组的p95视为可靠尾延迟"] });
    console.log(`已测 ${rows.length} 组逻辑成本，完整样本统计写入 independent-bench.json。`);
}

if (process.argv[2] === "bench") bench(); else differential();
