import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const bundle = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-prompt-font-harness.tsx"], target: "browser", define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "source", setup(builder) {
        builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
        builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!bundle.success) throw new Error(bundle.logs.join("\n"));
    const js = await bundle.outputs.find(output => output.path.endsWith(".js"))!.text();
    // Compile the actual Tailwind utilities and product CSS, including header geometry.
    const css = await productCss();
    server = Bun.serve({ port: 0, fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (url.pathname === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (url.pathname === "/api/ops/generation.estimate") {
            const item = { amount: 0.35, label: "预计 ¥0.35", basis: "按次", text: "预计 ¥0.35" };
            return Response.json({ code: 0, data: { result: { items: [item] } } });
        }
        if (url.pathname.startsWith("/api/")) return Response.json({ code: 0, data: { items: [], providers: [], total: 0 } });
        return new Response(`<!doctype html><html class="${url.searchParams.get("theme") === "dark" ? "dark" : ""}"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body class="app-product-overlays"><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);

afterAll(async () => { await browser?.close(); server?.stop(true); }, 30000);

test("点选真实图片会保留视频提示词面板，并建立连线和引用", async () => {
    const page = await browser.newPage();
    try {
        const url = new URL("?mode=video&pick-connect", server.url);
        await page.goto(url.toString());
        const pick = page.getByRole("button", { name: "点选连线引用" });
        await pick.click();
        expect(await pick.getAttribute("aria-pressed")).toBe("true");
        await page.getByRole("img", { name: "参考图", exact: true }).locator("..").click({ delay: 100, timeout: 3000 });
        const result = JSON.parse((await page.getByTestId("pick-result").textContent())!);
        expect(result.edges).toEqual([{ id: "pick-edge", fromNodeId: "pick-image", toNodeId: "font-preview" }]);
        expect(result.prompt).toContain("@[node:pick-image]");
        expect(await pick.getAttribute("aria-pressed")).toBe("true");
        expect(await page.getByRole("textbox", { name: "视频提示词" }).innerText()).toContain("参考图");
        await page.keyboard.press("Escape");
        expect(await pick.getAttribute("aria-pressed")).toBe("false");
    } finally {
        await page.close();
    }
}, 15000);

test("点选期间可以拖动生成节点，松手后仍能引用图片", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(new URL("?mode=video&pick-connect", server.url).toString());
        const pick = page.getByRole("button", { name: "点选连线引用" });
        const result = async () => JSON.parse((await page.getByTestId("pick-result").textContent())!);
        await pick.click();
        const target = page.locator('[data-node-id="font-preview"] .canvas-node-shell');
        const bounds = (await target.boundingBox())!;
        const before = (await result()).position;
        const x = bounds.x + bounds.width / 2;
        const y = bounds.y + bounds.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 160, y + 60, { steps: 8 });
        const panelWasHidden = await page.getByTestId("node-panel").isHidden();
        await page.mouse.up();
        expect((await result()).position).toEqual({ x: before.x + 160, y: before.y + 60 });
        expect((await result()).edges).toEqual([]);
        expect(panelWasHidden).toBe(true);
        expect(await pick.getAttribute("aria-pressed")).toBe("true");

        await page.getByRole("img", { name: "参考图", exact: true }).locator("..").click({ timeout: 3000 });
        expect((await result()).edges).toEqual([{ id: "pick-edge", fromNodeId: "pick-image", toNodeId: "font-preview" }]);
        expect(await page.getByRole("textbox", { name: "视频提示词" }).innerText()).toContain("参考图");
    } finally {
        await page.close();
    }
}, 15000);

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 480 }]) {
    test(`视频设置在 ${viewport.width}px 下直接显示参数，滑块只停靠受支持的整数秒`, async () => {
        const page = await browser.newPage({ viewport });
        try {
            await page.goto(new URL("?mode=video&video-settings&theme=dark", server.url).toString());
            await page.getByRole("button", { name: /^高级设置/ }).click();
            const settings = page.locator(".canvas-image-settings-popover");
            const slider = settings.getByRole("slider", { name: "视频时长（秒）" });
            await settings.getByText("分辨率", { exact: true }).waitFor();
            for (const label of ["分辨率", "视频时长", "4 秒", "自动", "16:9"]) {
                expect(await settings.getByText(label, { exact: true }).evaluate(element => {
                    const { fontSize, fontWeight } = getComputedStyle(element);
                    return { fontSize, fontWeight };
                })).toEqual({ fontSize: "12px", fontWeight: "500" });
            }
            expect(await settings.getByText("视频设置", { exact: true }).count()).toBe(0);
            await slider.scrollIntoViewIfNeeded();
            expect(await slider.getAttribute("aria-valuetext")).toBe("4 秒");
            await slider.press("ArrowRight");
            expect(await slider.getAttribute("aria-valuetext")).toBe("7 秒");
            await slider.press("End");
            expect(await slider.getAttribute("aria-valuetext")).toBe("15 秒");
            const track = (await slider.boundingBox())!;
            await page.mouse.move(track.x + track.width - 6, track.y + track.height / 2);
            await page.mouse.down();
            await page.mouse.move(track.x + 6, track.y + track.height / 2, { steps: 6 });
            await page.mouse.up();
            expect(await slider.getAttribute("aria-valuetext")).toBe("4 秒");
            await settings.getByRole("button", { name: "自动", exact: true }).click();
            expect(await slider.getAttribute("aria-valuetext")).toBe("自动");
            await slider.click({ position: { x: 6, y: 12 } });
            expect(await slider.getAttribute("aria-valuetext")).toBe("4 秒");
            await settings.getByRole("button", { name: "自动", exact: true }).click();
            expect(await slider.getAttribute("aria-valuetext")).toBe("自动");
        } finally {
            await page.close();
        }
    }, 15000);
}

test("模态编辑器保护后台选区，隐藏后恢复画布删除", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(new URL("?mode=video&keyboard-delete&modal-delete", server.url).toString());
        const node = page.getByTestId("node-panel");
        await page.getByRole("button", { name: "打开编辑器" }).click();
        const dialog = page.getByRole("dialog");
        const draft = dialog.getByRole("textbox");
        await draft.fill("一二三");
        await draft.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(3, 3));
        await draft.press("Backspace");
        expect(await draft.inputValue()).toBe("一二");
        const close = dialog.getByRole("button", { name: "关闭编辑器" });
        await close.focus();
        await close.press("Delete");
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        for (const key of ["Delete", "Backspace"]) {
            await page.keyboard.press(key);
            expect(await node.count()).toBe(1);
        }
        await close.click();
        await dialog.waitFor({ state: "hidden" });
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        await page.keyboard.press("Delete");
        await node.waitFor({ state: "detached" });
    } finally {
        await page.close();
    }
}, 15000);

test("浮层保护已选连线，回到画布后只删除连线", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(new URL("?mode=video&keyboard-delete&modal-delete&selected-edge", server.url).toString());
        const edge = page.getByTestId("selected-edge");
        await page.getByRole("button", { name: "打开编辑器" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        await page.keyboard.press("Backspace");
        expect(await edge.count()).toBe(1);
        await dialog.getByRole("button", { name: "关闭编辑器" }).click();
        await dialog.waitFor({ state: "hidden" });
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        await page.keyboard.press("Delete");
        await edge.waitFor({ state: "detached" });
        expect(await page.getByTestId("node-panel").count()).toBe(1);
    } finally {
        await page.close();
    }
}, 15000);

test("视频设置打开时，选中文字或调整滑块都不会触发画布删除", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
        await page.goto(new URL("?mode=video&video-settings&keyboard-delete", server.url).toString());
        const node = page.getByTestId("node-panel");
        const trigger = node.getByRole("button", { name: /^高级设置/ });
        await trigger.click();
        const settings = page.locator(".canvas-image-settings-popover");
        await settings.getByText("尺寸", { exact: true }).evaluate((label) => {
            const range = document.createRange();
            range.selectNodeContents(label);
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(range);
            (document.activeElement as HTMLElement | null)?.blur();
        });
        await page.keyboard.press("Backspace");
        expect(await node.count()).toBe(1);

        await page.evaluate(() => window.getSelection()?.removeAllRanges());
        await page.keyboard.press("Delete");
        expect(await node.count()).toBe(1);
        const slider = settings.getByRole("slider", { name: "视频时长（秒）" });
        await slider.press("ArrowRight");
        expect(await slider.getAttribute("aria-valuetext")).toBe("7 秒");
        await slider.press("Backspace");
        await slider.press("Delete");
        expect(await node.count()).toBe(1);

        await page.keyboard.down("Backspace");
        await trigger.click();
        await settings.waitFor({ state: "detached" });
        await trigger.evaluate((button: HTMLElement) => button.blur());
        await page.keyboard.down("Backspace");
        expect(await node.count()).toBe(1);
        await page.keyboard.up("Backspace");
        await page.keyboard.press("Backspace");
        await node.waitFor({ state: "detached" });
    } finally {
        await page.close();
    }
}, 15000);

for (const mode of ["image", "audio"]) {
    test(`${mode} 参数打开时，焦点落到页面正文也不会删除节点`, async () => {
        const page = await browser.newPage();
        try {
            await page.goto(new URL(`?mode=${mode}&keyboard-delete`, server.url).toString());
            const node = page.getByTestId("node-panel");
            const trigger = node.getByRole("button", { name: /^高级设置/ });
            await trigger.click();
            await page.locator(".canvas-image-settings-popover").waitFor();
            await trigger.evaluate((button: HTMLElement) => button.blur());
            await page.keyboard.press("Backspace");
            await page.keyboard.press("Delete");
            expect(await node.count()).toBe(1);
        } finally {
            await page.close();
        }
    }, 10000);
}

test("没有保存字号时，从放大编辑器首次调整也与节点保持一致", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(server.url.toString());
        const panel = page.getByTestId("node-panel");
        const compact = panel.getByRole("textbox", { name: "图片提示词" });
        await compact.waitFor();
        const before = await compact.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
        await panel.getByRole("button", { name: "放大编辑提示词" }).click();
        const dialog = page.getByRole("dialog");
        const expanded = dialog.getByRole("textbox", { name: "图片提示词" });
        expect(await expanded.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(before);
        await dialog.getByRole("button", { name: "放大提示词字号" }).click();
        expect(await expanded.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(before + 2);
        expect(await compact.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(before + 2);
    } finally { await context.close(); }
}, 30000);

for (const dark of [false, true]) {
    for (const width of [1440, 390]) {
        test(`提示词字号跨面板同步并在刷新后保留：${dark ? "深色" : "浅色"} / ${width}`, async () => {
            const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 2 });
            const errors: string[] = [];
            page.on("pageerror", error => errors.push(error.message));
            await page.route("**/*", route => new URL(route.request().url()).origin === server.url.origin ? route.continue() : route.abort());
            try {
                await page.goto(server.url.toString() + (dark ? "?theme=dark" : ""));
                const panel = page.getByTestId("node-panel");
                const editor = panel.getByRole("textbox", { name: "图片提示词" });
                await editor.waitFor();
                const prompt = await page.getByTestId("prompt-value").textContent();
                for (let i = 0; i < 6; i++) await panel.getByRole("button", { name: "放大提示词字号" }).click();
                expect(await editor.evaluate(element => getComputedStyle(element).fontSize)).toBe("24px");
                expect(await page.getByTestId("config-composer").locator("[contenteditable]").evaluate(element => getComputedStyle(element).fontSize)).toBe("24px");
                expect(await page.getByTestId("prompt-value").textContent()).toBe(prompt);
                await panel.getByRole("button", { name: "放大编辑提示词" }).click();
                const dialog = page.getByRole("dialog");
                const expanded = dialog.getByRole("textbox", { name: "图片提示词" });
                await expanded.waitFor();
                expect(await expanded.evaluate(element => getComputedStyle(element).fontSize)).toBe("24px");
                await page.keyboard.press("Escape");
                await dialog.waitFor({ state: "hidden" });
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
                if (process.env.BEEFTV_FONT_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.BEEFTV_FONT_SCREENSHOT_DIR}/prompt-font-${dark ? "dark" : "light"}-${width}.png` });
                await page.reload();
                await panel.getByRole("button", { name: "放大提示词字号" }).waitFor();
                expect(await editor.evaluate(element => getComputedStyle(element).fontSize)).toBe("24px");
                for (let i = 0; i < 2; i++) await panel.getByRole("button", { name: "放大提示词字号" }).click();
                expect(await panel.getByRole("button", { name: "放大提示词字号" }).isDisabled()).toBe(true);
                for (let i = 0; i < 8; i++) await panel.getByRole("button", { name: "缩小提示词字号" }).click();
                expect(await panel.getByRole("button", { name: "缩小提示词字号" }).isDisabled()).toBe(true);
                expect(await editor.evaluate(element => getComputedStyle(element).fontSize)).toBe("12px");
                expect(errors).toEqual([]);
            } finally { await page.close(); }
        }, 30000);
    }
}

