import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "vite";

const ffmpegProbe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
const hasFfmpeg = !ffmpegProbe.error && ffmpegProbe.status === 0;

async function startVideoHarnessEnv(durationSeconds = 0.4) {
    const dir = mkdtempSync(join(tmpdir(), "beeftv-video-recovery-"));
    const file = join(dir, "preview.mp4");
    const result = spawnSync("ffmpeg", [
        "-nostdin", "-v", "error", "-y",
        "-f", "lavfi", "-i", `color=c=red:s=64x48:r=5:d=${durationSeconds}`,
        "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSeconds}`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", file,
    ]);
    if (result.error) throw new Error(`ffmpeg unavailable: ${result.error.message}`);
    if (result.status !== 0) throw new Error(result.stderr?.toString() || `ffmpeg exited with status ${result.status}`);
    const audioOnlyFallbackFile = join(dir, "mp4v-aac.mp4");
    const audioOnlyResult = spawnSync("ffmpeg", [
        "-nostdin", "-v", "error", "-y",
        "-f", "lavfi", "-i", `color=c=blue:s=64x48:r=5:d=${durationSeconds}`,
        "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSeconds}`,
        "-c:v", "mpeg4", "-c:a", "aac", "-movflags", "+faststart", audioOnlyFallbackFile,
    ]);
    if (audioOnlyResult.error) throw new Error(`ffmpeg unavailable: ${audioOnlyResult.error.message}`);
    if (audioOnlyResult.status !== 0) throw new Error(audioOnlyResult.stderr?.toString() || `ffmpeg exited with status ${audioOnlyResult.status}`);
    const dist = join(dir, "dist");
    await build({ configFile: false, root: join(import.meta.dir, ".."), publicDir: false, logLevel: "error",
        define: { __APP_VERSION__: '"test"', __APP_CHANGELOG__: '""', __BEEFTV_HEAVY_MEDIA_ENABLED__: "false", "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"false"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"' },
        resolve: { alias: { "@": join(import.meta.dir, "../src") } },
        build: { outDir: dist, emptyOutDir: true, rolldownOptions: { input: join(import.meta.dir, "fixtures/canvas-video-recovery-harness.html") } },
    });
    const state = { mode: "direct", prepares: 0, status: "ready", prepareDelayMs: 0 };
    const server = Bun.serve({ port: 0, async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/tasks/video-task") {
            return Response.json({ code: 0, data: { id: "video-task", type: "timeline_render", status: "succeeded", prompt: "", attempts: 1, createdAt: "fixture", updatedAt: "fixture", resultJson: JSON.stringify({ resourceId: "video" }) } });
        }
        if (url.pathname === "/api/resources/video/playback") {
            if (state.prepareDelayMs > 0) await Bun.sleep(state.prepareDelayMs);
            state.prepares++;
            state.status = state.mode === "retry" && state.prepares === 1 ? "failed" : "ready";
        }
        if (url.pathname === "/api/resources/video" || url.pathname.endsWith("/playback")) return Response.json({ code: 0, data: { resource: { id: "video", provider: "local", kind: "video", playbackStatus: state.status } } });
        if (url.pathname === "/api/resources/video/file") {
            const compatible = url.searchParams.get("variant") === "playback" && state.status === "ready" && (state.mode !== "missing" || state.prepares > 0);
            if (state.mode === "audio-only-video-unplayable") {
                return new Response(Bun.file(audioOnlyFallbackFile), { headers: { "Content-Type": "video/mp4", ETag: compatible ? '"video:pb"' : '"video"' } });
            }
            if (state.mode === "audio-only-video") {
                return new Response(Bun.file(compatible ? file : audioOnlyFallbackFile), { headers: { "Content-Type": "video/mp4", ETag: compatible ? '"video:pb"' : '"video"' } });
            }
            return new Response(state.mode === "direct" || compatible ? Bun.file(file) : "un-decodable original", { headers: { "Content-Type": "video/mp4", ETag: compatible ? '"video:pb"' : '"video"' } });
        }
        if (url.pathname.startsWith("/api/")) return Response.json({ code: 0, data: {} });
        const asset = url.pathname === "/" ? join(dist, "test/fixtures/canvas-video-recovery-harness.html") : join(dist, url.pathname);
        return existsSync(asset) ? new Response(Bun.file(asset)) : new Response("Not found", { status: 404 });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
    const browser = await chromium.launch({ executablePath, headless: true, args: ["--disable-gpu"] });
    return {
        state,
        server,
        browser,
        cleanup: async () => {
            await browser.close();
            server.stop(true);
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

test.skipIf(!hasFfmpeg)("画布原生视频播放器在缩放期间挂起解码、平移不中断播放、暂停态底部字幕不与控件栏重叠", async () => {
    const env = await startVideoHarnessEnv(3);
    try {
        const context = await env.browser.newContext();
        await context.addInitScript(() => {
            const win = window as Window & { __videoPlayCalls?: number };
            win.__videoPlayCalls = 0;
            const originalPlay = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = function (...args) {
                win.__videoPlayCalls = (win.__videoPlayCalls ?? 0) + 1;
                return originalPlay.apply(this, args);
            };
        });
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => { pageErrors.push(error.message); console.error(error.stack); });

        // 1. 挂载时若处于缩放中（zooming=1），不发起 play()；缩放结束后自动触发 1 次 play() 并进入播放。
        await page.goto(`${env.server.url}?surface=canvas&zooming=1&interacting=1&subtitles=1`);
        await page.waitForFunction(() => {
            const video = document.querySelector("video");
            return Boolean(video && video.readyState >= 2 && video.videoWidth === 64);
        }, undefined, { timeout: 7000 });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(await page.locator('[data-canvas-video-surface="native"]').count()).toBe(1);
        expect(await page.locator('[class*="vds-"]').count()).toBe(0);
        expect(await page.evaluate(() => ({
            paused: document.querySelector("video")?.paused,
            playCalls: (window as Window & { __videoPlayCalls?: number }).__videoPlayCalls ?? 0,
        }))).toEqual({ paused: true, playCalls: 0 });

        await page.evaluate(() => {
            const viewport = document.querySelector("[data-canvas-viewport]");
            viewport?.removeAttribute("data-canvas-viewport-zooming");
            viewport?.removeAttribute("data-canvas-viewport-interacting");
        });
        await page.waitForFunction(() => {
            const video = document.querySelector("video");
            return Boolean(video && !video.paused);
        }, undefined, { timeout: 7000 });
        expect(await page.evaluate(() => (window as Window & { __videoPlayCalls?: number }).__videoPlayCalls ?? 0)).toBe(1);

        // 2. 纯平移（仅 canvasViewportInteracting=true）不暂停视频解码。
        await page.evaluate(() => new Promise<void>((resolve) => {
            const viewport = document.querySelector<HTMLElement>("[data-canvas-viewport]");
            if (viewport) viewport.dataset.canvasViewportInteracting = "true";
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        expect(await page.evaluate(() => document.querySelector("video")?.paused)).toBe(false);

        // 3. 缩放手势（canvasViewportZooming=true）立即暂停解码，缩放结束自动恢复。
        await page.evaluate(() => new Promise<void>((resolve) => {
            const viewport = document.querySelector<HTMLElement>("[data-canvas-viewport]");
            if (viewport) viewport.dataset.canvasViewportZooming = "true";
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        expect(await page.evaluate(() => document.querySelector("video")?.paused)).toBe(true);
        await page.evaluate(() => {
            const viewport = document.querySelector("[data-canvas-viewport]");
            viewport?.removeAttribute("data-canvas-viewport-zooming");
            viewport?.removeAttribute("data-canvas-viewport-interacting");
        });
        await page.waitForFunction(() => Boolean(document.querySelector("video") && !document.querySelector("video")!.paused), undefined, { timeout: 7000 });

        // 4. 用户手动暂停后：经历缩放手势不会误恢复播放，且底部字幕层级高于控件栏并在标准与放大根字号下均不与控件栏重叠。
        await page.evaluate(() => {
            document.querySelector("video")?.pause();
        });
        for (const rootFontSize of ["16px", "20px"]) {
            await page.evaluate((size) => {
                document.documentElement.style.fontSize = size;
            }, rootFontSize);
            await page.waitForFunction(() => {
                const surface = document.querySelector('[data-canvas-video-surface="native"]');
                const subtitle = document.querySelector<HTMLElement>('[data-canvas-subtitle-overlay="bottom"]');
                const controls = document.querySelector<HTMLElement>('[role="group"][aria-label*="播放控制"]');
                return surface?.getAttribute("data-controls-open") === "true"
                    && subtitle !== null
                    && controls !== null
                    && subtitle.getBoundingClientRect().bottom <= controls.getBoundingClientRect().top;
            }, undefined, { timeout: 7000 });

            const layout = await page.evaluate(() => {
                const subtitle = document.querySelector<HTMLElement>('[data-canvas-subtitle-overlay="bottom"]')!;
                const controls = document.querySelector<HTMLElement>('[role="group"][aria-label*="播放控制"]')!;
                const subtitleRect = subtitle.getBoundingClientRect();
                const controlsRect = controls.getBoundingClientRect();
                return {
                    subtitleZ: Number(getComputedStyle(subtitle).zIndex),
                    controlsZ: Number(getComputedStyle(controls).zIndex),
                    subtitleBottom: subtitleRect.bottom,
                    controlsTop: controlsRect.top,
                };
            });
            expect(layout.subtitleZ).toBeGreaterThan(layout.controlsZ);
            expect(layout.subtitleBottom).toBeLessThanOrEqual(layout.controlsTop);
        }

        const playCallsBeforeManualZoom = await page.evaluate(() => (window as Window & { __videoPlayCalls?: number }).__videoPlayCalls ?? 0);
        await page.evaluate(() => new Promise<void>((resolve) => {
            const viewport = document.querySelector<HTMLElement>("[data-canvas-viewport]");
            if (viewport) viewport.dataset.canvasViewportZooming = "true";
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        await page.evaluate(() => new Promise<void>((resolve) => {
            document.querySelector("[data-canvas-viewport]")?.removeAttribute("data-canvas-viewport-zooming");
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        expect(await page.evaluate(() => ({
            paused: document.querySelector("video")?.paused,
            playCalls: (window as Window & { __videoPlayCalls?: number }).__videoPlayCalls ?? 0,
        }))).toEqual({ paused: true, playCalls: playCallsBeforeManualZoom });
        expect(pageErrors).toEqual([]);
        await context.close();
    } finally {
        await env.cleanup();
    }
}, 60000);

const enabled = process.env.BEEFTV_BROWSER_WORKER_TEST === "1";
test.skipIf(!enabled)("所有视频入口按需准备预览，失败可重试，可播放原件不转码", async () => {
    const env = await startVideoHarnessEnv(0.4);
    try {
        for (const surface of ["canvas", "editor", "attachment", "drawer", "thumbnail"]) {
        for (const scenario of surface === "thumbnail" ? ["fallback", "missing", "direct"] : ["fallback", "missing", "retry", "direct"]) {
            env.state.mode = scenario; env.state.prepares = 0; env.state.status = env.state.mode === "missing" ? "ready" : "none";
            const context = await env.browser.newContext();
            const page = await context.newPage();
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => { pageErrors.push(error.message); console.error(error.stack); });
            await page.goto(`${env.server.url}?surface=${surface}`);
            if (env.state.mode === "retry") {
                const name = surface === "attachment" ? "重读预览" : surface === "drawer" ? /重\s*试/ : "重新加载";
                await page.getByRole("button", { name, exact: true }).waitFor({ timeout: 7000 });
                await page.getByRole("button", { name, exact: true }).click();
            }
            try {
                if (surface === "thumbnail") {
                    await page.waitForFunction(() => {
                        const img = document.querySelector("img");
                        return Boolean(img && img.complete && img.naturalWidth === 64);
                    }, undefined, { timeout: 7000 });
                    expect(await page.locator("video").count()).toBe(0);
                } else {
                    await page.waitForFunction(() => { const video = document.querySelector("video"); return video && video.readyState >= 2 && video.videoWidth === 64; }, undefined, { timeout: 7000 });
                }
            } catch (error) {
                console.error({ surface, mode: env.state.mode, prepares: env.state.prepares, status: env.state.status, state: await page.evaluate(() => {const v=document.querySelector("video");const i=document.querySelector("img");return {text:document.body.innerText,video:v?.outerHTML,img:i?.outerHTML,network:v?.networkState,error:v?.error?.code,currentSrc:v?.currentSrc};}) });
                throw error;
            }
            if (surface === "canvas") {
                expect(await page.locator('[data-canvas-video-surface="native"]').count()).toBe(1);
                expect(await page.locator('[class*="vds-"]').count()).toBe(0);
                expect(await page.evaluate(() => document.querySelector("video")?.paused)).toBe(false);
            }
            expect(env.state.prepares).toBe(env.state.mode === "direct" ? 0 : env.state.mode === "retry" ? 2 : 1);
            expect(pageErrors).toEqual([]);
            await context.close();
        }
        }
    } finally { await env.cleanup(); }
}, 120000);

test.skipIf(!hasFfmpeg)("视频轨不可解码但音轨可播时（无 error 事件、videoWidth=0），各播放入口自动切兼容 H.264 副本且兼容仍无画面时停音报错", async () => {
    const env = await startVideoHarnessEnv(0.8);
    try {
        for (const surface of ["canvas", "viewer", "creation", "workflow", "storyboard", "projectAsset", "assistantOutput", "editor", "attachment", "drawer", "thumbnail"]) {
            env.state.mode = "audio-only-video";
            env.state.prepares = 0;
            env.state.status = "none";
            env.state.prepareDelayMs = 0;
            const context = await env.browser.newContext();
            const page = await context.newPage();
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => { pageErrors.push(error.message); console.error(error.stack); });
            await page.goto(`${env.server.url}?surface=${surface}`);
            if (surface === "workflow") {
                await page.getByRole("button", { name: "点击播放镜头视频", exact: true }).click();
            } else if (surface === "assistantOutput") {
                await page.getByRole("button", { name: "播放成片", exact: true }).click();
            }
            if (surface === "thumbnail") {
                await page.waitForFunction(() => {
                    const img = document.querySelector("img");
                    return Boolean(img && img.complete && img.naturalWidth === 64);
                }, undefined, { timeout: 10000 });
            } else {
                await page.waitForFunction(() => {
                    const video = document.querySelector("video");
                    return Boolean(video && video.readyState >= 2 && video.videoWidth === 64 && video.videoHeight === 48);
                }, undefined, { timeout: 10000 });
            }
            if (surface === "canvas") {
                await page.waitForFunction(() => {
                    const wrapper = document.querySelector('[data-canvas-video-surface="native"]')?.parentElement;
                    return Boolean(wrapper && getComputedStyle(wrapper).opacity === "1");
                }, undefined, { timeout: 7000 });
            }
            expect(env.state.prepares).toBe(1);
            expect(pageErrors).toEqual([]);
            await context.close();
        }

        // 兼容回退进行中若旧 <video> 晚到额外的 loadeddata / canplay，不得误判为兼容失败锁死报错态。
        for (const surface of ["drawer", "attachment"]) {
            env.state.mode = "audio-only-video";
            env.state.prepares = 0;
            env.state.status = "none";
            env.state.prepareDelayMs = 150;
            const context = await env.browser.newContext();
            await context.addInitScript(() => {
                document.addEventListener("loadedmetadata", (event) => {
                    const target = event.target;
                    if (target instanceof HTMLVideoElement && target.videoWidth === 0) {
                        queueMicrotask(() => {
                            target.dispatchEvent(new Event("loadeddata"));
                            target.dispatchEvent(new Event("canplay"));
                        });
                        setTimeout(() => {
                            target.dispatchEvent(new Event("loadeddata"));
                            target.dispatchEvent(new Event("canplay"));
                        }, 10);
                    }
                }, true);
            });
            const page = await context.newPage();
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => { pageErrors.push(error.message); console.error(error.stack); });
            await page.goto(`${env.server.url}?surface=${surface}`);
            await page.waitForFunction(() => {
                const video = document.querySelector("video");
                return Boolean(video && video.readyState >= 2 && video.videoWidth === 64 && video.videoHeight === 48);
            }, undefined, { timeout: 10000 });
            expect(env.state.prepares).toBe(1);
            expect(pageErrors).toEqual([]);
            await context.close();
        }

        // 若兼容副本依然无有效视频轨（例如仅含音轨的伪 mp4），各入口不得无限重发转码或后台偷播声音，应停音并展示报错重试态。
        env.state.prepareDelayMs = 0;
        for (const [surface, retryLabel] of [
            ["canvas", "重新加载"],
            ["viewer", "重试"],
            ["creation", "重新加载"],
            ["workflow", "重新加载"],
            ["storyboard", "重新加载"],
            ["projectAsset", "重新加载"],
            ["drawer", /重\s*试/],
            ["attachment", "重读预览"],
        ] as const) {
            env.state.mode = "audio-only-video-unplayable";
            env.state.prepares = 0;
            env.state.status = "none";
            const context = await env.browser.newContext();
            const page = await context.newPage();
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => { pageErrors.push(error.message); console.error(error.stack); });
            await page.goto(`${env.server.url}?surface=${surface}`);
            if (surface === "workflow") {
                await page.getByRole("button", { name: "点击播放镜头视频", exact: true }).click();
            }
            await page.getByRole("button", { name: retryLabel, exact: true }).waitFor({ timeout: 10000 });
            expect(env.state.prepares).toBe(1);
            expect(await page.evaluate(() => {
                const video = document.querySelector("video");
                return !video || video.paused;
            })).toBe(true);
            await page.getByRole("button", { name: retryLabel, exact: true }).click();
            await page.getByRole("button", { name: retryLabel, exact: true }).waitFor({ timeout: 10000 });
            expect(env.state.prepares).toBe(2);
            expect(pageErrors).toEqual([]);
            await context.close();
        }

        // 助手成片报错态必须隐藏失效的 VideoPlayer，避免残留点不动的播放控件。
        env.state.mode = "audio-only-video-unplayable";
        env.state.prepares = 0;
        env.state.status = "none";
        const assistantContext = await env.browser.newContext();
        const assistantPage = await assistantContext.newPage();
        const assistantErrors: string[] = [];
        assistantPage.on("pageerror", (error) => { assistantErrors.push(error.message); console.error(error.stack); });
        await assistantPage.goto(`${env.server.url}?surface=assistantOutput`);
        await assistantPage.getByRole("button", { name: "播放成片", exact: true }).click();
        await assistantPage.getByText("暂时无法播放，请重新读取成片。", { exact: true }).waitFor({ timeout: 10000 });
        expect(env.state.prepares).toBe(1);
        expect(await assistantPage.locator("video").count()).toBe(0);
        expect(assistantErrors).toEqual([]);
        await assistantContext.close();
    } finally {
        await env.cleanup();
    }
}, 240000);
