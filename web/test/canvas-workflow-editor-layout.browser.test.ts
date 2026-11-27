import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-workflow-editor-harness.tsx"],
        target: "browser",
        format: "esm",
        define: {
            "import.meta.env.DEV": "false",
            "import.meta.env.PROD": "true",
            "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
            "process.env.NODE_ENV": '"production"',
        },
        plugins: [
            {
                name: "alias",
                setup(builder) {
                    builder.onResolve({ filter: /^@\// }, (args) => ({
                        path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir),
                    }));
                },
            },
        ],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const bundleCss = (await build.outputs.find((output) => output.path.endsWith(".css"))?.text()) || "";
    const css = (await productCss()) + "\n" + bundleCss;

    server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
            if (path === "/app.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            return new Response(
                '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
                { headers: { "Content-Type": "text/html; charset=utf-8" } },
            );
        },
    });

    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(
        (path): path is string => Boolean(path && existsSync(path)),
    );
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 1859, height: 727 } });
    await page.goto(server.url.toString(), { waitUntil: "domcontentloaded" });
    await page.getByRole("region", { name: "工作流设定" }).waitFor({ timeout: 10_000 });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
}, 30_000);

test("empty workflow editor keeps full canvas height, shrinks within 90vh with alerts, and scrolls tall node properties", async () => {
    for (const viewport of [
        { width: 1859, height: 727 },
        { width: 1440, height: 900 },
    ]) {
        await page.setViewportSize(viewport);
        const expectedHeight = Math.min(780, viewport.height * 0.76);

        const layoutBox = await page.locator(".workflow-editor-layout").boundingBox();
        const canvasBox = await page.locator(".workflow-editor-canvas").boundingBox();
        const graphBox = await page.getByRole("region", { name: "工作流节点图" }).boundingBox();
        const propertiesBox = await page.locator(".workflow-editor-properties").boundingBox();
        const libraryBox = await page.locator(".workflow-editor-library").boundingBox();
        const libraryScrollHeight = await page.locator(".workflow-editor-library").evaluate((el) => el.scrollHeight);

        expect(layoutBox).not.toBeNull();
        expect(canvasBox).not.toBeNull();
        expect(graphBox).not.toBeNull();
        expect(propertiesBox).not.toBeNull();
        expect(libraryBox).not.toBeNull();

        expect(Math.abs(layoutBox!.height - expectedHeight)).toBeLessThanOrEqual(2);
        expect(Math.abs(canvasBox!.height - expectedHeight)).toBeLessThanOrEqual(2);
        expect(Math.abs(graphBox!.height - expectedHeight)).toBeLessThanOrEqual(2);
        expect(Math.abs(propertiesBox!.height - expectedHeight)).toBeLessThanOrEqual(2);
        expect(Math.abs(libraryBox!.height - Math.min(libraryScrollHeight, canvasBox!.height - 24))).toBeLessThanOrEqual(2);
        expect(libraryBox!.y + libraryBox!.height).toBeLessThanOrEqual(canvasBox!.y + canvasBox!.height + 1);
        expect(await page.getByRole("combobox", { name: "从成功画布节点导入步骤" }).isVisible()).toBe(true);
    }

    await page.setViewportSize({ width: 1440, height: 600 });
    await page.getByRole("button", { name: "保存" }).click();
    await page.getByRole("alert").waitFor({ timeout: 5_000 });
    const surfaceWithAlert = await page.locator(".workflow-surface").boundingBox();
    const layoutWithAlert = await page.locator(".workflow-editor-layout").boundingBox();
    expect(surfaceWithAlert!.height).toBeLessThanOrEqual(600 * 0.9 + 2);
    expect(layoutWithAlert!.height).toBeLessThan(600 * 0.76 - 10);
    expect(layoutWithAlert!.height).toBeGreaterThanOrEqual(360);

    await page.setViewportSize({ width: 1859, height: 727 });
    await page.getByRole("button", { name: "添加视频生成节点" }).click();
    await page.getByRole("textbox", { name: "工作流节点名称" }).waitFor({ timeout: 5_000 });

    await page.getByRole("button", { name: "生成模型", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "选择视频模型" });
    const search = picker.getByRole("searchbox", { name: "搜索模型" });
    await search.fill("missing");
    await picker.getByText("没有匹配的模型").waitFor();
    await search.fill("视频");
    await picker.getByRole("option", { name: "默认视频模型" }).click();

    const expectedHeightAfterNode = Math.min(780, 727 * 0.76);
    const layoutAfterNode = await page.locator(".workflow-editor-layout").boundingBox();
    const propertiesAfterNode = await page.locator(".workflow-editor-properties").boundingBox();
    expect(Math.abs(layoutAfterNode!.height - expectedHeightAfterNode)).toBeLessThanOrEqual(2);
    expect(Math.abs(propertiesAfterNode!.height - expectedHeightAfterNode)).toBeLessThanOrEqual(2);

    const scrollMetrics = await page.locator(".workflow-editor-properties").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    });
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
    expect(scrollMetrics.scrollTop).toBeGreaterThan(0);

    const outputCheckbox = await page.getByRole("checkbox", { name: "作为工作流输出" }).boundingBox();
    expect(outputCheckbox).not.toBeNull();
    expect(outputCheckbox!.y + outputCheckbox!.height).toBeLessThanOrEqual(propertiesAfterNode!.y + propertiesAfterNode!.height + 1);
}, 30_000);

test("删除工作流连线时保留图中选中的节点", async () => {
    const editor = await browser.newPage();
    try {
        await editor.goto(new URL("?edge-delete", server.url).toString());
        const edge = editor.getByRole("button", { name: /^删除连线：/ });
        await edge.press("Delete", { timeout: 4000 });
        await edge.waitFor({ state: "detached" });
        expect(await editor.locator("[data-workflow-editor-node]").count()).toBe(2);
    } finally {
        await editor.close();
    }
}, 15000);

