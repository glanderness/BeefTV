import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { compileAppGlobalsStyles } from "./helpers/app-styles";

let browser: Browser;
let page: Page;
let script: string;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-node-drag-harness.tsx"],
        target: "browser", format: "esm",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "alias", setup(builder) {
            builder.onLoad({ filter: /src\/components\/model-logo\.tsx$/ }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    script = await build.outputs[0].text();
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage();
    page.on("pageerror", (error) => console.error(error.message));
    await page.route("https://beeftv-title.test/**", (route) => route.fulfill(new URL(route.request().url()).pathname === "/app.js"
        ? { contentType: "text/javascript", body: script }
        : { contentType: "text/html", body: '<style>.canvas-node-shell{height:100%}</style><div id="root"></div><script type="module">import { mountNodeTitleHarness } from "/app.js"; const options = new URLSearchParams(location.search); mountNodeTitleHarness(document.getElementById("root"), {image: options.has("image"), maskEditActive: options.has("mask")});</script>' }));
}, 30_000);

afterAll(async () => { await browser?.close(); });

async function mount() {
    await page.goto("https://beeftv-title.test/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "编辑节点名称：原名称", exact: true }).click({ timeout: 2000 });
}

test("clicking canvas background commits a rename even when canvas suppresses native focus", async () => {
    await mount();
    await page.getByRole("textbox", { name: "节点名称", exact: true }).fill("雨夜街景");
    await page.getByTestId("canvas-background").click({ position: { x: 800, y: 500 } });
    expect(await page.getByTestId("saved-title").innerText()).toBe("雨夜街景");
    expect(await page.getByRole("textbox", { name: "节点名称", exact: true }).count()).toBe(0);
    expect(await page.getByTestId("commits").innerText()).toBe("1");
}, 15000);

test("Escape cancels a rename without saving on the following outside click", async () => {
    await mount();
    const input = page.getByRole("textbox", { name: "节点名称", exact: true });
    await input.fill("不要保存");
    await input.press("Escape");
    await page.getByTestId("canvas-background").click({ position: { x: 800, y: 500 } });
    expect(await page.getByTestId("saved-title").innerText()).toBe("原名称");
    expect(await page.getByTestId("commits").innerText()).toBe("0");
}, 15000);

test("image titles expand in place on double click and stay editable on one line", async () => {
    await page.goto("https://beeftv-title.test/?image");
    await page.addStyleTag({ content: await compileAppGlobalsStyles() });
    const title = page.getByRole("button", { name: "编辑节点名称：原名称", exact: true });
    const editor = page.getByRole("textbox", { name: "节点名称", exact: true });
    await title.click();
    expect(await editor.count()).toBe(0);
    const labelBox = (await title.getByText("原名称").boundingBox())!;
    await title.dblclick();
    expect(await editor.inputValue()).toBe("原名称");
    expect(await editor.evaluate((element) => element.tagName)).toBe("INPUT");
    const editorBox = (await editor.boundingBox())!;
    expect(Math.abs(editorBox.y + editorBox.height / 2 - labelBox.y - labelBox.height / 2)).toBeLessThan(2);
    expect(Math.abs(editorBox.x - labelBox.x)).toBeLessThan(4);
    const longTitle = "雨夜街景的高清参考图，路灯倒映在湿润的路面上，远处建筑只剩下轮廓与窗边的暖光";
    await editor.fill(longTitle);
    expect((await editor.boundingBox())!.width).toBeGreaterThan(320);
    await editor.press("Enter");
    expect(await page.getByTestId("saved-title").innerText()).toBe(longTitle);
    expect(await page.getByTestId("commits").innerText()).toBe("1");

    await page.locator(".canvas-node-shell").dblclick();
    expect(await editor.inputValue()).toBe(longTitle);
    await editor.fill("不要保存");
    await editor.press("Escape");
    expect(await page.getByTestId("commits").innerText()).toBe("1");
    expect(await editor.count()).toBe(0);
}, 15000);

test("local repaint keeps the image title and rename editor clear of its controls", async () => {
    await page.goto("https://beeftv-title.test/?image&mask");
    await page.locator(".canvas-node-shell").dblclick();
    expect(await page.locator(".canvas-node-external-header").count()).toBe(0);
    expect(await page.getByRole("textbox", { name: "节点名称", exact: true }).count()).toBe(0);
}, 15000);
