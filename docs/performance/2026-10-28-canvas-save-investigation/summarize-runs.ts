/**
 * 汇总多次测量：对每个指标取「各轮次中位数的中位数」，再按同一调用模型
 * 重算 A/B/C 三种情景，输出 raw/summary.json 与可直接粘贴的 Markdown 表。
 *
 * 运行：
 *   cd <repo>/web && bun ../docs/performance/2026-10-28-canvas-save-investigation/summarize-runs.ts
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dir, "raw");
const files = readdirSync(dir).filter((name) => /^run-\d+\.json$/.test(name)).sort();
if (!files.length) throw new Error("没有 raw/run-N.json，请先运行 measure-canvas-save-cost.ts");

const runs = files.map((name) => JSON.parse(readFileSync(resolve(dir, name), "utf8")));
const nodeCounts: number[] = runs[0].results.map((row: { nodeCount: number }) => row.nodeCount);
const operations: string[] = runs[0].results[0].rows.map((row: { operation: string }) => row.operation);

function median(values: number[]) {
    const sorted = [...values].sort((left, right) => left - right);
    return Number(sorted[Math.floor(sorted.length / 2)].toFixed(4));
}

const table = nodeCounts.map((nodeCount) => {
    const perOperation = Object.fromEntries(operations.map((operation) => {
        const values = runs.map((run) => run.results.find((row: { nodeCount: number }) => row.nodeCount === nodeCount).rows.find((row: { operation: string }) => row.operation === operation).medianMs as number);
        return [operation, median(values)];
    }));
    const bytes = runs[0].results.find((row: { nodeCount: number }) => row.nodeCount === nodeCount).serializedBytes as number;
    const guard = perOperation["sameCanvasContent(current, ticked)"];
    const cheap = perOperation["canvasDocumentMatchesFields(current, { nodes: ticked })"];
    const editor = perOperation["canvasDocumentMatchesFields(observed, renderSnapshot)"];
    const editorMerge = perOperation["mergeCanvasRefreshPatch(base, incoming, live)"];
    const unconfirmed = perOperation["sameCanvasDocument(confirmed, live)"];
    const flush = perOperation["parse + rebase + serialize"];
    const backend = perOperation["sameCanvasDocument(confirmed, live)"] + perOperation["structuredClone(project)"] + perOperation["JSON.stringify(project)"];
    const scenarios = (pollMs: number) => {
        const ticks = Math.floor(60_000 / pollMs);
        const L1 = ticks * guard;
        const L2 = ticks * editor * 2;
        const L3 = ticks * editorMerge;
        const L4 = ticks * unconfirmed;
        const L5 = ticks * flush;
        const L6 = ticks * backend;
        return {
            pollMs,
            ticks,
            A: Number((L1 + L2 + L3 + L4 + L5 + L6).toFixed(2)),
            B: Number((ticks * cheap + L2 + L3 + L4 + L5 + L6).toFixed(2)),
            C: Number((ticks * (cheap + editor * 2)).toFixed(2)),
            layers: { L1: Number(L1.toFixed(2)), L2: Number(L2.toFixed(2)), L3: Number(L3.toFixed(2)), L4: Number(L4.toFixed(2)), L5: Number(L5.toFixed(2)), L6: Number(L6.toFixed(2)) },
        };
    };
    return { nodeCount, serializedBytes: bytes, perOperation, scenarios: [scenarios(2000), scenarios(500)] };
});

const summary = {
    scope: runs[0].scope,
    runtime: runs[0].runtime,
    platform: runs[0].platform,
    cpuCount: runs[0].cpuCount,
    loadAveragePerRun: runs.map((run) => run.loadAverage),
    runs: files,
    aggregation: "每个指标取各轮次中位数的中位数（3 轮）",
    table,
    perRunScenarios: runs.map((run, index) => ({
        run: files[index],
        loadAverage: run.loadAverage,
        scenarios: run.models.map((model: { nodeCount: number; pollMs: number; scenarioA_currentMsPerMinute: number; scenarioB_cheapGuardOnlyMsPerMinute: number; scenarioC_cheapGuardAndNoDocumentWriteMsPerMinute: number }) => ({
            nodeCount: model.nodeCount,
            pollMs: model.pollMs,
            A: model.scenarioA_currentMsPerMinute,
            B: model.scenarioB_cheapGuardOnlyMsPerMinute,
            C: model.scenarioC_cheapGuardAndNoDocumentWriteMsPerMinute,
        })),
    })),
};
writeFileSync(resolve(dir, "summary.json"), JSON.stringify(summary, null, 2));

const header = ["节点", "文档字节", "sameCanvasContent(进度 tick)", "编辑器比较", "编辑器合并", "候选守卫(按元素)", "sameCanvasDocument(确认差异/后端入队)", "parse+rebase+serialize", "structuredClone", "JSON.stringify"];
console.log("| " + header.join(" | ") + " |");
console.log("|" + header.map(() => "---").join("|") + "|");
for (const row of table) {
    const cell = (name: string) => row.perOperation[name].toFixed(3);
    console.log("| " + [
        row.nodeCount,
        row.serializedBytes,
        cell("sameCanvasContent(current, ticked)"),
        cell("canvasDocumentMatchesFields(observed, renderSnapshot)"),
        cell("mergeCanvasRefreshPatch(base, incoming, live)"),
        cell("canvasDocumentMatchesFields(current, { nodes: ticked })"),
        cell("sameCanvasDocument(confirmed, live)"),
        cell("parse + rebase + serialize"),
        cell("structuredClone(project)"),
        cell("JSON.stringify(project)"),
    ].join(" | ") + " |");
}
console.log("\n| 节点 | 轮询 | A 现状 ms/分 | B 只换守卫 ms/分 | C 守卫+进度不进文档 ms/分 |");
console.log("|---|---|---|---|---|");
for (const row of table) {
    for (const scenario of row.scenarios) {
        console.log(`| ${row.nodeCount} | ${scenario.pollMs} ms | ${scenario.A} | ${scenario.B} | ${scenario.C} |`);
    }
}

console.log("\n## 三轮区间（A 现状，说明负载噪声）");
for (const nodeCount of nodeCounts) {
    for (const pollMs of [2000, 500]) {
        const values = summary.perRunScenarios.map((run) => run.scenarios.find((scenario) => scenario.nodeCount === nodeCount && scenario.pollMs === pollMs)!.A).sort((left, right) => left - right);
        console.log(`  ${nodeCount} 节点 / ${pollMs}ms：${values.join(" / ")} ms/分（最小 / 中位 / 最大）`);
    }
}
