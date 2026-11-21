import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
import { compileAppStyles } from "./helpers/app-styles";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let mediaRequests = 0;
let posterRequests = 0;
let activeRequests = 0;
let peakRequests = 0;
let stallFirst = false;
let releaseStall: (() => void) | undefined;
let notifyStall: (() => void) | undefined;
let failFirstFile = false;
let failServerPoster = false;

beforeAll(async () => {
    const video = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=orange:s=160x90:r=10:d=0.4", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov", "pipe:1"]);
    const posterJpg = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=orange:s=160x90:d=0.1", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"]);
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/asset-preview-loading-harness.tsx"], target: "browser", plugins: [{ name: "source-alias", setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }], define: { "import.meta.env": '{"VITE_CANVAS_LOCAL_MODE":"false"}', "process.env.NODE_ENV": '"production"' } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs.find(output => output.path.endsWith(".js"))!.text();
    const rawCss = await build.outputs.find(output => output.path.endsWith(".css"))?.text();
    const appCss = await compileAppStyles(rawCss ? [rawCss] : []);
    server = Bun.serve({ port: 0, idleTimeout: 30, async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/harness.css") return new Response(appCss, { headers: { "Content-Type": "text/css" } });
        if (/^\/api\/resources\/broken-cover-[^/]+\/(file|asset\/.+)$/.test(path)) {
            return new Response("broken cover", { status: 500 });
        }
        if (/^\/api\/resources\/[^/]+\/asset\/poster\.jpg$/.test(path)) {
            posterRequests++;
            if (failServerPoster) return new Response("poster unavailable", { status: 500 });
            return new Response(posterJpg, { headers: { "Content-Type": "image/jpeg" } });
        }
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
        const fixture = JSON.stringify({
            count: Number(url.searchParams.get("count") || 12),
            poster: url.searchParams.has("poster"),
            portrait: url.searchParams.has("portrait"),
            directPoster: url.searchParams.has("directPoster"),
            lowMemory: url.searchParams.has("lowMemory"),
            protectedCoverFail: url.searchParams.has("protectedCoverFail"),
            drawer: url.searchParams.has("drawer"),
            libraryCard: url.searchParams.has("libraryCard"),
            posterTimeoutMs: Number(url.searchParams.get("posterTimeoutMs") || 0),
            prestartCanvasPreview: url.searchParams.has("prestartCanvasPreview"),
            canvasVideoPoster: url.searchParams.has("canvasVideoPoster"),
        });
        return new Response(`<!doctype html><html><head><link rel="stylesheet" href="/harness.css"><style>.preview{display:block;width:100%;height:100%;object-fit:cover}</style></head><body><div id="root"></div><script>window.__fixture=${fixture}</script><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || chromium.executablePath(), headless: true });
}, 60_000);

beforeEach(async () => {
    await page?.close();
    releaseStall?.(); releaseStall = undefined; notifyStall = undefined; stallFirst = false; failFirstFile = false; failServerPoster = false;
    mediaRequests = 0; posterRequests = 0; activeRequests = 0; peakRequests = 0;
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
    expect(mediaRequests).toBeGreaterThanOrEqual(12);
    expect(await page.locator("video").count()).toBe(0);
    expect(await page.locator("[data-card] img").evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    const posterSource = await page.locator("[data-card] img").first().getAttribute("src");
    await page.getByRole("button", { name: "切换列表", exact: true }).click();
    expect(await page.locator("[data-card]").count()).toBe(0);
    expect(await page.evaluate(url => fetch(url!).then(() => true, () => false), posterSource)).toBe(false);
    await page.getByRole("button", { name: "点击响应 0", exact: true }).click();
    await page.getByRole("button", { name: "点击响应 1", exact: true }).waitFor();
}, 30_000);

test("40 visible coverless cards exceed the 32-entry canvas pool cap and still hydrate every poster without timeout storms", async () => {
    await page.setViewportSize({ width: 900, height: 1400 });
    await page.goto(`${server.url}?count=40`);
    await page.waitForFunction(() => {
        const imgs = Array.from(document.querySelectorAll("[data-card] img")) as HTMLImageElement[];
        return imgs.length === 40 && imgs.every(img => img.complete && img.naturalWidth > 0);
    }, null, { timeout: 30_000 });
    expect(peakRequests).toBeLessThanOrEqual(2);
    expect(mediaRequests).toBe(40);
    expect(await page.locator("video").count()).toBe(0);
}, 35_000);

test("detail portrait posters retain contain fit and 320px height limit under real app styles", async () => {
    await page.goto(`${server.url}?poster&portrait&count=1`);
    const image = page.getByRole("img", { name: "video-0-0", exact: true });
    await image.waitFor();
    const metrics = await image.evaluate((element: HTMLImageElement) => {
        const rect = element.getBoundingClientRect();
        return {
            objectFit: getComputedStyle(element).objectFit,
            height: rect.height,
            naturalWidth: element.naturalWidth,
            naturalHeight: element.naturalHeight,
        };
    });
    expect(metrics.objectFit).toBe("contain");
    expect(metrics.height).toBeLessThanOrEqual(320);
    expect(metrics.naturalHeight).toBeGreaterThan(metrics.naturalWidth);
});

test("a stalled video does not head-of-line block later ready cards on the shared 2-slot preview pool", async () => {
    stallFirst = true;
    const stalled = new Promise<void>(resolve => { notifyStall = resolve; });
    await page.goto(`${server.url}?count=1`);
    await stalled;
    const startedAt = Date.now();
    await page.getByRole("button", { name: "添加素材", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('img[alt="video-0-1"]') as HTMLImageElement)?.naturalWidth > 0, null, { timeout: 5_000 });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    await page.getByRole("button", { name: "点击响应 0", exact: true }).click();
    await page.getByRole("button", { name: "点击响应 1", exact: true }).waitFor();
    expect(await page.locator("video").count()).toBe(0);
}, 15_000);

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

test("desktop direct server posters load 120 cards without fetching video files or decoders", async () => {
    await page.goto(`${server.url}?directPoster&count=120`);
    await page.waitForFunction(() => (document.querySelector('img[alt="video-0-0"]') as HTMLImageElement)?.naturalWidth > 0, null, { timeout: 5_000 });
    expect(await page.locator("[data-card]").count()).toBe(120);
    await page.getByRole("button", { name: "点击响应 0", exact: true }).click();
    await page.getByRole("button", { name: "点击响应 1", exact: true }).waitFor();
    expect(posterRequests).toBeGreaterThan(0);
    expect(mediaRequests).toBe(0);
    expect(await page.locator("video").count()).toBe(0);
    expect(await page.locator('img[alt="video-0-0"]').getAttribute("src")).toContain("/api/resources/video-0-0/asset/poster.jpg?variant=poster");
}, 10_000);

test("failed server poster falls back to bounded client frame capture without oscillating", async () => {
    failServerPoster = true;
    await page.goto(`${server.url}?directPoster&count=1`);
    await page.waitForFunction(() => {
        const img = document.querySelector('img[alt="video-0-0"]') as HTMLImageElement | null;
        return Boolean(img && img.src.startsWith("blob:") && img.naturalWidth > 0);
    }, null, { timeout: 10_000 });
    expect(posterRequests).toBe(1);
    expect(mediaRequests).toBe(1);
    expect(await page.locator("video").count()).toBe(0);
}, 15_000);

test("low-memory mode disables hover video preview decoders", async () => {
    await page.goto(`${server.url}?poster&lowMemory&count=2`);
    await page.locator('[data-card="video-0-0"] .preview').hover();
    await page.waitForTimeout(350);
    expect(mediaRequests).toBe(0);
    expect(await page.locator("video").count()).toBe(0);
});

test("failed protected coverUrl falls back to server poster in desktop mode and frame capture in web mode", async () => {
    await page.goto(`${server.url}?protectedCoverFail&directPoster&count=1`);
    await page.waitForFunction(() => {
        const img = document.querySelector('img[alt="video-0-0"]') as HTMLImageElement | null;
        return Boolean(img && img.src.includes("/api/resources/video-0-0/asset/poster.jpg?variant=poster") && img.naturalWidth > 0);
    }, null, { timeout: 5_000 });
    expect(posterRequests).toBe(1);
    expect(mediaRequests).toBe(0);

    await page.goto(`${server.url}?protectedCoverFail&count=1`);
    await page.waitForFunction(() => {
        const img = document.querySelector('img[alt="video-0-0"]') as HTMLImageElement | null;
        return Boolean(img && img.src.startsWith("blob:") && img.naturalWidth > 0);
    }, null, { timeout: 10_000 });
    expect(mediaRequests).toBe(1);
    expect(await page.locator("video").count()).toBe(0);
}, 15_000);

test("library video card preserves hover scale transition and Generation History drawer plays and cleans up video", async () => {
    await page.goto(`${server.url}?poster&libraryCard&count=1`);
    const frame = page.locator('[data-card="video-0-0"] .asset-media-preview-frame');
    await frame.waitFor();
    const transitionProperty = await frame.evaluate(el => getComputedStyle(el).transitionProperty);
    expect(transitionProperty).toContain("transform");

    await page.goto(`${server.url}?drawer`);
    const card = page.getByRole("button", { name: "查看生成结果：历史视频成片" });
    await card.waitFor();
    expect(await page.locator("video").count()).toBe(0);
    await card.click();
    await page.locator(".assets-generation-preview-drawer [aria-label='视频播放控制']").waitFor({ state: "visible" });
    await page.waitForFunction(() => (document.querySelector(".assets-generation-preview-drawer video")?.readyState || 0) >= 2, null, { timeout: 5_000 });
    await page.locator(".assets-generation-preview-drawer .ant-drawer-close").click();
    await page.waitForFunction(() => document.querySelectorAll("video").length === 0, null, { timeout: 5_000 });
}, 15_000);

test("mounted card that times out joining a slow in-flight canvas preview recovers automatically without remount or extra downloads", async () => {
    stallFirst = true;
    const stalled = new Promise<void>(resolve => { notifyStall = resolve; });
    // Prestart the shared canvas preview AND mount card video-0-0 immediately with a 200ms join timeout.
    await page.goto(`${server.url}?count=1&prestartCanvasPreview&posterTimeoutMs=200`);
    await stalled;
    await page.locator('[data-card="video-0-0"]').waitFor();

    // Direct join respects the timeout without aborting the shared canvas preview.
    const startedAt = Date.now();
    const joinResult = await page.evaluate(() =>
        (window as Window & { __previewJoin?: { joinTimedPoster: (id: string, timeoutMs: number) => Promise<{ ok: boolean; errorName?: string }> } })
            .__previewJoin!.joinTimedPoster("video-0-0", 200),
    );
    expect(joinResult).toEqual({ ok: false, errorName: "TimeoutError" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    // Let both of the mounted card's active join attempts (t=0 and 1s retry) time out and exhaust retries while still mounted.
    await page.waitForTimeout(1_600);
    expect(await page.locator('[data-card="video-0-0"] img').count()).toBe(0);
    expect(mediaRequests).toBe(1);

    // Releasing the stall lets the shared canvas preview finish; the already-mounted card must hydrate automatically via poster-ready notification without remounting or refetching.
    releaseStall?.();
    const canvasCompleted = await page.evaluate(() =>
        (window as Window & { __previewJoin?: { awaitCanvasPreview: () => Promise<boolean> } })
            .__previewJoin!.awaitCanvasPreview(),
    );
    expect(canvasCompleted).toBe(true);
    await page.waitForFunction(() => (document.querySelector('[data-card="video-0-0"] img[alt="video-0-0"]') as HTMLImageElement)?.naturalWidth > 0, null, { timeout: 3_000 });
    expect(mediaRequests).toBe(1);
    expect(await page.locator("video").count()).toBe(0);
}, 15_000);

test("canvas InactiveVideoPreview loads server poster and falls back to client capture when server poster fails", async () => {
    await page.goto(`${server.url}?canvasVideoPoster&directPoster`);
    await page.waitForFunction(() => {
        const canvasImg = document.querySelector('[data-testid="canvas-video-preview"] img') as HTMLImageElement | null;
        return Boolean(canvasImg && canvasImg.naturalWidth > 0);
    }, null, { timeout: 10_000 });
    expect(await page.locator('[data-testid="canvas-video-preview"] img').getAttribute("src")).toContain("/api/resources/video-0-0/asset/poster.jpg?variant=poster");
    expect(mediaRequests).toBe(0);
    expect(await page.locator("video").count()).toBe(0);

    // Simulate HTTP 500 from /asset/poster.jpg: InactiveVideoPreview must fall back to browser frame capture instead of showing unavailable.
    failServerPoster = true;
    mediaRequests = 0;
    posterRequests = 0;
    await page.goto(`${server.url}?canvasVideoPoster&directPoster`);
    await page.waitForFunction(() => {
        const canvasImg = document.querySelector('[data-testid="canvas-video-preview"] img') as HTMLImageElement | null;
        return Boolean(canvasImg && canvasImg.src.startsWith("blob:") && canvasImg.naturalWidth > 0);
    }, null, { timeout: 15_000 });
    expect(await page.locator('[data-testid="canvas-video-preview"]').textContent()).not.toContain("首帧暂不可用");
    expect(posterRequests).toBe(1);
    expect(mediaRequests).toBe(1);
    expect(await page.locator("video").count()).toBe(0);
}, 25_000);

afterAll(async () => { releaseStall?.(); await page?.close(); await browser?.close(); server?.stop(true); }, 15_000);
