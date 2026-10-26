import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync } from "node:fs";

test("缩放提交保持节点几何，中键平移保持光标反馈且释放后恢复命中", async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-wheel-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"' },
        plugins: [{ name: "aliases", setup(builder) { builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) })); } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/harness.js"
        ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
        : new Response('<style>html,body,#root{margin:0;width:800px;height:600px}[data-canvas-viewport]{position:relative;width:100%;height:100%;overflow:hidden}.canvas-world-layer,.canvas-world-raster-layer{position:absolute;transform-origin:0 0}.canvas-world-raster-layer{transform:scale(var(--canvas-committed-scale))}</style><div id=root></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => path && existsSync(path));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        page.on("pageerror", (error) => console.error(error.message));
        await page.goto(server.url.toString());
        await page.locator("#node").waitFor({ timeout: 5000 });
        for (const deltaY of [-120, -80, 100, 60]) {
            const measured = await page.evaluate(async (delta) => {
                const container = document.querySelector("[data-canvas-viewport]")!;
                const initialWidth = document.querySelector("#node")!.getBoundingClientRect().width;
                container.dispatchEvent(new WheelEvent("wheel", { deltaY: delta, clientX: 350, clientY: 220, bubbles: true, cancelable: true }));
                await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                const before = document.querySelector("#node")!.getBoundingClientRect();
                (window as unknown as { commitWheelViewport(): void }).commitWheelViewport();
                const after = document.querySelector("#node")!.getBoundingClientRect();
                return { initialWidth, before: { x: before.x, y: before.y, width: before.width }, after: { x: after.x, y: after.y, width: after.width } };
            }, deltaY);
            expect(measured.after.x).toBeCloseTo(measured.before.x, 2);
            expect(measured.before.width).toBeCloseTo(measured.initialWidth * Math.pow(1.1, -deltaY / 72), 2);
            expect(measured.after.y).toBeCloseTo(measured.before.y, 2);
            expect(measured.after.width).toBeCloseTo(measured.before.width, 2);
        }
        const beforeIdle = await page.locator("#node").boundingBox();
        await page.waitForTimeout(180);
        const afterIdle = await page.locator("#node").boundingBox();
        expect(afterIdle!.x).toBeCloseTo(beforeIdle!.x, 2);
        expect(afterIdle!.width).toBeCloseTo(beforeIdle!.width, 2);

        await page.addStyleTag({ content: '[data-canvas-pan-cursor]{position:absolute;inset:0;z-index:50;cursor:grabbing}' });
        const classBeforePan = await page.locator('[data-canvas-viewport]').getAttribute('class');
        await page.mouse.move(400, 320);
        await page.mouse.down({ button: 'middle' });
        await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-canvas-pan-cursor]')!).pointerEvents === 'auto');
        expect(await page.evaluate(() => getComputedStyle(document.elementFromPoint(400, 320)!).cursor)).toBe('grabbing');
        const beforePan = await page.locator('#node').boundingBox();
        await page.mouse.move(500, 360, { steps: 8 });
        await page.mouse.up({ button: 'middle' });
        await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-canvas-pan-cursor]')!).pointerEvents === 'none');
        const afterPan = await page.locator('#node').boundingBox();
        expect(afterPan!.x - beforePan!.x).toBeCloseTo(100, 1);
        expect(afterPan!.y - beforePan!.y).toBeCloseTo(40, 1);
        expect(afterPan!.width).toBeCloseTo(beforePan!.width, 2);
        expect(await page.locator('[data-canvas-viewport]').getAttribute('class')).toBe(classBeforePan);
        expect(await page.evaluate(() => document.body.style.cursor)).toBe('');
        expect(await page.evaluate(() => document.elementFromPoint(500, 360)?.hasAttribute('data-canvas-pan-cursor'))).toBe(false);
    } finally { await browser.close(); server.stop(true); }
}, 30000);
