/**
 * 真实入口运行计数：构建 runtime-count/harness.tsx，起一个假后端（免费假生成，无付费上游），
 * 用 Playwright 在真实 Chromium 里跑 2s / 500ms / 120ms 三种输入节奏，
 * 统计「比较、保存、请求」在真实生产代码里各自真正执行了多少次。
 *
 * 计数方式：构建期在真实产品源码的函数体开头插入 __bumpCount(...)（不改仓库里的文件），
 * 计数落在页面 globalThis.__counts 上；后端提交次数由假后端自己统计。
 *
 * 运行：
 *   bun docs/performance/2026-10-28-canvas-save-investigation/runtime-count/run.ts
 * 可选：
 *   --nodes=300           画布节点数（默认 300）
 *   --out=<path>          原始计数 JSON 输出路径（默认同目录 raw/runtime-count.json）
 *   --quick               只跑一轮短窗口，用于冒烟
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium, type Browser } from "playwright";

const WEB_ROOT = resolve(import.meta.dir, "../../../../web");
const OUT_DIR = resolve(import.meta.dir, "raw");

const argOf = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const NODES = Number(argOf("nodes") || 300);
const OUT = resolve(argOf("out") || resolve(OUT_DIR, "runtime-count.json"));
const QUICK = process.argv.includes("--quick");

type Scenario = { mode: "poll" | "content"; cadenceMs: number; ticks: number };

const SCENARIOS: Scenario[] = argOf("scenarios")
    ? argOf("scenarios")!.split(",").map(entry => {
        const [mode, cadenceMs, ticks] = entry.split(":");
        return { mode: mode as Scenario["mode"], cadenceMs: Number(cadenceMs), ticks: Number(ticks) };
    })
    : QUICK
        ? [{ mode: "poll", cadenceMs: 2000, ticks: 3 }]
        : [
            { mode: "poll", cadenceMs: 2000, ticks: 8 },
            { mode: "poll", cadenceMs: 500, ticks: 24 },
            { mode: "content", cadenceMs: 120, ticks: 60 },
        ];

// ---------------------------------------------------------------------------
// 构建期计数注入。插入语句而不是替换导出，避免破坏模块内部互相调用。
// ---------------------------------------------------------------------------
const BUMP_PRELUDE = `const __bumpCount = (name: string) => { const g = globalThis as unknown as { __counts?: Record<string, number>; __timeline?: Array<[string, number]>; __recordTimeline?: boolean }; const store = (g.__counts = g.__counts || {}); store[name] = (store[name] || 0) + 1; if (g.__recordTimeline) (g.__timeline = g.__timeline || []).push([name, Math.round(performance.now())]); };\n`;
const BUMP_PRELUDE_JS = `const __bumpCount = (name) => { const g = globalThis; const store = (g.__counts = g.__counts || {}); store[name] = (store[name] || 0) + 1; if (g.__recordTimeline) (g.__timeline = g.__timeline || []).push([name, Math.round(performance.now())]); };\n`;

type Injection = { file: string; marker: string; name: string };

const INJECTIONS: Injection[] = [
    { file: "src/lib/canvas/canvas-content.ts", marker: "export function sameCanvasContent(left: CanvasProject | undefined, right: CanvasProject | undefined) {", name: "sameCanvasContent" },
    { file: "src/lib/canvas/canvas-content.ts", marker: "export function sameCanvasDocument(left: CanvasProject | undefined, right: CanvasProject | undefined) {", name: "sameCanvasDocument" },
    { file: "src/lib/canvas/canvas-document-equality.ts", marker: "export function sameCanvasDocumentValue(left: unknown, right: unknown): boolean {", name: "sameCanvasDocumentValue" },
    { file: "src/lib/canvas/canvas-document-equality.ts", marker: "export function canvasDocumentMatchesFields(document: object, fields: object): boolean {", name: "canvasDocumentMatchesFields" },
    { file: "src/lib/canvas/canvas-patch-merge.ts", marker: "export function mergeCanvasRefreshPatch(previous: CanvasProject, incoming: CanvasProject, nodes: CanvasNodeData[], connections: CanvasConnection[]) {", name: "mergeCanvasRefreshPatch" },
    { file: "src/lib/canvas/canvas-storage-revision.ts", marker: "export function serializeCanvasStorageDocument(document: CanvasStorageDocument) {", name: "serializeCanvasStorageDocument" },
    { file: "src/lib/canvas/canvas-storage-revision.ts", marker: "export function rebaseCanvasProjects(input: { document: CanvasStorageDocument; baseProjects: CanvasProject[]; localProjects: CanvasProject[]; baseRevision: number }) {", name: "rebaseCanvasProjects" },
    { file: "src/lib/localforage-storage.ts", marker: "        setItem: async (name, value) => {\n            if (typeof window === \"undefined\") return;", name: "indexedDb.setItem", code: `__bumpCount("indexedDb.setItem"); __bumpCount("indexedDb.setItem::" + String(name));` },
    { file: "src/stores/canvas/use-canvas-store.ts", marker: "            updateProject: (id, patch) => set((state) => {", name: "store.updateProject" },
    { file: "src/stores/canvas/use-canvas-store.ts", marker: "                return { projects: state.projects.map((project) => project === current ? next : project) };", name: "store.updateProject.write", before: true },
    { file: "src/stores/canvas/use-canvas-store.ts", marker: "async function writeQueuedCanvasPersist(scope: string, _token: number) {", name: "flush.writeQueuedCanvasPersist" },
    { file: "src/services/local-workspace-repository.ts", marker: "export function scheduleLocalCanvasBackendSync(id: string) {", name: "backend.scheduleSync" },
    { file: "src/services/local-workspace-repository.ts", marker: "function syncLocalCanvasProject(id: string, expected: CapturedUserScope): Promise<void> {", name: "backend.syncLocalCanvasProject" },
    { file: "src/services/api/operations.ts", marker: "    return executeWorkspaceOperation<CanvasDocumentCommitResult>(\"canvas.document.commit\", {", name: "backend.commitCanvasDocument", before: true },
];

type Injection = { file: string; marker: string; name: string; code?: string; before?: boolean };

function instrument(absolutePath: string, contents: string): string | undefined {
    const relative = absolutePath.startsWith(WEB_ROOT + "/") ? absolutePath.slice(WEB_ROOT.length + 1) : absolutePath;
    const applicable = INJECTIONS.filter(item => item.file === relative);
    if (!applicable.length) return undefined;
    let next = BUMP_PRELUDE + contents;
    for (const injection of applicable) {
        const occurrences = next.split(injection.marker).length - 1;
        if (occurrences !== 1) throw new Error(`计数注入标记不唯一（${occurrences} 次）：${injection.file} :: ${injection.marker.slice(0, 60)}`);
        const statement = injection.code ?? `__bumpCount(${JSON.stringify(injection.name)});`;
        next = next.replace(injection.marker, injection.before
            ? `${statement}\n${injection.marker}`
            : `${injection.marker}\n    ${statement}`);
    }
    return next;
}

const JSON_CANONICALIZE_ENTRY = resolve(WEB_ROOT, "node_modules/json-canonicalize/esm5/index.js");
const JSON_CANONICALIZE_MARKER = "export function canonicalize(obj, allowCircular) {";

const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "harness.tsx")],
    target: "browser",
    minify: false,
    define: {
        "import.meta.env.DEV": "false",
        "import.meta.env.PROD": "true",
        "import.meta.env.MODE": '"production"',
        "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
        "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
        "process.env.NODE_ENV": '"production"',
    },
    plugins: [{
        name: "runtime-count",
        setup(builder) {
            builder.onResolve({ filter: /.*/ }, args => {
                const specifier = args.path;
                if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
                const insideWeb = args.importer.startsWith(`${WEB_ROOT}/`);
                const insideModules = args.importer.includes("/node_modules/");
                // web/ 与 node_modules 内部的裸导入交给 Bun 默认解析：条件导出（browser）
                // 与包内相对路径都不能被劫持，否则会打进 node 版实现（例如 nanoid 的 Buffer）。
                if (insideModules) return undefined;
                if (insideWeb && specifier !== "json-canonicalize") return undefined;
                if (specifier === "json-canonicalize") return { path: JSON_CANONICALIZE_ENTRY };
                try {
                    // 夹具在 docs/ 下：@/ 走 web/tsconfig.json 的 paths，裸包名走 web/node_modules。
                    return { path: Bun.resolveSync(specifier, WEB_ROOT) };
                } catch {
                    return undefined;
                }
            });
            builder.onLoad({ filter: /json-canonicalize\/esm[0-9]+\/canonicalize\.js$/ }, args => {
                const contents = readFileSync(args.path, "utf8");
                if (!contents.includes(JSON_CANONICALIZE_MARKER)) throw new Error("json-canonicalize 计数标记缺失，版本可能变了");
                return { loader: "js", contents: `${BUMP_PRELUDE_JS}${contents.replace(JSON_CANONICALIZE_MARKER, `${JSON_CANONICALIZE_MARKER}\n    __bumpCount("canonicalize");`)}` };
            });
            builder.onLoad({ filter: /\.tsx?$/ }, args => {
                const instrumented = instrument(args.path, readFileSync(args.path, "utf8"));
                return instrumented === undefined ? undefined : { loader: args.path.endsWith(".tsx") ? "tsx" : "ts", contents: instrumented };
            });
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        },
    }],
});
if (!build.success) {
    for (const log of build.logs) console.error(String(log));
    throw new Error("harness 构建失败");
}
const script = await build.outputs[0]!.text();

