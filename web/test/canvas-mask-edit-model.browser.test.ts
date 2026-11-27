import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-mask-edit-model-harness.tsx"],
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
                name: "stub-vite-glob",
                setup(builder) {
                    builder.onResolve({ filter: /model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
                    builder.onResolve({ filter: /^@\// }, (args) => ({
                        path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir),
                    }));
                    builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({
                        contents: "export function ModelLogo() { return null; }",
                        loader: "js",
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
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(server.url.toString(), { waitUntil: "domcontentloaded" });
    await page.locator("[data-mask-edit-model-selector]").waitFor({ state: "visible", timeout: 10_000 });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
}, 30_000);

test("mask edit surfaces model selector in the bottom bar, persists model choice across reopen/reload, and falls back when unavailable", async () => {
    const pickerButton = page.locator("[data-mask-edit-model-selector] button");
    expect(await pickerButton.textContent()).toContain("GPT Image 2");

    // Open model selector directly from the bottom bar and switch to Seedream 5.0
    await pickerButton.click();
    const option = page.getByRole("option", { name: "Seedream 5.0" });
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click();

    expect(await pickerButton.textContent()).toContain("Seedream 5.0");
    expect(await page.getByTestId("remembered-model").textContent()).toBe("ch::doubao-seedream-5-0-260128");

    // Reopen mask editor on a node defaulting to GPT Image 2 -> remembered Seedream 5.0 is preserved
    await page.getByRole("button", { name: "重新打开蒙版编辑" }).click();
    expect(await pickerButton.textContent()).toContain("Seedream 5.0");

    // Reload page completely -> localStorage preference still restores Seedream 5.0
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-mask-edit-model-selector]").waitFor({ state: "visible", timeout: 10_000 });
    expect(await pickerButton.textContent()).toContain("Seedream 5.0");

    // When the remembered model is no longer available in channels, falls back cleanly to GPT Image 2
    await page.getByRole("button", { name: "下架 Seedream 并重开" }).click();
    expect(await pickerButton.textContent()).toContain("GPT Image 2");
}, 25_000);

test("pressing Escape after clicking bottom-bar ModelPicker closes only the picker first, then cancels mask edit on second Escape", async () => {
    await page.goto(server.url.toString(), { waitUntil: "domcontentloaded" });
    await page.locator("[data-mask-edit-model-selector]").waitFor({ state: "visible", timeout: 10_000 });

    const pickerButton = page.locator("[data-mask-edit-model-selector] button");
    const settingsButton = page.getByRole("button", { name: "局部重绘设置" });
    const cancelCount = page.getByTestId("cancel-count");
    expect(await cancelCount.textContent()).toBe("0");

    // Open settings first, then click the bottom-bar ModelPicker — settings popover should close cleanly
    await settingsButton.click();
    await page.locator(".image-settings-panel").waitFor({ state: "visible", timeout: 5_000 });
    await pickerButton.click();
    await page.locator(".image-settings-panel").waitFor({ state: "hidden", timeout: 5_000 });

    const option = page.getByRole("option", { name: "GPT Image 2" });
    await option.waitFor({ state: "visible", timeout: 5_000 });

    // 1st Escape: closes only the ModelPicker menu; mask editor stays open (onCancel NOT called)
    await page.keyboard.press("Escape");
    await option.waitFor({ state: "hidden", timeout: 5_000 });
    expect(await page.locator('[data-image-mask-edit-inline="true"]').isVisible()).toBe(true);
    expect(await cancelCount.textContent()).toBe("0");

    // 2nd Escape: now invokes onCancel to exit mask editing
    await page.keyboard.press("Escape");
    expect(await cancelCount.textContent()).toBe("1");
}, 25_000);