for (const mode of ["image", "video", "audio", "text"] as const) {
    test(`生成框各区默认字号一致：${mode}`, async () => {
        const page = await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 2 });
        try {
            await page.goto(new URL(`?theme=dark&mode=${mode}`, server.url).href);
            const panel = page.getByTestId("node-panel").locator(".canvas-node-composer-type");
            const editor = panel.getByRole("textbox");
            const model = panel.getByRole("button", { name: { image: "gpt-image-2", video: "Seedance 2.0 Fast", audio: "tts-1", text: "gpt-4o" }[mode] });
            const controls = [
                panel.getByRole("button", { name: "预设", exact: true }),
                panel.getByText("点选连线", { exact: true }),
                panel.locator('output[aria-label="当前提示词字号"]'),
                model.locator(".truncate"),
                mode === "text" ? panel.getByRole("spinbutton", { name: "文本生成份数" }) : panel.getByRole("button", { name: /^高级设置/ }),
                ...(mode === "text" ? [] : [panel.getByTestId("generation-cost-badge").locator("span")]),
            ];
            for (const control of [editor, ...controls]) {
                await control.waitFor({ timeout: 4000 });
                expect(await control.evaluate(element => {
                    const { fontSize, lineHeight } = getComputedStyle(element);
                    return { fontSize, lineHeight };
                }), await control.textContent() ?? "").toEqual({ fontSize: "12px", lineHeight: "18px" });
            }
            if (mode === "image") {
                const summary = panel.getByRole("button", { name: "高级设置：1:1 · 1K · 低 · 1 张" }).locator(".truncate");
                expect(await summary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
            }
            if (process.env.BEEFTV_COMPOSER_PREVIEW_DIR && (mode === "image" || mode === "video")) {
                await panel.screenshot({ path: `${process.env.BEEFTV_COMPOSER_PREVIEW_DIR}/BeefTV-${mode}-composer-12px.png` });
            }
            await panel.getByRole("button", { name: "放大提示词字号" }).click();
            expect(await editor.evaluate(element => getComputedStyle(element).fontSize)).toBe("14px");
            expect(await controls[0].evaluate(element => getComputedStyle(element).fontSize)).toBe("12px");
            await page.setViewportSize({ width: 390, height: 720 });
            expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        } finally {
            await page.close();
        }
    }, 10000);
}

