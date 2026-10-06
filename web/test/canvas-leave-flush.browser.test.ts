import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

// Renders the real useCanvasProjectLifecycle through the shared restart harness
// and proves a deletion reaches the backend right after the page is hidden,
// ahead of the 500 ms debounced backend sync.

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let commits: Array<{ at: number; connections: unknown[] }> = [];
const remote = { id: "c1", revision: 111, title: "Restart", createdAt: "2026-10-02", updatedAt: "2026-10-02", nodes: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, type: "image", title: `Node ${i}`, width: 320, height: 200, position: { x: i * 400, y: 0 }, metadata: {} })), connections: Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, fromNodeId: `n${i}`, toNodeId: `n${i + 1}` })), chatSessions: [], activeChatId: null, backgroundMode: "grid", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [] };
let backend = structuredClone(remote);

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-lifecycle-restart-harness.tsx"], target: "browser", define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "source", setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0]!.text();
    const json = (data: unknown) => Response.json({ code: 0, data, msg: "ok" });
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "application/javascript" } });
        if (path === "/api/canvas-projects/c1") return json({ project: backend });
        if (path === "/api/ops/canvas.document.commit") {
            const body = await request.json();
            if (body.params.expectedRevision !== backend.revision) return Response.json({ code: 409, data: null, msg: "Revision conflict", reason: "canvas_revision_conflict" }, { status: 409 });
            commits.push({ at: Date.now(), connections: body.params.document.connections });
            backend = { ...body.params.document, revision: backend.revision + 1 };
            return json({ revision: backend.revision, result: { canvasId: "c1", revision: backend.revision, title: backend.title, updatedAt: backend.updatedAt } });
        }
        if (path.startsWith("/api/")) return json([]);
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); });
beforeEach(() => {
    backend = structuredClone(remote);
    commits = [];
});

for (const trigger of ["pagehide", "visibilitychange"] as const) test(`a deletion is committed right after ${trigger}, before the debounced sync`, async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(server.url.toString());
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    await page.evaluate(() => (window as any).__lifecycle.deleteEdges());
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
    const hiddenAt = Date.now();
    await page.evaluate((kind) => {
        if (kind === "pagehide") {
            window.dispatchEvent(new Event("pagehide"));
            return;
        }
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
    }, trigger);
    const deadline = Date.now() + 2000;
    while (!commits.some(c => c.connections.length === 0) && Date.now() < deadline) await Bun.sleep(10);
    const commit = commits.find(c => c.connections.length === 0);
    expect(commit).toBeDefined();
    // The debounced backend sync waits 500 ms after the edit; the leave flush must not.
    expect(commit!.at - hiddenAt).toBeLessThan(400);
    expect(backend.connections).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
}, 30000);
