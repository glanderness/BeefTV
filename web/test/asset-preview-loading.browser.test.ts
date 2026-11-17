import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let mediaRequests = 0;
let activeRequests = 0;
let peakRequests = 0;
let stallFirst = false;
let releaseStall: (() => void) | undefined;
let notifyStall: (() => void) | undefined;
let failFirstFile = false;

beforeAll(async () => {
    const video = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=orange:s=160x90:r=10:d=0.4", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov", "pipe:1"]);
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/asset-preview-loading-harness.tsx"], target: "browser", plugins: [{ name: "source-alias", setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }], define: { "import.meta.env": '{"VITE_CANVAS_LOCAL_MODE":"false"}', "process.env.NODE_ENV": '"production"' } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const previewCSS = readFileSync(import.meta.dir + "/../src/styles/assets-reference-baseline.css", "utf8");
    server = Bun.serve({ port: 0, idleTimeout: 30, async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (/^\/api\/resources\/[^/]+\/file$/.test(path)) {
            mediaRequests++; activeRequests++; peakRequests = Math.max(peakRequests, activeRequests);
            if (failFirstFile) {
                failFirstFile = false;
                activeRequests--;
                return new Response("temporarily unavailable", { status: 503 });
            }
            if (stallFirst && path === "/api/resources/video-0-0/file") await new Promise<void>(resolve => { releaseStall = resolve; notifyStall?.(); });
            await new Promise(resolve => setTimeout(resolve, 40));
            activeRequests--;
            return new Response(video, { headers: { "Content-Type": "video/mp4" } });
        }
        if (/^\/api\/resources\/[^/]+$/.test(path)) return Response.json({ code: 0, data: { resource: { id: path.split("/")[3], kind: "video", playbackStatus: "ready" } } });
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: [] });
        const fixture = JSON.stringify({ count: Number(url.searchParams.get("count") || 12), poster: url.searchParams.has("poster"), portrait: url.searchParams.has("portrait") });
        return new Response(`<style>.preview{display:block;width:100%;height:100%;object-fit:cover}${previewCSS}</style><div id="root"></div><script>window.__fixture=${fixture}</script><script type="module" src="/harness.js"></script>`, { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || chromium.executablePath(), headless: true });
}, 60_000);

beforeEach(async () => {
    await page?.close();
    releaseStall?.(); releaseStall = undefined; notifyStall = undefined; stallFirst = false; failFirstFile = false;
    mediaRequests = 0; activeRequests = 0; peakRequests = 0;
    page = await browser.newPage();
    await page.setViewportSize({ width: 900, height: 900 });
});

test("120 poster-backed cards display covers without loading video files or keeping decoders", async () => {
    await page.goto(`${server.url}?poster&count=120`);
    await page.locator('[data-card="video-0-0"]').waitFor();
    expect(await page.locator("[data-card]").count()).toBe(120);
    await page.getByRole("button", { name: "点击响应 0", exact: true }).click();
    await page.getByRole("button", { name: "点击响应 1", exact: true }).waitFor();
    expect(await page.locator("video").count()).toBe(0);
    expect(mediaRequests).toBe(0);
    expect(await page.locator('img[alt="video-0-0"]').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
});

test("missing posters hydrate as images with bounded media work and release the decoder", async () => {
    await page.goto(server.url.toString());
    await page.waitForFunction(() => document.querySelectorAll("[data-card] img").length === 12, null, { timeout: 20_000 });
    expect(peakRequests).toBeLessThanOrEqual(2);
    expect(mediaRequests).toBe(12);
    expect(await page.locator("video").count()).toBe(0);
    expect(await page.locator("[data-card] img").evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    const posterSource = await page.locator("[data-card] img").first().getAttribute("src");
    await page.getByRole("button", { name: "切换列表", exact: true }).click();
    expect(await page.locator("[data-card]").count()).toBe(0);
    expect(await page.evaluate(url => fetch(url!).then(() => true, () => false), posterSource)).toBe(false);
    await page.getByRole("button", { name: "点击响应 0", exact: true }).click();
    await page.getByRole("button", { name: "点击响应 1", exact: true }).waitFor();
}, 30_000);

test("detail posters retain the existing contain fit and height limit", async () => {
    await page.goto(`${server.url}?poster&portrait&count=1`);
    const image = page.getByRole("img", { name: "video-0-0", exact: true });
    await image.waitFor();
    expect(await image.evaluate(element => getComputedStyle(element).objectFit)).toBe("contain");
    expect(await image.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(320);
});

test("a stalled video cannot monopolize poster loading for later ready cards", async () => {
    stallFirst = true;
    const stalled = new Promise<void>(resolve => { notifyStall = resolve; });
    await page.goto(`${server.url}?count=1`);
    await stalled;
    await page.getByRole("button", { name: "添加素材", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('img[alt="video-0-1"]') as HTMLImageElement)?.naturalWidth > 0, null, { timeout: 14_000 });
    await page.getByRole("button", { name: "点击响应 0", exact: true }).click();
    await page.getByRole("button", { name: "点击响应 1", exact: true }).waitFor();
    expect(await page.locator("video").count()).toBe(0);
}, 20_000);

test("hover owns one decoder and leaving or navigating releases its source", async () => {
    await page.goto(`${server.url}?poster&count=2`);
    await page.locator('[data-card="video-0-0"] .preview').hover();
    await page.waitForFunction(() => (document.querySelector("video")?.readyState || 0) >= 2);
    expect(mediaRequests).toBe(1);
    const firstSource = await page.locator("video").getAttribute("src");
    await page.locator('[data-card="video-0-1"] .preview').hover();
    await page.waitForFunction(() => document.querySelector('video')?.getAttribute("src") !== null && (document.querySelector("video")?.readyState || 0) >= 2);
    expect(await page.locator("video").count()).toBe(1);
    expect(await page.evaluate(url => fetch(url!).then(() => true, () => false), firstSource)).toBe(false);
    await page.getByRole("button", { name: "切换列表", exact: true }).click();
    expect(await page.locator("video").count()).toBe(0);
});

test("navigation cancels a stalled source immediately instead of holding the next page", async () => {
    stallFirst = true;
    const stalled = new Promise<void>(resolve => { notifyStall = resolve; });
    await page.goto(`${server.url}?count=1`);
    await stalled;
    await page.getByRole("button", { name: "切换列表", exact: true }).click();
    await page.getByRole("button", { name: "换页", exact: true }).click();
    await page.getByRole("button", { name: "切换列表", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('img[alt="video-1-0"]') as HTMLImageElement)?.naturalWidth > 0, null, { timeout: 3_000 });
    expect(await page.locator("video").count()).toBe(0);
    expect(await page.locator('[alt="video-0-0"]').count()).toBe(0);
});

test("a visible card recovers its poster after one transient source failure", async () => {
    failFirstFile = true;
    await page.goto(`${server.url}?count=1`);
    await page.waitForFunction(() => (document.querySelector('img[alt="video-0-0"]') as HTMLImageElement)?.naturalWidth > 0, null, { timeout: 5_000 });
    expect(mediaRequests).toBe(2);
    expect(await page.locator("video").count()).toBe(0);
}, 10_000);

afterAll(async () => { releaseStall?.(); await page?.close(); await browser?.close(); server?.stop(true); });