// ---------------------------------------------------------------------------
// 假后端：免费假生成，只有 CAS 提交与画布读取；提交次数就是真实请求计数。
// ---------------------------------------------------------------------------
const remote = structuredClone(project0());
function project0() {
    return {
        id: "c1", revision: 105, title: "运行计数夹具", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
        nodes: [] as unknown[], connections: [] as unknown[], chatSessions: [], activeChatId: null,
        backgroundMode: "grid", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [],
    };
}
let backend = structuredClone(remote);
const requests = { commit: 0, commitAccepted: 0, commitConflict: 0, readProject: 0, listProjects: 0, other: 0 };
const commitTimeline: Array<{ at: number; nodes: number; revision: number }> = [];

const json = (data: unknown) => Response.json({ code: 0, data, msg: "ok" });
const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "application/javascript" } });
        if (path === "/__seed" && request.method === "POST") {
            const seeded = await request.json() as typeof backend;
            backend = { ...seeded, revision: seeded.revision ?? 105 };
            return json({ ok: true, nodes: Array.isArray(seeded.nodes) ? seeded.nodes.length : 0 });
        }
        if (path === "/api/canvas-projects/c1/events") {
            const encoder = new TextEncoder();
            let timer: ReturnType<typeof setInterval> | undefined;
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(`event: ready\ndata: {"revision":${backend.revision}}\n\n`));
                    timer = setInterval(() => {
                        try { controller.enqueue(encoder.encode(": keep-alive\n\n")); } catch { if (timer) clearInterval(timer); }
                    }, 5000);
                },
                cancel() { if (timer) clearInterval(timer); },
            });
            return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
        }
        if (path === "/api/canvas-projects/c1") {
            requests.readProject += 1;
            return json({ project: structuredClone(backend) });
        }
        if (path === "/api/canvas-projects") {
            requests.listProjects += 1;
            return json({ projects: [{ id: "c1" }] });
        }
        if (path === "/api/ops/canvas.document.commit") {
            requests.commit += 1;
            const body = await request.json() as { opId: string; params: { canvasId: string; expectedRevision: number; document: Record<string, unknown> & { nodes: unknown[] } } };
            if (body.params.expectedRevision !== backend.revision) {
                requests.commitConflict += 1;
                return Response.json({ code: 409, data: null, msg: "Revision conflict", reason: "canvas_revision_conflict" }, { status: 409 });
            }
            backend = { ...structuredClone(body.params.document), id: "c1", revision: backend.revision + 1 } as typeof backend;
            requests.commitAccepted += 1;
            commitTimeline.push({ at: Date.now(), nodes: body.params.document.nodes.length, revision: backend.revision });
            return json({ op: "canvas.document.commit", opId: body.opId, replayed: false, revision: backend.revision, result: { canvasId: "c1", revision: backend.revision, title: "运行计数夹具", updatedAt: new Date().toISOString() } });
        }
        if (path.startsWith("/api/")) { requests.other += 1; return json([]); }
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    },
});