test("workflow graph pans via wheel, blank drag, middle drag, and Space drag, zooms with Ctrl+wheel, and stays still when editing the selected node", async () => {
    const editor = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
        await editor.goto(new URL("?edge-delete", server.url).toString(), { waitUntil: "domcontentloaded" });
        const region = editor.getByRole("region", { name: "工作流节点图" });
        await region.waitFor({ timeout: 10_000 });
        const viewportEl = editor.locator("[data-workflow-editor-viewport]");
        const readTransform = () =>
            viewportEl.evaluate((el) => {
                const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(el.style.transform);
                if (!match) throw new Error(`unexpected transform: ${el.style.transform}`);
                return { x: Number(match[1]), y: Number(match[2]), k: Number(match[3]) };
            });

        const initial = await readTransform();
        const regionBox = (await region.boundingBox())!;

        // 1. Trackpad two-finger scroll pans smoothly without zooming
        await region.evaluate((el) => {
            el.dispatchEvent(new WheelEvent("wheel", { deltaX: 40, deltaY: 30, deltaMode: 0, bubbles: true, cancelable: true }));
        });
        const afterWheelPan = await readTransform();
        expect(Math.abs(afterWheelPan.x - (initial.x - 40))).toBeLessThan(1);
        expect(Math.abs(afterWheelPan.y - (initial.y - 30))).toBeLessThan(1);
        expect(Math.abs(afterWheelPan.k - initial.k)).toBeLessThan(0.001);

        // 2. Ctrl + wheel zooms around cursor
        await region.evaluate((el, box) => {
            el.dispatchEvent(new WheelEvent("wheel", { deltaY: -60, deltaMode: 0, ctrlKey: true, clientX: box.x + 200, clientY: box.y + 200, bubbles: true, cancelable: true }));
        }, regionBox);
        const afterZoom = await readTransform();
        expect(afterZoom.k).toBeGreaterThan(afterWheelPan.k);

        // 3. Blank-area left drag pans smoothly
        const blankX = regionBox.x + regionBox.width - 140;
        const blankY = regionBox.y + 40;
        await editor.mouse.move(blankX, blankY);
        await editor.mouse.down({ button: "left" });
        await editor.mouse.move(blankX + 90, blankY + 60, { steps: 4 });
        await editor.mouse.up({ button: "left" });
        const afterBlankDrag = await readTransform();
        expect(Math.abs(afterBlankDrag.x - (afterZoom.x + 90))).toBeLessThan(2);
        expect(Math.abs(afterBlankDrag.y - (afterZoom.y + 60))).toBeLessThan(2);

        // 4. Middle-button drag over a node pans the canvas without moving the node
        const sourceNode = editor.locator('[data-workflow-editor-node="source"]');
        const nodePosBeforeMiddle = await sourceNode.evaluate((el) => ({ left: el.style.left, top: el.style.top }));
        const sourceBox = (await sourceNode.boundingBox())!;
        await editor.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + 20);
        await editor.mouse.down({ button: "middle" });
        await editor.mouse.move(sourceBox.x + sourceBox.width / 2 + 80, sourceBox.y + 70, { steps: 4 });
        await editor.mouse.up({ button: "middle" });
        const afterMiddleDrag = await readTransform();
        expect(Math.abs(afterMiddleDrag.x - (afterBlankDrag.x + 80))).toBeLessThan(2);
        expect(Math.abs(afterMiddleDrag.y - (afterBlankDrag.y + 50))).toBeLessThan(2);
        expect(await sourceNode.evaluate((el) => ({ left: el.style.left, top: el.style.top }))).toEqual(nodePosBeforeMiddle);

        // 5. Space + left drag over a node pans the canvas without moving the node
        const sourceBoxForSpace = (await sourceNode.boundingBox())!;
        await region.focus();
        await editor.keyboard.down("Space");
        await editor.mouse.move(sourceBoxForSpace.x + sourceBoxForSpace.width / 2, sourceBoxForSpace.y + 20);
        await editor.mouse.down({ button: "left" });
        await editor.mouse.move(sourceBoxForSpace.x + sourceBoxForSpace.width / 2 - 200, sourceBoxForSpace.y - 30, { steps: 4 });
        await editor.mouse.up({ button: "left" });
        await editor.keyboard.up("Space");
        const afterSpaceDrag = await readTransform();
        expect(Math.abs(afterSpaceDrag.x - (afterMiddleDrag.x - 200))).toBeLessThan(2);
        expect(Math.abs(afterSpaceDrag.y - (afterMiddleDrag.y - 50))).toBeLessThan(2);
        expect(await sourceNode.evaluate((el) => ({ left: el.style.left, top: el.style.top }))).toEqual(nodePosBeforeMiddle);

        // 6. Pan the selected node far offscreen, then edit its title — viewport must NOT jump back
        await region.evaluate((el) => {
            el.dispatchEvent(new WheelEvent("wheel", { deltaX: 900, deltaY: 0, deltaMode: 0, bubbles: true, cancelable: true }));
        });
        const beforeEdit = await readTransform();
        const titleInput = editor.getByRole("textbox", { name: "工作流节点名称" });
        await titleInput.fill("源视频-已修改");
        const afterEdit = await readTransform();
        expect(Math.abs(afterEdit.x - beforeEdit.x)).toBeLessThan(1);
        expect(Math.abs(afterEdit.y - beforeEdit.y)).toBeLessThan(1);
        expect(Math.abs(afterEdit.k - beforeEdit.k)).toBeLessThan(0.001);
    } finally {
        await editor.close();
    }
}, 25_000);
