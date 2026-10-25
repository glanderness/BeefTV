import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let page: Page;
let script: string;
let css: string;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-appearance-harness.tsx"],
        target: "browser", format: "esm",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "alias", setup(builder) {
            builder.onLoad({ filter: /\/(model-logo\.tsx|\.css|\.svg|\.png|\.jpe?g|\.gif|\.webp|\.woff2?)$/ }, () => ({ contents: "export function ModelLogo() { return null; } export default '';", loader: "js" }));
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    script = await build.outputs[0].text();
    css = await productCss();
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 400, height: 900 } });
    page.on("pageerror", (error) => console.error(error.message));
    await page.route("https://beeftv-appearance.test/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/app.js") return route.fulfill({ contentType: "text/javascript", body: script });
        if (path === "/app.css") return route.fulfill({ contentType: "text/css", body: css });
        return route.fulfill({ contentType: "text/html", body: '<link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module">import { mountCanvasAppearanceHarness } from "/app.js"; mountCanvasAppearanceHarness(document.getElementById("root"));</script>' });
    });
    await page.goto("https://beeftv-appearance.test/", { waitUntil: "domcontentloaded" });
    await page.getByText("滚轮操作", { exact: true }).waitFor({ timeout: 5000 });
}, 120_000);

afterAll(async () => { await browser?.close(); });

test("画布外观面板里新增滚轮操作，默认自动并可切换为固定平移", async () => {
    const segmented = page.locator(".ant-segmented").last();
    await expect(segmented.getByText("自动", { exact: true }).count()).resolves.toBe(1);
    await expect(segmented.getByText("缩放", { exact: true }).count()).resolves.toBe(1);
    await segmented.getByText("平移", { exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { __wheelBehavior?: string }).__wheelBehavior)).toBe("pan");
    const width = await segmented.evaluate((element) => element.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(288);
});