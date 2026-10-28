import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

/**
 * 落点判定的**真实控制器入口**回归：装载 `useCanvasConnectionController`，用真实的
 * `pointerdown → pointermove → rAF → pointerup` 序列驱动它，核对松手后的连线/创建菜单分支。
 *
 * 为什么需要这一层：`test/canvas-connection-target.test.ts` 里的 `finalAction` /
 * `finalBatchAction` 是测试内重写的三元表达式，只能抓几何回归；它通过不能证明真实控制器
 * 的松手动作。吸附圆精确相切处一旦漏判，这里会从「连成线」变成「打开快速创建菜单」。
 *
 * 覆盖范围：无头 Chromium + 程序分发 PointerEvent，没有画布媒体、系统鼠标或 FPS。
 */
let browser: Browser;
let page: Page;

const SOURCE_ANCHOR = { x: 320, y: 90 };
const TARGET_INPUT_ANCHOR = { x: 1000, y: 90 };
const SNAP_RADIUS = 56;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-connection-drop-harness.tsx"],
        target: "browser",
        format: "esm",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "drop-harness", setup(builder) {
            // 隔离与本用例无关的 AntD 提示和插件持久化；控制器、落点模块与连线策略都是真实实现。
            builder.onLoad({ filter: /src\/stores\/use-plugin-store\.ts$/ }, () => ({ contents: "const state={runtimeStatuses:{}}; export const usePluginStore=selector=>selector(state);", loader: "js" }));
            builder.onResolve({ filter: /^antd$/ }, () => ({ path: "drop-harness-antd", namespace: "drop-harness-stub" }));
            builder.onLoad({ filter: /.*/, namespace: "drop-harness-stub" }, () => ({ contents: "const message={warning(){},success(){},error(){},info(){}}; export const App={useApp:()=>({message})};", loader: "js" }));
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
    await page.route("https://beeftv-connection-drop.test/**", (route) => route.fulfill(new URL(route.request().url()).pathname === "/app.js"
        ? { contentType: "text/javascript", body: script }
        : { contentType: "text/html", body: '<div id="root"></div><script type="module">import { mountConnectionDropHarness } from "/app.js"; mountConnectionDropHarness(document.getElementById("root"));</script>' }));
}, 30_000);

afterAll(async () => { await browser?.close(); });

/** 从源端拖到目标左输入端外侧 `distance` 个**屏幕**像素处松手，返回悬停与松手后的控制器状态。 */
async function dragFromSource({ batch, scale, distance }: { batch: boolean; scale: number; distance: number }) {
    await page.goto("https://beeftv-connection-drop.test/");
    await page.waitForFunction(() => Boolean((window as any).connectionDrop));
    await page.evaluate((k) => (window as any).connectionDrop.viewport(k), scale);
    await page.locator(batch ? "#batch-source" : "#source").dispatchEvent("pointerdown", { pointerId: 7, clientX: SOURCE_ANCHOR.x * scale, clientY: SOURCE_ANCHOR.y * scale, buttons: 1 });
    const drop = { x: TARGET_INPUT_ANCHOR.x * scale - distance, y: TARGET_INPUT_ANCHOR.y * scale };
    await page.evaluate(({ x, y }) => { window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: x, clientY: y, buttons: 1 })); }, drop);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const hover = await page.evaluate(() => (window as any).connectionDrop.state());
    await page.evaluate(({ x, y }) => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, clientX: x, clientY: y })); }, drop);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const finish = await page.evaluate(() => (window as any).connectionDrop.state());
    return { hover, finish };
}

test("相切位置松手走真实控制器的连线分支，不误开创建菜单", async () => {
    for (const batch of [false, true]) {
        const { hover, finish } = await dragFromSource({ batch, scale: 1, distance: SNAP_RADIUS });
        expect(batch ? hover.batchTarget : hover.target).toBe("target");
        expect(finish.edges).toEqual([{ from: "source", to: "target" }]);
        expect(finish.pending).toBe(false);
    }
});

test("相切位置内侧 1 px 连线，外侧 1 px 打开创建菜单", async () => {
    for (const batch of [false, true]) {
        const inside = await dragFromSource({ batch, scale: 1, distance: SNAP_RADIUS - 1 });
        expect(inside.finish.edges).toEqual([{ from: "source", to: "target" }]);
        expect(inside.finish.pending).toBe(false);

        const outside = await dragFromSource({ batch, scale: 1, distance: SNAP_RADIUS + 1 });
        expect(outside.finish.edges).toEqual([]);
        expect(outside.finish.pending).toBe(true);
    }
});

test("缩放后相切位置仍按世界坐标判定，内外 1 px 分界一致", async () => {
    for (const scale of [0.6, 2]) {
        for (const batch of [false, true]) {
            const inside = await dragFromSource({ batch, scale, distance: SNAP_RADIUS - 1 });
            expect(inside.finish.edges).toEqual([{ from: "source", to: "target" }]);
            expect(inside.finish.pending).toBe(false);

            const outside = await dragFromSource({ batch, scale, distance: SNAP_RADIUS + 1 });
            expect(outside.finish.edges).toEqual([]);
            expect(outside.finish.pending).toBe(true);
        }
    }
});
