import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { existsSync } from "node:fs";

let server: ReturnType<typeof Bun.serve>;
let browser: Browser;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/export-integrity-harness.tsx"], target: "browser",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        // CanvasPage imports lazy editors; their Vite-only assets are unrelated to ZIP import.
        plugins: [{ name: "unused-editor-assets", setup(build) {
            build.onResolve({ filter: /(?:\.css|\?url)$/ }, (args) => ({ path: args.path, namespace: "unused-assets" }));
            build.onLoad({ filter: /.*/, namespace: "unused-assets" }, () => ({ contents: 'export default "";', loader: "js" }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: { projects: [], assets: [], folders: [] } });
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => { await browser?.close(); server?.stop(true); });

test("ZIP from real browser storage imports through CanvasPage into a fresh browser workspace", async () => {
    const source = await browser.newContext();
    const target = await browser.newContext();
    try {
        const page = await source.newPage();
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "测试缺失导出" }).waitFor();
        const archive = await page.evaluate(async () => (window as any).exportFixture.export());
        const imported = await target.newPage();
        await imported.goto(server.url.toString());
        await imported.getByRole("button", { name: "测试缺失导出" }).waitFor();
        const before = await imported.evaluate(async () => (window as any).exportFixture.snapshot());
        expect(before.projects).toHaveLength(0);
        expect(before.media).toBeNull();
        await imported.locator('input[type="file"]').setInputFiles({ name: "fixture.zip", mimeType: "application/zip", buffer: Buffer.from(archive, "base64") });
        await imported.getByText("已导入 2 个画布并保存到本地", { exact: true }).waitFor({ timeout: 15_000 });
        const after = await imported.evaluate(async () => (window as any).exportFixture.snapshot());
        expect(after.projects).toHaveLength(2);
        expect(after.media).toBe("unique archive bytes");
        for (const project of after.projects) {
            const media = project.timeline.clips[0].directMedia;
            expect(media.storageKey).toBe("audio:fixture:voice");
            expect(media.url).toStartWith("blob:");
            expect(media.url).not.toBe("blob:expired");
        }
    } finally { await source.close(); await target.close(); }
}, 30_000);

test("missing-file error is actually visible and no archive is saved", async () => {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "测试缺失导出" }).click();
        await page.getByText(/导出未完成：缺少 1 个文件/).waitFor();
        expect(await page.getByText(/导出未完成：缺少 1 个文件/).innerText()).toContain("audio:fixture:voice");
        expect((await page.evaluate(async () => (window as any).exportFixture.snapshot())).archive).toBe("");
    } finally { await context.close(); }
}, 15_000);
