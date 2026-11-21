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
        : { contentType: "text/html", body: '<style>.canvas-node-shell{height:100%}</style><div id="root"></div><script type="module">import { mountNodeTitleHarness } from "/app.js"; const options = new URLSearchParams(location.search); mountNodeTitleHarness(document.getElementById("root"), {image: options.has("image"), maskEditActive: options.has("mask"), x: options.has("x") ? Number(options.get("x")) : undefined, scale: options.has("scale") ? Number(options.get("scale")) : undefined, selected: options.has("selected"), readOnly: options.has("readOnly"), locked: options.has("locked"), error: options.has("error")});</script>' }));
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
    const longTitle = "雨夜街景的高清参考图，路灯倒映在湿润的路面上，远处建筑只剩下轮廓与窗边的暖光 - Night Street Reference 01";
    await editor.fill(longTitle);
    const expandedBox = (await editor.boundingBox())!;
    expect(expandedBox.width).toBeGreaterThan(320);
    expect(expandedBox.width).toBeGreaterThan(editorBox.width + 120);
    expect(Math.abs(expandedBox.height - editorBox.height)).toBeLessThan(2);
    expect(await editor.evaluate((element) => (element as HTMLInputElement).scrollWidth <= element.clientWidth + 2)).toBe(true);
    await editor.press("Enter");
    expect(await page.getByTestId("saved-title").innerText()).toBe(longTitle);
    expect(await page.getByTestId("commits").innerText()).toBe("1");

    await page.locator(".canvas-node-shell").dblclick();
    expect(await editor.inputValue()).toBe(longTitle);
    await editor.fill("不要保存");
    await editor.press("Escape");
    expect(await page.getByTestId("commits").innerText()).toBe("1");
    expect(await editor.count()).toBe(0);

    // Clicking the visible pencil icon on hover enters edit directly.
    await page.getByRole("button", { name: `编辑节点名称：${longTitle}`, exact: true }).hover();
    await page.locator(".canvas-node-title-edit-icon").click();
    expect(await editor.inputValue()).toBe(longTitle);
    await editor.press("Escape");
    expect(await editor.count()).toBe(0);
}, 15000);

test("image title editor clamps within the viewport right edge even with tight space and non-1 scale", async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    for (const query of ["?image&x=960", "?image&x=1200", "?image&x=2400&scale=0.5"]) {
        await page.goto(`https://beeftv-title.test/${query}`);
        await page.addStyleTag({ content: await compileAppGlobalsStyles() });
        await page.getByRole("button", { name: "编辑节点名称：原名称", exact: true }).getByText("原名称").dblclick();
        const editor = page.getByRole("textbox", { name: "节点名称", exact: true });
        await editor.fill("Very Long Title Near Right Edge - ".repeat(6));
        const editorBox = (await editor.boundingBox())!;
        expect(editorBox.x).toBeGreaterThanOrEqual(0);
        expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(1280);
        expect(editorBox.width).toBeGreaterThanOrEqual(120);
    }
}, 20000);

test("selected image exposes its pencil affordance without hovering the header", async () => {
    await page.goto("https://beeftv-title.test/?image&selected");
    await page.addStyleTag({ content: await compileAppGlobalsStyles() });
    const pencil = page.locator(".canvas-node-title-edit-icon");
    await pencil.waitFor({ state: "visible" });
    await pencil.click();
    expect(await page.getByRole("textbox", { name: "节点名称", exact: true }).inputValue()).toBe("原名称");
}, 15000);

test("error-state image bodies still rename when editable and preview when readOnly or locked", async () => {
    await page.goto("https://beeftv-title.test/?image&error");
    await page.addStyleTag({ content: await compileAppGlobalsStyles() });
    await page.locator(".canvas-node-shell").dblclick();
    expect(await page.getByRole("textbox", { name: "节点名称", exact: true }).inputValue()).toBe("原名称");

    for (const flag of ["readOnly", "locked"]) {
        await page.goto(`https://beeftv-title.test/?image&error&${flag}`);
        await page.addStyleTag({ content: await compileAppGlobalsStyles() });
        await page.locator(".canvas-node-shell").dblclick();
        expect(await page.getByRole("textbox", { name: "节点名称", exact: true }).count()).toBe(0);
        expect(await page.getByTestId("previews").innerText()).toBe("1");
    }
}, 20000);

test("header drag handle stays disabled for locked and readOnly nodes and starts drags when editable", async () => {
    await page.goto("https://beeftv-title.test/?image&locked");
    expect(await page.getByRole("button", { name: "节点已锁定", exact: true }).isDisabled()).toBe(true);

    await page.goto("https://beeftv-title.test/?image&readOnly");
    expect(await page.getByRole("button", { name: "拖动节点：原名称", exact: true }).isDisabled()).toBe(true);

    await page.goto("https://beeftv-title.test/?image");
    const dragButton = page.getByRole("button", { name: "拖动节点：原名称", exact: true });
    expect(await dragButton.isDisabled()).toBe(false);
    await dragButton.dispatchEvent("pointerdown", { button: 0, pointerId: 1 });
    expect(await page.getByTestId("drags").innerText()).toBe("1");
}, 15000);

test("local repaint keeps the image title and rename editor clear of its controls", async () => {
    await page.goto("https://beeftv-title.test/?image&mask");
    await page.locator(".canvas-node-shell").dblclick();
    expect(await page.locator(".canvas-node-external-header").count()).toBe(0);
    expect(await page.getByRole("textbox", { name: "节点名称", exact: true }).count()).toBe(0);
}, 15000);