test("节点模型栏随选中名称伸缩，长名保留完整提示", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 2 });
    const shortName = "gpt-image-2";
    const mediumName = "gpt-image-2.5-flare";
    const longName = "gpt-image-2-high-resolution-editorial-retouch-preview";
    try {
        await page.goto(new URL("?theme=dark&mode=image", server.url).href);
        const panel = page.getByTestId("node-panel").locator(".canvas-node-composer-type");
        const modelButton = (name: string) => panel.getByRole("button", { name, exact: true });
        const measureWidth = (name: string) => modelButton(name).evaluate(element => element.getBoundingClientRect().width);
        const isClipped = (name: string) => modelButton(name).locator(".truncate").evaluate(element => element.scrollWidth > element.clientWidth);
        const selectModel = async (from: string, to: string) => {
            await modelButton(from).click();
            const list = page.getByRole("listbox");
            await list.getByRole("option", { name: to, exact: true }).click();
        };

        const shortWidth = await measureWidth(shortName);
        expect(shortWidth).toBeLessThan(135);
        expect(await isClipped(shortName)).toBe(false);
        if (process.env.BEEFTV_MODEL_WIDTH_PREVIEW_DIR) {
            await panel.getByTestId("generation-cost-badge").waitFor();
            await panel.screenshot({ path: `${process.env.BEEFTV_MODEL_WIDTH_PREVIEW_DIR}/BeefTV-短模型名.png` });
        }

        await selectModel(shortName, mediumName);
        const mediumWidth = await measureWidth(mediumName);
        expect(mediumWidth).toBeGreaterThan(shortWidth);
        expect(mediumWidth).toBeLessThan(200);
        expect(await isClipped(mediumName)).toBe(false);

        await selectModel(mediumName, longName);
        expect(await measureWidth(longName)).toBe(200);
        expect(await isClipped(longName)).toBe(true);
        expect(await modelButton(longName).getAttribute("title")).toContain(longName);
        if (process.env.BEEFTV_MODEL_WIDTH_PREVIEW_DIR) {
            await panel.getByTestId("generation-cost-badge").waitFor();
            await page.mouse.move(5, 5);
            await panel.screenshot({ path: `${process.env.BEEFTV_MODEL_WIDTH_PREVIEW_DIR}/BeefTV-长模型名.png` });
        }

        await panel.getByRole("button", { name: "放大编辑提示词" }).click();
        const expanded = page.locator(".canvas-prompt-editor-modal[role=dialog]");
        expect(await expanded.getByRole("button", { name: longName, exact: true }).evaluate(element => element.getBoundingClientRect().width)).toBe(200);
        await page.keyboard.press("Escape");
        await expanded.waitFor({ state: "hidden" });
        await page.setViewportSize({ width: 390, height: 720 });
        expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await panel.getByRole("button", { name: "生成", exact: true }).isVisible()).toBe(true);
        await selectModel(longName, shortName);
        expect(await measureWidth(shortName)).toBe(shortWidth);

        await page.setViewportSize({ width: 1000, height: 720 });
        await page.goto(new URL("?theme=dark&mode=video", server.url).href);
        const longVideoName = "wan3.0-video-high-resolution-cinematic-preview";
        expect(await isClipped("Seedance 2.0 Fast")).toBe(false);
        await modelButton("Seedance 2.0 Fast").click();
        await page.getByRole("option", { name: longVideoName, exact: true }).click();
        expect(await measureWidth(longVideoName)).toBe(200);
        expect(await panel.getByRole("button", { name: "视频参考单价" }).count()).toBe(0);
        await panel.getByTestId("generation-cost-badge").waitFor();
        expect(await panel.getByTestId("generation-cost-badge").textContent()).toBe("预计 ¥0.35");
    } finally {
        await page.close();
    }
}, 15000);

