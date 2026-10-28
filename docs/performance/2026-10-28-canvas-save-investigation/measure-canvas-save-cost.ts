/**
 * 生成进度与画布保存开销：真实生产函数 CPU 测量 + 调用模型推算。
 *
 * 只调用生产代码里的比较/序列化/合并函数，不启动浏览器、不连后端、不读用户数据。
 * 输出：stdout 文本摘要 + 指定路径的原始 JSON（默认同目录 raw/measure-canvas-save-cost.json）。
 *
 * 运行（本机 Bun 1.4.2）：
 *   cd <repo>/web && bun ../docs/performance/2026-10-28-canvas-save-investigation/measure-canvas-save-cost.ts
 * 需要能解析 `json-canonicalize@2.0.0`（仓库正常 `bun install` 后即有；
 * 独立复现可用 `NODE_PATH=<某目录>/node_modules` 指向只装了该包的目录）。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadavg, cpus } from "node:os";

import { sameCanvasContent, sameCanvasDocument, canvasContentSnapshot } from "../../../web/src/lib/canvas/canvas-content";
import { canvasDocumentMatchesFields } from "../../../web/src/lib/canvas/canvas-document-equality";
import { mergeCanvasRefreshPatch } from "../../../web/src/lib/canvas/canvas-patch-merge";
import { parseCanvasStorageDocument, rebaseCanvasProjects, serializeCanvasStorageDocument, type CanvasStorageDocument } from "../../../web/src/lib/canvas/canvas-storage-revision";
import { buildCanvasFixture, changeViewportOnly, editorSnapshotFields, tickGenerationProgress, GENERATING_NODE_ID, type FixtureProject } from "./fixture";

const SAMPLES = 51;
const WARMUP = 3;

function measure(run: () => unknown) {
    for (let index = 0; index < WARMUP; index++) run();
    const durations = Array.from({ length: SAMPLES }, () => {
        const start = performance.now();
        run();
        return performance.now() - start;
    }).sort((left, right) => left - right);
    return {
        medianMs: Number(durations[Math.floor(SAMPLES / 2)].toFixed(4)),
        p95Ms: Number(durations[Math.ceil(SAMPLES * 0.95) - 1].toFixed(4)),
    };
}

const NODE_COUNTS = [25, 100, 300, 1000];

function storageDocumentOf(project: FixtureProject, storageRevision: number): CanvasStorageDocument {
    return {
        state: { projects: [project as never] },
        version: 1,
        storageRevision,
        tombstones: { projects: {}, nodes: {}, connections: {}, sessions: {}, messages: {} },
    };
}

type OperationRow = { operation: string; note: string; medianMs: number; p95Ms: number };

function measureProject(nodeCount: number) {
    const project = buildCanvasFixture(nodeCount);
    const serialized = serializeCanvasStorageDocument(storageDocumentOf(project, 4));
    const durable = parseCanvasStorageDocument(serialized);
    const ticked = tickGenerationProgress(project, 37);
    const viewportOnly = changeViewportOnly(project, 0.55);
    const fields = editorSnapshotFields(project);
    const tickedFields = editorSnapshotFields(ticked);
    const snapshot = canvasContentSnapshot(project as never);
    const rows: OperationRow[] = [];

    const push = (operation: string, note: string, run: () => unknown) => rows.push({ operation, note, ...measure(run) });

    push("sameCanvasContent(current, ticked)", "store.updateProject 守卫：一个节点进度变化（生产：use-canvas-store.ts:850）", () => sameCanvasContent(project as never, ticked as never));
    push("sameCanvasContent(current, current)", "同一引用早退（left === right）", () => sameCanvasContent(project as never, project as never));
    push("sameCanvasContent(current, viewportOnly)", "纯视口更新：nodes 同引用", () => sameCanvasContent(project as never, viewportOnly as never));
    push("canvasDocumentMatchesFields(observed, renderSnapshot)", "编辑器 autosave effect 的比较（use-canvas-project-lifecycle.ts:545）", () => canvasDocumentMatchesFields(project as never, fields));
    push("canvasDocumentMatchesFields(current, { nodes: ticked })", "候选守卫：按元素引用比较，只有变化元素才 JSON.stringify", () => canvasDocumentMatchesFields(project as never, { nodes: ticked.nodes }));
    push("mergeCanvasRefreshPatch(base, incoming, live)", "编辑器 autosave effect 的合并路径（use-canvas-project-lifecycle.ts:556 → 138）", () => mergeCanvasRefreshPatch(project as never, { ...project, nodes: ticked.nodes } as never, ticked.nodes as never, project.connections as never));
    push("sameCanvasDocument(confirmed, live)", "hasUnconfirmedCanvasEdits 与后端入队守卫（local-workspace-repository.ts:182、609）", () => sameCanvasDocument(project as never, ticked as never));
    push("canvasContentSnapshot(project)", "快照对象分配（canvas-content.ts:5）", () => canvasContentSnapshot(project as never));
    push("JSON.stringify(project)", "HTTP 请求体序列化", () => JSON.stringify(project));
    push("structuredClone(project)", "后端提交 payload 深拷贝（local-workspace-repository.ts:620）", () => structuredClone(project));
    push("parse + rebase + serialize", "IndexedDB 落盘（400ms 自动保存 flush，use-canvas-store.ts:405-412）", () => serializeCanvasStorageDocument(rebaseCanvasProjects({ document: durable, baseProjects: [project as never], localProjects: [ticked as never], baseRevision: 4 }).document));
    push("tickGenerationProgress(project)", "夹具自身的节点重建成本（基线，用于说明测量净开销）", () => tickGenerationProgress(project, 37));

    return {
        nodeCount: project.nodes.length,
        serializedBytes: Buffer.byteLength(serialized),
        renderedBytes: Buffer.byteLength(JSON.stringify(project)),
        snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
        rows,
        guardResult: {
            tickedDiffers: !sameCanvasContent(project as never, ticked as never),
            viewportOnlyDiffers: !sameCanvasContent(project as never, viewportOnly as never),
            editorFieldsDiffer: !canvasDocumentMatchesFields(project as never, fields),
            editorFieldsDifferAfterTick: !canvasDocumentMatchesFields(project as never, tickedFields),
        },
    };
}

// ---------------------------------------------------------------------------
// 调用模型：把「一个节点在生成中、任务轮询持续改写画布文档」换算成每分钟开销。
//
// 调用点全部来自代码读取，不是运行抓取：
// - 轮询间隔 2000ms（services/api/task-center.ts:428），取回结果阶段 500ms（同文件:475）
// - 每次轮询 onTaskUpdate → bindGenerationTask（pages/canvas/use-canvas-generation.ts:237-251）
//   → useCanvasStore.updateProject({ nodes })（同文件:245）→ 守卫 sameCanvasContent
// - React 提交后编辑器 autosave effect（pages/canvas/use-canvas-project-lifecycle.ts:538-569）
//   先 canvasDocumentMatchesFields 比较，不等则再 updateProject + scheduleLocalCanvasBackendSync
// - IndexedDB 落盘去抖 400ms（stores/canvas/use-canvas-store.ts:705-712）
// - 后端提交去抖 500ms（services/local-workspace-repository.ts:885-895）
// 轮询间隔都大于两个去抖窗口，所以本模型按「一次轮询一次落盘、一次后端提交」计。
// ---------------------------------------------------------------------------
// 每次轮询（一次 tick）的调用序列，全部来自上面的代码行：
//   L1 store 守卫：bindGenerationTask → useCanvasStore.updateProject({ nodes }) → sameCanvasContent ×1
//   L2 编辑器比较：canvasDocumentMatchesFields(observed, renderSnapshot) 与 (stored, patch) 各 ×1（很便宜）
//   L3 编辑器合并：reconcileEditorSnapshot → mergeIncomingEditorDocument → mergeCanvasRefreshPatch ×1
//   L4 未确认检查：localMode && hasUnconfirmedCanvasEdits → sameCanvasDocument(confirmed, live) ×1
//      （只有 L2 判定「变了」才会走到 L3/L4；文档没变就提前返回）
//   L5 IndexedDB 落盘（400ms 去抖）×1
//   L6 后端提交（500ms 去抖）×1：sameCanvasDocument + structuredClone + JSON.stringify
// 轮询间隔都大于两个去抖窗口，所以本模型按「一次轮询一次落盘、一次后端提交」计（取上界）。
// ---------------------------------------------------------------------------
const WINDOW_MS = 60_000;
const POLL_NORMAL_MS = 2000;
const POLL_FETCHING_MS = 500;

function minuteModel(nodeCount: number, pollMs: number) {
    const result = measureProject(nodeCount);
    const cost = (name: string) => result.rows.find((row) => row.operation === name)!.medianMs;
    const ticks = Math.floor(WINDOW_MS / pollMs);
    const storeGuard = cost("sameCanvasContent(current, ticked)");
    const cheapGuard = cost("canvasDocumentMatchesFields(current, { nodes: ticked })");
    const editorCompare = cost("canvasDocumentMatchesFields(observed, renderSnapshot)");
    const editorMerge = cost("mergeCanvasRefreshPatch(base, incoming, live)");
    const unconfirmedGuard = cost("sameCanvasDocument(confirmed, live)");
    const indexedDbFlush = cost("parse + rebase + serialize");
    const backendSave = cost("sameCanvasDocument(confirmed, live)") + cost("structuredClone(project)") + cost("JSON.stringify(project)");
    // 文档不变时的开销：只剩 L1 + L2，L3/L4/L5/L6 都不会发生
    const comparisonOnly = (guard: number) => ticks * (guard + editorCompare * 2);
    const layers = {
        L1_storeGuardMs: ticks * storeGuard,
        L2_editorCompareMs: ticks * editorCompare * 2,
        L3_editorMergeMs: ticks * editorMerge,
        L4_unconfirmedGuardMs: ticks * unconfirmedGuard,
        L5_indexedDbFlushMs: ticks * indexedDbFlush,
        L6_backendSaveMs: ticks * backendSave,
    };
    // A 现状：文档随进度变化 → 六层全走
    const scenarioA = Object.values(layers).reduce((sum, value) => sum + value, 0);
    // B 只换守卫：文档仍随进度变化，只有 L1 换成按元素比较
    const scenarioB = scenarioA - layers.L1_storeGuardMs + ticks * cheapGuard;
    // C 守卫 + 进度字段不进画布文档：文档不再变化 → 只剩 L1(廉价) + L2
    const scenarioC = comparisonOnly(cheapGuard);
    return {
        nodeCount: result.nodeCount,
        pollMs,
        ticksPerMinute: ticks,
        indexedDbFlushes: ticks,
        backendSaves: ticks,
        perTick: {
            storeGuardMs: storeGuard,
            cheapGuardMs: cheapGuard,
            editorCompareMs: editorCompare,
            editorMergeMs: editorMerge,
            unconfirmedGuardMs: unconfirmedGuard,
            indexedDbFlushMs: indexedDbFlush,
            backendSaveMs: Number(backendSave.toFixed(4)),
            totalMs: Number((storeGuard + editorCompare * 2 + editorMerge + unconfirmedGuard + indexedDbFlush + backendSave).toFixed(4)),
        },
        layers: Object.fromEntries(Object.entries(layers).map(([key, value]) => [key, Number(value.toFixed(2))])),
        scenarioA_currentMsPerMinute: Number(scenarioA.toFixed(2)),
        scenarioB_cheapGuardOnlyMsPerMinute: Number(scenarioB.toFixed(2)),
        scenarioC_cheapGuardAndNoDocumentWriteMsPerMinute: Number(scenarioC.toFixed(2)),
    };
}

const results = NODE_COUNTS.map(measureProject);
const models = NODE_COUNTS.flatMap((nodeCount) => [minuteModel(nodeCount, POLL_NORMAL_MS), minuteModel(nodeCount, POLL_FETCHING_MS)]);

const report = {
    scope: "生产比较/序列化函数的 CPU 测量 + 由代码调用点推算的每分钟开销模型；不是浏览器帧率、不是桌面客户端实测、不含 IndexedDB/HTTP 真实 IO 时间",
    runtime: `bun ${Bun.version}`,
    platform: `${process.platform}/${process.arch}`,
    cpuCount: cpus().length,
    loadAverage: loadavg().map((value) => Number(value.toFixed(2))),
    measuredAt: new Date().toISOString(),
    samples: SAMPLES,
    warmup: WARMUP,
    fixture: { generatingNodeId: GENERATING_NODE_ID, nodeCounts: NODE_COUNTS },
    results,
    models,
};

const outputPath = resolve(import.meta.dir, process.argv[2] || "raw/measure-canvas-save-cost.json");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2));

console.log(`原始数据: ${outputPath}`);
for (const result of results) {
    console.log(`\n## ${result.nodeCount} 节点（文档 ${result.serializedBytes} B）`);
    for (const row of result.rows) console.log(`  ${row.medianMs.toFixed(3).padStart(8)} ms  p95 ${row.p95Ms.toFixed(3).padStart(8)} ms  ${row.operation}`);
    console.log(`  守卫结果: ${JSON.stringify(result.guardResult)}`);
}
console.log("\n## 每分钟模型（A 现状 / B 只换守卫 / C 守卫+进度不进文档）");
for (const model of models) {
    console.log(`  ${model.nodeCount} 节点 / 轮询 ${model.pollMs}ms → ${model.ticksPerMinute} 次轮询：A ${model.scenarioA_currentMsPerMinute} ms/分，B ${model.scenarioB_cheapGuardOnlyMsPerMinute} ms/分，C ${model.scenarioC_cheapGuardAndNoDocumentWriteMsPerMinute} ms/分`);
}
