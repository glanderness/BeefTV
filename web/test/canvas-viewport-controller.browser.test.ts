import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync } from "node:fs";

test("视口裁剪持续更新，倍率重排分段提交且手势结束保持准确几何", async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-viewport-controller-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"DEV":false,"PROD":true,"MODE":"production"}' },
        plugins: [{ name: "aliases", setup(builder) { builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) })); } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const properties = (await Bun.file(import.meta.dir + "/../src/styles/globals.css").text()).match(/@property --canvas-(?:live-|committed-)[\s\S]*?\n}/g)?.join("\n") || "";
    const server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/harness.js"
        ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
        : new Response(`<style>${properties} html,body,#root{margin:0;width:800px;height:600px}[data-canvas-viewport]{position:relative;width:100%;height:100%;overflow:hidden}.canvas-world-layer,.canvas-world-raster-layer{position:absolute;transform-origin:0 0}.canvas-world-raster-layer{transform:scale(var(--canvas-committed-scale))}</style><div id=root></div><script type="module" src="/harness.js"></script>`, { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => path && existsSync(path));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        page.on("pageerror", (error) => console.error(error.message));
        await page.goto(server.url.toString());
        await page.locator("#node").waitFor({ timeout: 5000 });
        const result = await page.evaluate(async () => {
            const probe = () => (window as unknown as { viewportProbe(): any }).viewportProbe();
            const container = document.querySelector("[data-canvas-viewport]")!;
            const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
            const wheel = (deltaX: number, deltaY: number, ctrlKey = false) => container.dispatchEvent(new WheelEvent("wheel", { deltaX, deltaY, ctrlKey, clientX: 350, clientY: 220, bubbles: true, cancelable: true }));
            await wait(80);
            const initial = probe();
            wheel(30, 15);
            await wait(80);
            const pan = probe();
            wheel(0, -3, true);
            await wait(80);
            const smallZoom = probe();
            wheel(0, -240, true);
            await wait(80);
            const rebase = probe();
            const before = document.querySelector("#node")!.getBoundingClientRect().toJSON();
            await wait(180);
            return { initial, pan, smallZoom, rebase, ended: probe(), before, after: document.querySelector("#node")!.getBoundingClientRect().toJSON() };
        });
        expect(result.pan.virtualizationViewport.x).toBe(-30);
        expect(result.pan.viewport.x).toBe(0);
        expect(result.pan.nodeRenders).toBe(result.initial.nodeRenders);
        expect(result.smallZoom.live.k).toBeGreaterThan(1);
        expect(result.smallZoom.viewport.k).toBe(1);
        expect(result.smallZoom.nodeRenders).toBe(result.initial.nodeRenders);
        expect(result.rebase.viewport.k).toBeGreaterThan(1.25);
        expect(result.ended.virtualizationViewport).toBeNull();
        expect(result.ended.viewport).toEqual(result.ended.live);
        expect(result.after.x).toBeCloseTo(result.before.x, 2);
        expect(result.after.y).toBeCloseTo(result.before.y, 2);
        expect(result.after.width).toBeCloseTo(result.before.width, 2);
        const scoped = await page.evaluate(() => (window as any).scopedScaleProbe());
        expect(scoped.first.titleWidth).toBeCloseTo(100, 2);
        expect(scoped.first.inverse.trim()).toBe("20");
        expect(scoped.first.unrelated.trim()).toBe("1");
        expect(scoped.lateInverse.trim()).toBe("20");
        expect(scoped.next.titleWidth).toBeCloseTo(100, 2);
        expect(scoped.next.inverse.trim()).toBe("10");
        expect(scoped.next.selectionInverse.trim()).toBe("10");
    } finally { await browser.close(); server.stop(true); }
}, 30000);
