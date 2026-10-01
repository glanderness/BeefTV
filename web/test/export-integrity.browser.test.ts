import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { build } from "vite";

let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let directory: string;

beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "beeftv-zip-browser-"));
    const dist = join(directory, "dist");
    // Use the application's bundler, including real lazy-editor assets. Bun.build
    // resolved this graph differently between local Bun 1.4 and CI Bun 1.3.9.
    await build({
        configFile: false, root: resolve(import.meta.dir, ".."), publicDir: false,
        cacheDir: join(directory, "cache"), logLevel: "error",
        define: { __BEEFTV_HEAVY_MEDIA_ENABLED__: "true", __APP_VERSION__: '"test"', __APP_CHANGELOG__: '""' },
        resolve: { alias: { "@": resolve(import.meta.dir, "../src") } },
        build: { outDir: dist, emptyOutDir: true, rolldownOptions: { input: resolve(import.meta.dir, "fixtures/export-integrity-harness.html") } },
    });
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: { projects: [], assets: [], folders: [] } });
        const file = path === "/" ? join(dist, "test/fixtures/export-integrity-harness.html") : resolve(dist, "." + path);
        return file.startsWith(dist + sep) && existsSync(file) ? new Response(Bun.file(file)) : new Response("Not found", { status: 404 });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => { await browser?.close(); server?.stop(true); if (directory) rmSync(directory, { recursive: true, force: true }); });

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
