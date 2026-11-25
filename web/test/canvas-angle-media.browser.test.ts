import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const virtualEntry = resolve(import.meta.dir, "fixtures/angle-media-harness.tsx");
    const build = await Bun.build({
        entrypoints: [virtualEntry],
        target: "browser",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [
            {
                name: "angle-media-test-stubs",
                setup(builder) {
                    builder.onResolve({ filter: /^@\/services\/image-storage$/ }, () => ({
                        path: resolve(import.meta.dir, "fixtures/angle-media-storage-stub.ts"),
                    }));
                    builder.onResolve({ filter: /^@\/services\/resource-blob-cache$/ }, () => ({
                        path: resolve(import.meta.dir, "fixtures/angle-media-blob-cache-stub.ts"),
                    }));
                    builder.onResolve({ filter: /^@\// }, (args) => ({
                        path: Bun.resolveSync(resolve(import.meta.dir, "../src", args.path.slice(2)), import.meta.dir),
                    }));
                },
            },
        ],
    });
    if (!build.success) throw new Error(build.logs.map((item) => item.message).join("\n"));
    const jsAsset = build.outputs.find((item) => item.path.endsWith(".js")) ?? build.outputs[0];
    const script = await jsAsset.text();
    const cssAsset = build.outputs.find((item) => item.path.endsWith(".css"));
    const css = cssAsset ? await cssAsset.text() : "";
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
            if (url.pathname === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            if (url.pathname.startsWith("/api/resources/")) {
                return new Response("Unauthorized without desktop token", { status: 401 });
            }
            if (url.pathname === "/nonexistent-broken-preview.png") {
                return new Response("Not Found", { status: 404 });
            }
            return new Response(
                `<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.js"></script>`,
                { headers: { "Content-Type": "text/html" } },
            );
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(
        (candidate): candidate is string => Boolean(candidate && existsSync(candidate)),
    );
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

const SAMPLE_PNG_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQIW2NkYGD4z8DAwMgAI0AMAA4IAgL4f6N4AAAAAElFTkSuQmCC";

test("CanvasNodeAnglePanel resolves protected desktop resource URLs and renders thumbnails in both camera and skybox modes", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 640 } });
    const unauthorizedResourceRequests: string[] = [];
    page.on("request", (req) => {
        if (req.url().includes("/api/resources/")) unauthorizedResourceRequests.push(req.url());
    });
    try {
        await page.goto(`${server.url}?dataUrl=${encodeURIComponent("/api/resources/res-desktop-574/file")}&storageKey=${encodeURIComponent("resource:res-desktop-574")}`);
        await page.locator("[data-angle-placeholder]").waitFor();

        // While resolving, raw protected /api/resources/.../file URL must never hit <img> or CSS background-image
        expect(unauthorizedResourceRequests).toEqual([]);
        expect(await page.locator(".canvas-angle-subject img").count()).toBe(0);
        const initialScreenBg = await page.locator(".canvas-angle-cam-screen").evaluate((el) => (el as HTMLElement).style.backgroundImage);
        expect(initialScreenBg).toBe("none");

        const calls = await page.evaluate(() => (window as unknown as { __angleMediaCalls: Array<{ storageKey?: string; fallback: string }> }).__angleMediaCalls);
        expect(calls).toEqual([{ storageKey: "resource:res-desktop-574", fallback: "/api/resources/res-desktop-574/file" }]);

        // Resolve authenticated media URL
        await page.evaluate((resolvedUrl) => {
            (window as unknown as { __resolveAngleMedia?: (url: string) => void }).__resolveAngleMedia?.(resolvedUrl);
        }, SAMPLE_PNG_DATA_URL);

        const cameraImg = page.locator(".canvas-angle-subject img");
        await cameraImg.waitFor();
        expect(await cameraImg.getAttribute("src")).toBe(SAMPLE_PNG_DATA_URL);
        const resolvedScreenBg = await page.locator(".canvas-angle-cam-screen").evaluate((el) => (el as HTMLElement).style.backgroundImage);
        expect(resolvedScreenBg).toContain(SAMPLE_PNG_DATA_URL);

        // Switch to skybox mode and verify front cube face renders the resolved thumbnail
        await page.getByRole("button", { name: "天空盒", exact: true }).click();
        const skyboxImg = page.locator(".canvas-angle-cube-face.is-front.has-image img");
        await skyboxImg.waitFor();
        expect(await skyboxImg.getAttribute("src")).toBe(SAMPLE_PNG_DATA_URL);
        expect(unauthorizedResourceRequests).toEqual([]);
    } finally {
        await page.close();
    }
}, 20_000);

test("CanvasNodeAnglePanel recovers via authenticated resource fallback when initial preview image fails to load", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 640 } });
    try {
        await page.addInitScript((fallbackUrl) => {
            (window as unknown as { __angleFallbackUrl?: string }).__angleFallbackUrl = fallbackUrl;
        }, SAMPLE_PNG_DATA_URL);
        await page.goto(`${server.url}?dataUrl=${encodeURIComponent("/api/resources/res-fallback-574/file")}&storageKey=${encodeURIComponent("resource:res-fallback-574")}`);
        await page.locator("[data-angle-placeholder]").waitFor();

        // Simulate a broken first image URL (e.g. failed preview or revoked blob)
        await page.evaluate(() => {
            (window as unknown as { __resolveAngleMedia?: (url: string) => void }).__resolveAngleMedia?.("/nonexistent-broken-preview.png");
        });

        const cameraImg = page.locator(".canvas-angle-subject img");
        await page.waitForFunction((expected) => {
            const img = document.querySelector(".canvas-angle-subject img") as HTMLImageElement | null;
            return Boolean(img && img.getAttribute("src") === expected && img.complete && img.naturalWidth > 0);
        }, SAMPLE_PNG_DATA_URL);
        expect(await cameraImg.getAttribute("src")).toBe(SAMPLE_PNG_DATA_URL);

        const fallbackCalls = await page.evaluate(() => (window as unknown as { __angleFallbackCalls?: Array<{ storageKey: string }> }).__angleFallbackCalls);
        expect(fallbackCalls?.length).toBe(1);
        expect(fallbackCalls?.[0]?.storageKey).toBe("resource:res-fallback-574");
    } finally {
        await page.close();
    }
}, 20_000);
