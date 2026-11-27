import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/plugin-card-layout-harness.tsx"],
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
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
}, 30_000);

test("plugin card keeps 已启用 on a single horizontal line and never clips 卸载 across narrow, medium, wide, and mobile widths", async () => {
    const scenarios = [
        { label: "narrow-desktop", viewport: { width: 1280, height: 800 }, query: "?cardWidth=260" },
        { label: "medium-desktop", viewport: { width: 1280, height: 800 }, query: "?cardWidth=320" },
        { label: "wide-desktop", viewport: { width: 1280, height: 800 }, query: "?cardWidth=460" },
        { label: "mobile", viewport: { width: 375, height: 800 }, query: "" },
    ];

    for (const scenario of scenarios) {
        await page.setViewportSize(scenario.viewport);
        await page.goto(new URL(scenario.query, server.url).toString(), { waitUntil: "domcontentloaded" });
        const card = page.getByTestId("plugin-card");
        await card.waitFor({ state: "visible", timeout: 10_000 });

        const cardBox = (await card.boundingBox())!;
        const statusEl = card.locator(".plugin-enabled-label");
        const statusBox = (await statusEl.boundingBox())!;

        // 「已启用」 stays on one horizontal line instead of wrapping vertically per character
        expect(statusBox.height).toBeLessThanOrEqual(24);
        expect(statusBox.width).toBeGreaterThanOrEqual(30);
        expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);

        // Every action control fits completely inside the card with zero clipping
        for (const roleName of ["重新加载", "设置", "卸载"]) {
            const button = card.getByRole("button", { name: roleName });
            const box = (await button.boundingBox())!;
            expect(box.x).toBeGreaterThanOrEqual(cardBox.x - 1);
            expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
            expect(box.y + box.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 1);
        }

        const switchBox = (await card.getByRole("switch").boundingBox())!;
        expect(switchBox.x).toBeGreaterThanOrEqual(cardBox.x - 1);
        expect(switchBox.x + switchBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
    }
}, 30_000);
