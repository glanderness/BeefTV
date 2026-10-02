import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let release: () => void;
let gate: Promise<void>;
let commits: any[] = [];
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
        if (path === "/api/canvas-projects/c1") { await gate; return json({ project: backend }); }
        if (path === "/api/ops/canvas.document.commit") {
            const body = await request.json();
            if (body.params.expectedRevision !== backend.revision) return Response.json({ code: 409, data: null, msg: "Revision conflict", reason: "canvas_revision_conflict" }, { status: 409 });
            commits.push(body);
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
    gate = new Promise<void>(resolve => { release = resolve; });
    backend = structuredClone(remote);
    commits = [];
});

for (const restartLoad of [false, true]) test(`confirmed edges survive cached load and media update (hydration restarts load: ${restartLoad})`, async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(server.url.toString());
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
    if (restartLoad) {
        // The server projection reaches the store while a render still owns the stale cached graph.
        // Changing hydration and node metadata schedules load and autosave in one passive-effect batch.
        await page.evaluate((graph) => (window as any).__lifecycle.restartLoad(graph), remote);
        await page.waitForTimeout(100);
    }
    release();
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    await page.evaluate(() => (window as any).__lifecycle.media());
    await page.waitForTimeout(100);
    const details = await page.evaluate(() => ({ renders: (window as any).__lifecycle.renders, updates: (window as any).__lifecycle.updates }));
    expect(details.updates.filter((u: any) => u.revision === 111).every((u: any) => u.edges === 6)).toBe(true);
    expect(errors).toEqual([]);
    await page.evaluate(() => (window as any).__lifecycle.save());
    expect(backend.connections).toHaveLength(6);
    expect(commits.every(c => c.params.document.connections.length === 6)).toBe(true);
    await page.close();
}, 30000);

test("manual deletion after a completed projection is still saved and survives reopening", async () => {
    const page = await browser.newPage();
    release();
    await page.goto(server.url.toString());
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    await page.evaluate(() => (window as any).__lifecycle.deleteEdges());
    await page.waitForFunction(() => (window as any).__lifecycle.updates.at(-1)?.edges === 0);
    await page.evaluate(() => (window as any).__lifecycle.save());
    expect(backend.connections).toEqual([]);
    expect(commits.at(-1).params.document.connections).toEqual([]);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
    expect(backend.connections).toEqual([]);
    await page.close();
}, 30000);

for (const scenario of ["missing-cache", "missing-cache-and-journal"]) test(`${scenario} restores the full backend graph without manufacturing deletions`, async () => {
    const page = await browser.newPage();
    release();
    await page.goto(`${server.url}?scenario=${scenario}`);
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    await page.evaluate(() => (window as any).__lifecycle.media());
    await page.waitForTimeout(50);
    await page.evaluate(() => (window as any).__lifecycle.save());
    expect(backend.connections).toHaveLength(6);
    expect(commits.every(c => c.params.document.connections.length === 6)).toBe(true);
    await page.close();
}, 30000);

test("dirty cached graph with a stale journal does not overwrite a newer backend graph", async () => {
    const page = await browser.newPage();
    release();
    await page.goto(`${server.url}?scenario=dirty-cache`);
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
    const error = await page.evaluate(async () => { try { await (window as any).__lifecycle.save(); return null; } catch (e) { return (e as Error).name; } });
    expect(error).not.toBeNull();
    expect(backend.connections).toHaveLength(6);
    expect(commits).toHaveLength(0);
    await page.close();
}, 30000);
