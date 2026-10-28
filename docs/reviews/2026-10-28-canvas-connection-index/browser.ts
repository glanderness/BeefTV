import { chromium } from "playwright";
import { strict as assert } from "node:assert";
import { existsSync, writeFileSync } from "node:fs";

const build = await Bun.build({
    entrypoints: [import.meta.dir + "/hook-harness.tsx"], target: "browser", format: "esm",
    define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "review-local", setup(builder) {
        // 隔离无关的提示 UI 和插件持久化；保留真实 hook、策略和落点模块。
        builder.onLoad({ filter: /src\/stores\/use-plugin-store\.ts$/ }, () => ({ contents: "const state={runtimeStatuses:{}}; export const usePluginStore=selector=>selector(state);", loader: "js" }));
        builder.onResolve({ filter: /^antd$/ }, () => ({ path: "review-antd", namespace: "review-stub" }));
        builder.onLoad({ filter: /.*/, namespace: "review-stub" }, () => ({ contents: "const message={warning(){},success(){},error(){},info(){}}; export const App={useApp:()=>({message})};", loader: "js" }));
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }],
});
if (!build.success) throw new Error(build.logs.join("\n"));
const script = await build.outputs[0].text();
const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => p && existsSync(p));
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const results: any[] = [];
const unexpectedRequests: string[] = [];
const pageErrors: string[] = [];
page.on("pageerror", e => pageErrors.push(String(e)));
await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.hostname !== "beeftv-index-review.test") { unexpectedRequests.push(url.origin + url.pathname); return route.abort(); }
    return route.fulfill(url.pathname === "/app.js" ? { contentType: "text/javascript", body: script } : { contentType: "text/html", body: `<div id="root"></div><script type="module">import {mount} from '/app.js'; mount(${url.searchParams.get("baseline") === "true"});</script>` });
});
try {
    for (const baseline of [true, false]) for (const batch of [false, true]) for (const scale of [.6, 1, 2]) for (const distance of [55, 56, 57]) {
        await page.goto(`https://beeftv-index-review.test/?baseline=${baseline}`);
        await page.waitForFunction(() => Boolean((window as any).reviewHook));
        await page.evaluate(k => (window as any).reviewHook.viewport(k), scale);
        await page.locator(batch ? "#batch-source" : "#source").dispatchEvent("pointerdown", { pointerId: 7, clientX: 320 * scale, clientY: 90 * scale, buttons: 1 });
        const coordinates = { x: 1000 * scale - distance, y: 90 * scale };
        await page.evaluate(({ x, y }) => { window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: x, clientY: y, buttons: 1 })); }, coordinates);
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        const hover = await page.evaluate(() => (window as any).reviewHook.state());
        await page.evaluate(({ x, y }) => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, clientX: x, clientY: y })); }, coordinates);
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        const finish = await page.evaluate(() => (window as any).reviewHook.state());
        results.push({ baseline, batch, scale, distanceScreenPx: distance, hover, finish });
        if (scale === 1 && distance === 56) {
            assert.equal(finish.edges.length, baseline ? 1 : 0, JSON.stringify(results.at(-1)));
            assert.equal(finish.pending, !baseline);
        }
    }
    assert.equal(unexpectedRequests.length, 0);
    assert.equal(pageErrors.length, 0);
    writeFileSync(`${process.env.REVIEW_OUTPUT}/hook-browser.json`, JSON.stringify({ browser: browser.version(), scope: "真实前后 hook + 程序分发 PointerEvent + rAF；无画布渲染、原生鼠标或 FPS；AntD message 与插件持久化被替身隔离", results, unexpectedRequests, pageErrors }, null, 2) + "\n");
    console.log(`已复放 ${results.length} 条 hook 事件路径；100%精确边缘时，旧版连成线，候选打开创建菜单。`);
} finally {
    await browser.close();
}
