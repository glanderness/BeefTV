/**
 * 画布悬停路径的浏览器测量（可重放，不联网、不调用模型、不写用户数据）。
 *
 *   cd web && bun run scripts/canvas-interaction-hover-bench.ts --nodes 300
 *
 * 用仓库自己的 canvas-render-performance 夹具（真实 useCanvasRenderModel +
 * CanvasProjectWorldLayers + 真实 CanvasNode），测量「页面级 hoveredNodeId 变化」
 * 一次同步提交的耗时、重渲染的卡片数，以及渲染模型重算耗时。夹具的构建走
 * scripts/canvas-render-performance-server.ts 的插桩（统计 CanvasNode 渲染次数）。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dir, "..");
const argument = (name: string, fallback: number) => {
    const at = process.argv.indexOf(`--${name}`);
    return at >= 0 && process.argv[at + 1] ? Number(process.argv[at + 1]) : fallback;
};
const nodes = argument("nodes", 300);
const iterations = argument("iterations", 40);
const scale = argument("scale", 0.25);
const variant = "after";

const build = Bun.spawnSync(["bun", "run", "scripts/canvas-render-performance-server.ts", variant, "--build-only"], { cwd: root, stdout: "pipe", stderr: "pipe" });
if (build.exitCode !== 0) throw new Error(`构建失败：${build.stderr.toString()}`);

const directory = resolve(root, `.local/canvas-performance/${variant}`);
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
        const path = new URL(request.url).pathname;
        if (!path.startsWith(`/${variant}/`)) return new Response("Not found", { status: 404 });
        const target = path.slice(variant.length + 2).replace(/\/$/, "");
        const file = Bun.file(resolve(directory, target || "test/fixtures/canvas-render-performance.html"));
        return (await file.exists()) ? new Response(file, { headers: { "Cache-Control": "no-store" } }) : new Response("Not found", { status: 404 });
    },
});

const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage();
try {
    await page.goto(`${server.url}${variant}/?nodes=${nodes}&scale=${scale}`);
    await page.waitForFunction(() => (window as any).__canvasPerf?.ready === true, undefined, { timeout: 30_000 });
    const results: Record<string, unknown> = {};
    for (const kind of ["hover", "hover-leave", "title", "pan"]) {
        results[kind] = await page.evaluate(async ({ kind, iterations }) => (window as any).__canvasPerf.run(kind, iterations), { kind, iterations });
    }
    console.log(JSON.stringify({
        scope: "真实画布组件的浏览器内同步提交耗时与卡片重渲染次数；不含绘制/合成、原生宿主和真实鼠标事件分发",
        nodes,
        iterations,
        scale,
        variant,
        results,
    }, null, 2));
} finally {
    await browser.close();
    await server.stop(true);
}
