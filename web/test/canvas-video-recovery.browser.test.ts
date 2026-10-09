import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const enabled = process.env.BEEFTV_BROWSER_WORKER_TEST === "1";
test.skipIf(!enabled)("真实视频解码失败触发按需预览，重试恢复，可播放原件不转码", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beeftv-video-recovery-"));
    const file = join(dir, "preview.mp4");
    const result = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=5:d=0.4", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    if (result.status !== 0) throw new Error(result.stderr.toString());
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-video-recovery-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"false"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"' },
        plugins: [{ name: "assets", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    let mode = "fallback", prepares = 0, status = "none";
    const server = Bun.serve({ port: 0, fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (url.pathname === "/api/resources/video/playback") { prepares++; status = mode === "retry" && prepares === 1 ? "failed" : "ready"; }
        if (url.pathname === "/api/resources/video" || url.pathname.endsWith("/playback")) return Response.json({ code: 0, data: { resource: { id: "video", provider: "local", kind: "video", playbackStatus: status } } });
        if (url.pathname === "/api/resources/video/file") return mode === "direct" || url.searchParams.get("variant") === "playback" ? new Response(Bun.file(file), { headers: { "Content-Type": "video/mp4" } }) : new Response("un-decodable original", { headers: { "Content-Type": "video/mp4" } });
        if (url.pathname.startsWith("/api/")) return Response.json({ code: 0, data: {} });
        return new Response('<style>#root>div>div{height:100%}#root video{width:100%;height:100%}</style><div id=root></div><script type=module src=/harness.js></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        for (const scenario of ["fallback", "retry", "direct"]) {
            mode = scenario; prepares = 0; status = "none";
            const context = await browser.newContext();
            const page = await context.newPage();
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => pageErrors.push(error.message));
            await page.goto(server.url.toString());
            if (mode === "retry") {
                await page.getByRole("button", { name: "重新加载", exact: true }).waitFor({ timeout: 7000 });
                await page.getByRole("button", { name: "重新加载", exact: true }).click();
            }
            try {
                await page.waitForFunction(() => { const video = document.querySelector("video"); return video && video.readyState >= 2 && video.videoWidth === 64; }, undefined, { timeout: 7000 });
            } catch (error) {
                console.error({ mode, prepares, status, state: await page.evaluate(() => {const v=document.querySelector("video");return {text:document.body.innerText,video:v?.outerHTML,network:v?.networkState,error:v?.error?.code,currentSrc:v?.currentSrc};}) });
                throw error;
            }
            expect(prepares).toBe(mode === "direct" ? 0 : mode === "retry" ? 2 : 1);
            expect(pageErrors).toEqual([]);
            await context.close();
        }
    } finally { await browser.close(); server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 60000);
