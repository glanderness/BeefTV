import { afterAll, beforeAll, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let sampleMp4: Uint8Array;
const requestedAssetFolderIds: string[] = [];

beforeAll(async () => {
    const ffmpeg = Bun.spawnSync([
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x2a6df4:s=320x180:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "frag_keyframe+empty_moov",
        "-f",
        "mp4",
        "pipe:1",
    ]);
    if (ffmpeg.exitCode !== 0 || ffmpeg.stdout.length === 0) {
        throw new Error(`ffmpeg failed: ${ffmpeg.stderr.toString()}`);
    }
    sampleMp4 = new Uint8Array(ffmpeg.stdout);

    const plugins: BunPlugin[] = [
        {
            name: "test-source-alias",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({
                    path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir),
                }));
            },
        },
    ];

    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/p1-ux-pack-harness.tsx"],
        target: "browser",
        define: {
            "import.meta.env.DEV": "false",
            "import.meta.env.PROD": "true",
            "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"false"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
            "process.env.NODE_ENV": '"production"',
        },
        plugins,
    });
    if (!build.success) {
        throw new Error(build.logs.join("\n"));
    }

    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const css = (await build.outputs.find((output) => output.path.endsWith(".css"))?.text()) || "";
    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
* { box-sizing: border-box; }
:root { --node-z-overlay: 10; --z-panel-floating: 20; --canvas-panel-width: 340px; --panel-radius: 14px; --dock-item-radius: 10px; --r-sm: 6px; --r-md: 8px; --fs-label: 12px; --fs-tiny: 11px; --fs-micro: 10px; --space-3: 12px; }
html, body, #root { margin: 0; width: 100%; height: 100%; background: #141417; color: #f5f5f7; font-family: -apple-system, sans-serif; }
.fixed { position: fixed; } .inset-0 { inset: 0; } .absolute { position: absolute; } .relative { position: relative; }
.flex { display: flex; } .inline-flex { display: inline-flex; } .grid { display: grid; } .block { display: block; } .contents { display: contents; }
.flex-col { flex-direction: column; } .flex-1 { flex: 1; } .min-h-0 { min-height: 0; } .min-w-0 { min-width: 0; } .shrink-0 { flex-shrink: 0; }
.items-center { align-items: center; } .items-start { align-items: flex-start; } .justify-between { justify-content: space-between; } .justify-center { justify-content: center; } .place-items-center { place-items: center; }
.w-full { width: 100%; } .h-full { height: 100%; } .size-full { width: 100%; height: 100%; } .size-7 { width: 28px; height: 28px; } .size-8 { width: 32px; height: 32px; } .size-9 { width: 36px; height: 36px; }
.right-4 { right: 16px; } .top-4 { top: 16px; } .right-3 { right: 12px; } .inset-x-0 { left: 0; right: 0; } .bottom-0 { bottom: 0; }
.overflow-hidden { overflow: hidden; } .rounded-full { border-radius: 9999px; } .rounded-xl { border-radius: 12px; }
.gap-1 { gap: 4px; } .gap-2 { gap: 8px; } .gap-3 { gap: 12px; } .p-3 { padding: 12px; } .px-2 { padding-inline: 8px; } .px-3 { padding-inline: 12px; } .py-2 { padding-block: 8px; } .mt-3 { margin-top: 12px; }
.asset-picker-shell { display: flex; flex-direction: column; height: 100%; }
.asset-picker-toolbar { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #2c2c32; }
.asset-picker-body { display: flex; flex: 1; min-height: 0; }
.asset-picker-categories { width: 200px; padding: 12px; border-right: 1px solid #2c2c32; display: flex; flex-direction: column; gap: 4px; }
.assets-filter-item { display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 6px 10px; border: 0; border-radius: 6px; background: transparent; color: #ddd; cursor: pointer; }
.assets-filter-item.is-active { background: #2d4fff33; color: #fff; }
.asset-picker-grid-wrap { flex: 1; padding: 12px; overflow: auto; }
.asset-picker-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
button { cursor: pointer; }
${css}
</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="/harness.js"></script>
</body>
</html>`;

    const remoteFolders = [
        { id: "folder-characters", name: "主角定妆", position: 0, createdAt: "2026-11-24T00:00:00Z", updatedAt: "2026-11-24T00:00:00Z" },
        { id: "folder-scenes", name: "夜景分镜", position: 1, createdAt: "2026-11-24T00:00:00Z", updatedAt: "2026-11-24T00:00:00Z" },
    ];
    const samplePng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+f0gAAAAASUVORK5CYII=";
    const remoteAssets = [
        { id: "r1", kind: "image", title: "SQL女主定妆图", category: "character", status: "confirmed", folderId: "folder-characters", coverUrl: samplePng, tags: [], createdAt: "2026-11-24T00:00:00Z", updatedAt: "2026-11-24T00:00:00Z", data: { dataUrl: samplePng, width: 1080, height: 1920, bytes: 1024, mimeType: "image/png" } },
        { id: "r2", kind: "image", title: "SQL男主定妆图", category: "character", status: "confirmed", folderId: "folder-characters", coverUrl: samplePng, tags: [], createdAt: "2026-11-24T00:00:00Z", updatedAt: "2026-11-24T00:00:00Z", data: { dataUrl: samplePng, width: 1080, height: 1920, bytes: 1024, mimeType: "image/png" } },
        { id: "r3", kind: "video", title: "SQL夜景天台空镜", category: "environment", status: "confirmed", folderId: "folder-scenes", coverUrl: "", tags: [], createdAt: "2026-11-24T00:00:00Z", updatedAt: "2026-11-24T00:00:00Z", data: { url: "/sample.mp4", width: 1920, height: 1080, bytes: 2048, mimeType: "video/mp4" } },
    ];

    server = Bun.serve({
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            if (url.pathname === "/sample.mp4") return new Response(sampleMp4, { headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" } });
            if (url.pathname === "/api/asset-folders") {
                return Response.json({ code: 0, data: { folders: remoteFolders } });
            }
            if (url.pathname === "/api/assets") {
                const reqFolderId = url.searchParams.get("folderId") || "";
                const reqKind = url.searchParams.get("kind") || "";
                requestedAssetFolderIds.push(reqFolderId);
                const kindScoped = reqKind ? remoteAssets.filter((item) => item.kind === reqKind) : remoteAssets;
                const matched = reqFolderId ? kindScoped.filter((item) => item.folderId === reqFolderId) : kindScoped;
                const folderCounts: Record<string, number> = {};
                for (const item of kindScoped) {
                    const key = item.folderId || "";
                    folderCounts[key] = (folderCounts[key] || 0) + 1;
                }
                return Response.json({
                    code: 0,
                    data: {
                        assets: matched,
                        kindCounts: { image: 2, video: 1 },
                        categoryCounts: { character: 2, environment: 1 },
                        folderCounts,
                        page: 1,
                        pageSize: 40,
                        total: matched.length,
                        hasMore: false,
                    },
                });
            }
            return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        },
    });

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("node video player toggles fullscreen off and exposes a dedicated top-right close button in fullscreen", async () => {
    await page.goto(`${server.url}?mode=node-player`);
    const root = page.locator('[data-canvas-video-surface="native"]');
    await root.waitFor({ state: "visible" });

    // Simulate browser fullscreen state transitions cleanly in headless Chromium.
    await page.evaluate(() => {
        let fsEl: Element | null = null;
        Object.defineProperty(document, "fullscreenElement", {
            configurable: true,
            get: () => fsEl,
        });
        document.exitFullscreen = async () => {
            fsEl = null;
            document.dispatchEvent(new Event("fullscreenchange"));
        };
        const surface = document.querySelector('[data-canvas-video-surface="native"]') as HTMLElement;
        surface.requestFullscreen = async () => {
            fsEl = surface;
            document.dispatchEvent(new Event("fullscreenchange"));
        };
    });

    // Enter fullscreen via bottom-right button (focus was on this button before entering fullscreen)
    await page.getByRole("button", { name: "全屏", exact: true }).click();
    await expect(page.getByRole("button", { name: "退出全屏", exact: true }).isVisible()).resolves.toBe(true);
    await expect(page.getByRole("button", { name: "退出全屏播放", exact: true }).isVisible()).resolves.toBe(true);
    await page.waitForFunction(() => {
        const v = document.querySelector("video");
        return Boolean(v && v.readyState >= 1);
    });

    // Pressing Space while fullscreen must toggle play/pause cleanly without arming canvas Space-pan
    // and without re-activating the fullscreen toggle button.
    expect(await page.evaluate(() => document.querySelector("video")!.paused)).toBe(true);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector("video")!.paused === false);
    await expect(page.getByRole("button", { name: "退出全屏", exact: true }).isVisible()).resolves.toBe(true);
    await expect(page.getByTestId("canvas-space-pan-count").textContent()).resolves.toBe("0");

    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector("video")!.paused === true);
    await expect(page.getByTestId("canvas-space-pan-count").textContent()).resolves.toBe("0");

    // Exit fullscreen via bottom-right toggle button
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await expect(page.getByRole("button", { name: "全屏", exact: true }).isVisible()).resolves.toBe(true);
    await expect(page.getByRole("button", { name: "退出全屏播放", exact: true }).count()).resolves.toBe(0);

    // Re-enter fullscreen and exit via top-right X button
    await page.getByRole("button", { name: "全屏", exact: true }).click();
    await page.getByRole("button", { name: "退出全屏播放", exact: true }).click();
    await expect(page.getByRole("button", { name: "全屏", exact: true }).isVisible()).resolves.toBe(true);
}, 20_000);

test("video preview viewer toggles play/pause on Space without triggering when a button or input is focused", async () => {
    await page.goto(`${server.url}?mode=viewer`);
    const dialog = page.getByTestId("canvas-video-viewer-modal");
    await dialog.waitFor({ state: "visible" });
    await page.locator("video").waitFor({ state: "attached" });
    await page.waitForFunction(() => {
        const v = document.querySelector("video");
        return Boolean(v && v.readyState >= 1);
    });

    // Focus sits on dialog container by default (not on <media-player>). Pressing Space should play.
    const initiallyPaused = await page.evaluate(() => document.querySelector("video")!.paused);
    expect(initiallyPaused).toBe(true);

    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector("video")!.paused === false);

    // Pressing Space again should pause.
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector("video")!.paused === true);

    // Focusing close/sidebar button and pressing Space should NOT play the video.
    await page.getByTestId("canvas-video-toggle-sidebar").focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.querySelector("video")!.paused)).toBe(true);
}, 20_000);

test("active task panel hides ended delivery tasks and allows cancelling running tasks", async () => {
    await page.goto(`${server.url}?mode=task-panel`);
    const panel = page.getByRole("region", { name: "当前画布生成任务" });
    await panel.getByRole("button", { name: /生成任务/ }).click();
    expect(await panel.getByText("1 项", { exact: true }).count()).toBe(1);
    expect(await panel.getByRole("listitem").count()).toBe(1);
    expect(await panel.getByText(/正在取回结果/).count()).toBe(0);
    expect(await panel.getByRole("button", { name: "停止取回", exact: true }).count()).toBe(0);

    await panel.getByRole("button", { name: "取消任务", exact: true }).click();
    await expect(page.getByTestId("cancelled-log").textContent()).resolves.toBe("task-running-1:running");
}, 20_000);

test("asset picker sidebar lists personal folders with counts and filters assets by folder", async () => {
    await page.goto(`${server.url}?mode=asset-picker`);
    const charFolderBtn = page.getByRole("button", { name: /主角定妆/ });
    const sceneFolderBtn = page.getByRole("button", { name: /夜景分镜/ });
    await charFolderBtn.waitFor({ state: "visible" });
    await sceneFolderBtn.waitFor({ state: "visible" });

    expect(await charFolderBtn.textContent()).toContain("2");
    expect(await sceneFolderBtn.textContent()).toContain("1");

    await charFolderBtn.click();
    await expect(page.getByText("女主侧面特写").isVisible()).resolves.toBe(true);
    await expect(page.getByText("赛博天台远景").count()).resolves.toBe(0);

    await sceneFolderBtn.click();
    await expect(page.getByText("赛博天台远景").isVisible()).resolves.toBe(true);
    await expect(page.getByText("女主侧面特写").count()).resolves.toBe(0);

    await page.getByRole("button", { name: /全部文件夹/ }).click();
    await expect(page.getByText("未分类参考图").isVisible()).resolves.toBe(true);

    // Local mode narrows folder counts and 全部文件夹 when category or search filters are applied.
    await page.getByRole("button", { name: /角色/ }).click();
    expect(await charFolderBtn.textContent()).toContain("2");
    expect(await sceneFolderBtn.textContent()).toContain("0");
    expect(await page.getByRole("button", { name: /全部文件夹/ }).textContent()).toContain("2");

    await page.getByLabel("搜索素材").fill("女主");
    expect(await charFolderBtn.textContent()).toContain("1");
    expect(await page.getByRole("button", { name: /全部文件夹/ }).textContent()).toContain("1");
}, 20_000);

test("remote library picker fetches personal folders and queries backend SQL by folderId", async () => {
    requestedAssetFolderIds.length = 0;
    await page.goto(`${server.url}?mode=remote-asset-picker`);

    const charFolderBtn = page.getByRole("button", { name: /主角定妆/ });
    const sceneFolderBtn = page.getByRole("button", { name: /夜景分镜/ });
    await charFolderBtn.waitFor({ state: "visible" });
    await sceneFolderBtn.waitFor({ state: "visible" });
    await page.getByText("SQL女主定妆图").waitFor({ state: "visible" });

    expect(await charFolderBtn.textContent()).toContain("2");
    expect(await sceneFolderBtn.textContent()).toContain("1");

    await sceneFolderBtn.click();
    await page.getByText("SQL夜景天台空镜").waitFor({ state: "visible" });
    await expect(page.getByText("SQL女主定妆图").count()).resolves.toBe(0);
    expect(requestedAssetFolderIds).toContain("folder-scenes");
    // Sidebar keeps whole-library SQL facet counts even while viewing a single folder.
    expect(await charFolderBtn.textContent()).toContain("2");

    // Switching media kind narrows SQL folder counts and 全部文件夹 together from the single folderCounts payload.
    await page.getByRole("button", { name: "视频", exact: true }).click();
    await page.waitForFunction(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const charBtn = btns.find((b) => b.textContent?.includes("主角定妆"));
        const allBtn = btns.find((b) => b.textContent?.includes("全部文件夹"));
        return Boolean(charBtn?.textContent?.includes("0") && allBtn?.textContent?.includes("1"));
    });
    expect(await sceneFolderBtn.textContent()).toContain("1");
}, 20_000);

test("CanvasProjectAssetModal without loaded project detail hides project-only folder insert action for personal folders", async () => {
    await page.goto(`${server.url}?mode=project-asset-fallback`);

    const charFolderBtn = page.getByRole("button", { name: /主角定妆/ });
    await charFolderBtn.waitFor({ state: "visible" });
    await charFolderBtn.click();
    await page.getByText("SQL女主定妆图").waitFor({ state: "visible" });
    await expect(page.getByRole("button", { name: "将文件夹放到画布" }).count()).resolves.toBe(0);
}, 20_000);
