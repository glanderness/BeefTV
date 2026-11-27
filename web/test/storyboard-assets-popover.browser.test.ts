import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/storyboard-assets-popover-harness.tsx"],
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
    const css = (await build.outputs.find((output) => output.path.endsWith(".css"))?.text()) || "";

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
    await page.getByTestId("canvas-surface").waitFor({ timeout: 10_000 });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
}, 30_000);

test("clicking + 关联 opens the Popover, keeps it open without double-toggling, binds assets, and toggles closed cleanly", async () => {
    const trigger = page.getByRole("button", { name: "关联画布资产" }).first();
    await trigger.click();

    const heading = page.getByText("关联镜头参考资产");
    await heading.waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForTimeout(200);
    expect(await heading.isVisible()).toBe(true);
    expect(await trigger.getAttribute("aria-expanded")).toBe("true");
    expect(await page.getByTestId("canvas-clicks").textContent()).toBe("0");

    // Clicking a candidate inside the Popover binds the asset while keeping the Popover open
    await page.getByRole("button", { name: /林岚定妆照/ }).click();
    expect(await page.getByTestId("binding-count").textContent()).toBe("1");
    expect(await heading.isVisible()).toBe(true);

    // Clicking + 关联 a second time closes the Popover cleanly
    await trigger.click();
    await heading.waitFor({ state: "hidden", timeout: 5_000 });
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");
    expect(await page.getByTestId("canvas-clicks").textContent()).toBe("0");
}, 20_000);

test("clicking script node 更多操作 opens the controlled Dropdown and toggles closed cleanly", async () => {
    const moreButton = page.getByRole("button", { name: "更多操作" });
    await moreButton.click();

    const importItem = page.getByText("导入剧本文件 (.docx/.txt/.md)");
    await importItem.waitFor({ state: "visible", timeout: 5_000 });
    expect(await moreButton.getAttribute("aria-expanded")).toBe("true");

    // Second click must close the controlled Dropdown (not re-force it open)
    await moreButton.click();
    await importItem.waitFor({ state: "hidden", timeout: 5_000 });
    expect(await moreButton.getAttribute("aria-expanded")).toBe("false");
}, 20_000);