const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
let browser: Browser | undefined;
const report = {
    scope: "真实浏览器里的真实生产入口运行计数：真实 useCanvasProjectLifecycle + useCanvasGeneration + zustand 画布 store + 真实 400/500ms 去抖；后端是假 CAS 服务，生成任务由假任务对象驱动（无付费上游）",
    runtime: `bun ${Bun.version} / chromium ${browser?.version?.() ?? "unknown"}`,
    platform: `${process.platform}/${process.arch}`,
    cpuCount: (await import("node:os")).cpus().length,
    loadAverage: (await import("node:os")).loadavg().map(value => Number(value.toFixed(2))),
    measuredAt: new Date().toISOString(),
    nodeCount: NODES,
    scenarios: [] as unknown[],
    requests,
};

try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") pageErrors.push(`console: ${message.text()}`); });
    await page.goto(`${server.url.toString()}?nodes=${NODES}`);
    try {
        await page.waitForFunction((expected) => document.querySelector('[data-testid="graph"]')?.textContent === `true:${expected}:0`, NODES, { timeout: 90000 });
    } catch (error) {
        console.error("画布未在超时内加载完成；页面错误：\n" + pageErrors.join("\n"));
        console.error("graph = " + await page.evaluate(() => document.querySelector('[data-testid="graph"]')?.textContent));
        throw error;
    }
    const loaded = await page.evaluate(() => document.querySelector('[data-testid="graph"]')?.textContent);
    for (const scenario of SCENARIOS) {
        const requestsBefore = structuredClone(requests);
        const commitsBefore = commitTimeline.length;
        const result = await page.evaluate(([mode, cadenceMs, ticks]) => (window as unknown as { __probe: { run: (mode: string, cadenceMs: number, ticks: number) => Promise<unknown> } }).__probe.run(mode as "poll", cadenceMs, ticks), [scenario.mode, scenario.cadenceMs, scenario.ticks] as const);
        const requestsAfter = structuredClone(requests);
        (report.scenarios as unknown[]).push({
            ...(result as Record<string, unknown>),
            requests: {
                commit: requestsAfter.commit - requestsBefore.commit,
                commitAccepted: requestsAfter.commitAccepted - requestsBefore.commitAccepted,
                commitConflict: requestsAfter.commitConflict - requestsBefore.commitConflict,
                readProject: requestsAfter.readProject - requestsBefore.readProject,
            },
            commits: commitTimeline.slice(commitsBefore),
        });
    }
    report.pageErrors = pageErrors;
    report.graph = loaded;
} finally {
    await browser?.close();
    server.stop(true);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`运行计数原始数据: ${OUT}`);
for (const scenario of report.scenarios as Array<Record<string, any>>) {
    console.log(`\n## ${scenario.mode} @ ${scenario.cadenceMs}ms × ${scenario.ticks} tick（节点 ${scenario.nodes}）`);
    for (const [name, value] of Object.entries(scenario.counts as Record<string, number>).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(value).padStart(6)}  ${name}`);
    }
    console.log(`  请求：${JSON.stringify(scenario.requests)}`);
}
if (report.pageErrors.length) console.log(`\n页面错误：\n${report.pageErrors.join("\n")}`);