for (const theme of ["dark", "light"]) {
    test(`生成框底栏融入提示词背景并保留交互反馈：${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 2 });
        try {
            await page.goto(new URL(`?theme=${theme}&mode=video`, server.url).href);
            const panel = page.getByTestId("node-panel").locator(".canvas-node-composer-type");
            const footer = panel.locator(".canvas-node-composer-footer");
            const model = footer.getByRole("button", { name: "Seedance 2.0 Fast", exact: true });
            const settings = footer.getByRole("button", { name: /^高级设置/ });
            const cost = footer.getByTestId("generation-cost-badge");
            const submit = footer.getByRole("button", { name: "生成", exact: true });
            const transparent = "rgba(0, 0, 0, 0)";

            for (const control of [model, settings, footer.getByRole("button", { name: "运镜" }), submit]) {
                expect(await control.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(transparent);
            }
            await cost.waitFor();
            const costGroup = submit.locator("..");
            expect(await costGroup.getByTestId("generation-cost-badge").count()).toBe(1);
            expect(await costGroup.evaluate(group => {
                const { backgroundColor, borderTopLeftRadius } = getComputedStyle(group);
                return backgroundColor !== "rgba(0, 0, 0, 0)" && parseFloat(borderTopLeftRadius) >= group.clientHeight / 2;
            })).toBe(true);
            expect(await submit.locator(".canvas-node-composer-submit-action").evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(transparent);
            if (process.env.BEEFTV_FLAT_COMPOSER_PREVIEW_DIR && theme === "dark") {
                await panel.screenshot({ path: `${process.env.BEEFTV_FLAT_COMPOSER_PREVIEW_DIR}/BeefTV-透明生成框底栏.png` });
            }

            await model.click();
            await page.getByRole("listbox").waitFor();
            expect(await model.getAttribute("aria-expanded")).toBe("true");
            await page.waitForFunction(element => getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)", await model.elementHandle(), { timeout: 2000 });
            await page.keyboard.press("Escape");
            await page.getByRole("listbox").waitFor({ state: "hidden" });
            await settings.click();
            expect(await settings.getAttribute("aria-expanded")).toBe("true");
            await page.waitForFunction(element => getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)", await settings.elementHandle(), { timeout: 2000 });
        } finally {
            await page.close();
        }
    }, 10000);
}

test("改图片张数时，估价刷新前后保持底栏与弹层的位置", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 780 } });
    try {
        await page.goto(new URL("?mode=image", server.url).href);
        const settings = page.getByRole("button", { name: /^高级设置/ });
        const cost = page.getByTestId("generation-cost-badge");
        await cost.waitFor();
        await settings.click();
        const popover = page.locator("[data-canvas-settings-popover]");
        const geometry = async () => Promise.all([settings, popover].map(el => el.boundingBox()));
        const before = await geometry();
        const pending = page.waitForRequest("**/ops/generation.estimate");
        let finish!: () => void;
        const hold = new Promise<void>(resolve => { finish = resolve; });
        await page.route("**/ops/generation.estimate", async route => {
            await hold;
            await route.fulfill({ json: { code: 0, data: { result: { items: [{ label: "预计 ¥1.055", text: "三张的估价" }] } } } });
        });
        await popover.getByRole("button", { name: "3", exact: true }).click();
        await pending;
        try {
            expect(await geometry()).toEqual(before);
            expect(await cost.locator("xpath=ancestor::*[@aria-busy='true']").count()).toBe(1);
            expect(await cost.getAttribute("aria-label")).toContain("正在更新");
            expect(await settings.getAttribute("aria-label")).toContain("3 张");
        } finally { finish(); }
        await page.getByRole("button", { name: "价格预估：三张的估价" }).waitFor();
        expect(await geometry()).toEqual(before);
        await popover.getByRole("button", { name: "16:9", exact: true }).click();
        expect(await settings.getAttribute("aria-label")).toContain("16:9");
        expect(await geometry()).toEqual(before);
        await popover.getByRole("button", { name: "高", exact: true }).click();
        expect(await settings.getAttribute("aria-label")).toContain("高");
        expect(await geometry()).toEqual(before);
    } finally { await page.close(); }
}, 15000);

test("切换到无需画质的图片模型时，参数摘要随内容收窄", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    try {
        await page.goto(new URL("?theme=dark&mode=image", server.url).href);
        const panel = page.getByTestId("node-panel").locator(".canvas-node-composer-type");
        const settings = panel.getByRole("button", { name: /^高级设置/ });
        const measure = () => settings.evaluate(button => button.getBoundingClientRect().width);
        expect(await settings.getAttribute("aria-label")).toBe("高级设置：1:1 · 1K · 低 · 1 张");
        const widthWithQuality = await measure();

        await panel.getByRole("button", { name: "gpt-image-2", exact: true }).click();
        const list = page.getByRole("listbox");
        await list.getByRole("option", { name: "dola-seedream-5-0-pro-260628", exact: true }).click();

        expect(await settings.getAttribute("aria-label")).toBe("高级设置：自适应 · 2K · 1 张");
        expect(await measure()).toBeLessThan(widthWithQuality);
        expect(await settings.locator(".truncate").evaluate(label => label.scrollWidth <= label.clientWidth)).toBe(true);
        await settings.click();
        expect(await settings.getAttribute("aria-expanded")).toBe("true");
        const popover = page.locator("[data-canvas-settings-popover]");
        await popover.getByText("生成张数", { exact: true }).waitFor();
        await popover.getByRole("button", { name: "3", exact: true }).click();
        expect(await settings.getAttribute("aria-label")).toContain("3 张");
        await popover.getByRole("button", { name: "1", exact: true }).click();
        await popover.getByRole("button", { name: "1K", exact: true }).click();
        await popover.getByRole("button", { name: "3:2", exact: true }).click();
        expect(await settings.getAttribute("aria-label")).toBe("高级设置：3:2 · 1K · 1 张");
        await popover.getByRole("button", { name: "1.5K", exact: true }).click();
        expect(await settings.getAttribute("aria-label")).toBe("高级设置：3:2 · 1.5K · 1 张");
        await settings.click();
        await settings.click();
        expect(await settings.getAttribute("aria-label")).toBe("高级设置：3:2 · 1.5K · 1 张");
        await popover.getByRole("switch", { name: "图层拆分" }).click();
        await popover.getByText("拆分次数", { exact: true }).waitFor();
        expect(await settings.getAttribute("aria-label")).toContain("1 次");
    } finally {
        await page.close();
    }
}, 10000);

test("常规与放大生成框都把规格放在摄像机和生成按钮之间", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    try {
        await page.goto(new URL("?theme=dark&mode=image", server.url).href);
        const panel = page.getByTestId("node-panel");
        const verifyOrder = async (container: typeof panel) => {
            const footer = container.locator(".canvas-node-composer-footer");
            await footer.getByTestId("generation-cost-badge").waitFor();
            const controls = [
                footer.getByRole("button", { name: "gpt-image-2", exact: true }),
                footer.getByRole("button", { name: "预设", exact: true }),
                footer.getByRole("button", { name: "智能引用", exact: true }),
                footer.getByRole("button", { name: "摄像机", exact: true }),
                footer.getByRole("button", { name: /^高级设置/ }),
                footer.getByRole("button", { name: "生成", exact: true }),
            ];
            const bounds = await Promise.all(controls.map(control => control.boundingBox()));
            expect(bounds.every(Boolean)).toBe(true);
            for (const [index, box] of bounds.slice(0, -1).entries()) {
                expect(box!.x + box!.width).toBeLessThanOrEqual(bounds[index + 1]!.x);
            }
            expect(Math.max(...bounds.map(box => box!.y)) - Math.min(...bounds.map(box => box!.y))).toBeLessThan(5);
        };

        await verifyOrder(panel);
        await panel.getByRole("button", { name: "放大编辑提示词" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        await verifyOrder(dialog);

        const editor = dialog.getByRole("textbox", { name: "图片提示词" });
        await editor.fill("/");
        await page.getByPlaceholder("搜索预设或已加入技能").waitFor();
        await page.locator(".canvas-preset-picker-option").first().click();
        expect((await page.getByTestId("prompt-value").textContent())?.trim()).not.toBe("/");
        await page.getByPlaceholder("搜索预设或已加入技能").waitFor({ state: "hidden" });
    } finally {
        await page.close();
    }
}, 15000);

test("底栏工具快速显示名称，打开菜单或弹窗时收起提示", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    try {
        await page.goto(new URL("?theme=dark&mode=image", server.url).href);
        const footer = page.getByTestId("node-panel").locator(".canvas-node-composer-footer");
        const preset = footer.getByRole("button", { name: "预设", exact: true });
        const reference = footer.getByRole("button", { name: "智能引用", exact: true });
        expect((await preset.textContent())?.trim()).toBe("");
        expect((await reference.textContent())?.trim()).toBe("");

        await footer.getByTestId("generation-cost-badge").waitFor();
        const presetTooltip = page.getByRole("tooltip").filter({ hasText: /^预设$/ });
        await preset.hover();
        await presetTooltip.waitFor({ timeout: 600 });
        await preset.click();
        await page.getByPlaceholder("搜索预设或已加入技能").waitFor();
        await presetTooltip.waitFor({ state: "hidden" });
        await preset.click();

        const referenceTooltip = page.getByRole("tooltip").filter({ hasText: /^智能引用$/ });
        await reference.hover();
        await referenceTooltip.waitFor({ timeout: 600 });
        await reference.click();
        await page.getByRole("switch", { name: "关闭 AutoLink" }).waitFor();
        await referenceTooltip.waitFor({ state: "hidden" });

        await reference.click();
        await page.getByRole("switch", { name: "关闭 AutoLink" }).waitFor({ state: "hidden" });
        const camera = footer.getByRole("button", { name: "摄像机", exact: true });
        const cameraTooltip = page.getByRole("tooltip").filter({ hasText: /^摄像机控制$/ });
        await camera.hover();
        await cameraTooltip.waitFor({ timeout: 600 });
        await camera.click();
        await page.getByRole("button", { name: "关闭摄像机控制" }).waitFor();
        await cameraTooltip.waitFor({ state: "hidden" });
    } finally {
        await page.close();
    }
}, 10000);

for (const [mode, label] of Object.entries({ image: "图片", video: "视频", audio: "音频", text: "文本" })) {
    test(`${label}生成节点打开即显示当前供应商的模型`, async () => {
        const page = await browser.newPage();
        try {
            await page.goto(new URL(`?theme=dark&mode=${mode}`, server.url).href);
            await page.getByTestId("node-panel").locator(".canvas-node-composer-model button").first().click();
            const menu = page.getByRole("dialog", { name: `选择${label}模型` });
            const selected = menu.getByRole("option", { selected: true });
            await selected.waitFor();
            await menu.getByRole("button", { name: /默认供应商/ }).click();
            const supplier = menu.getByRole("menuitemradio", { name: "Fixture", checked: true });
            await supplier.waitFor();
            for (const item of [menu.getByText("默认供应商", { exact: true }), selected, supplier]) {
                expect(await item.evaluate(element => {
                    const { fontSize, fontWeight } = getComputedStyle(element);
                    return { fontSize, fontWeight };
                })).toEqual({ fontSize: "12px", fontWeight: "500" });
            }
        } finally { await page.close(); }
    });
}
