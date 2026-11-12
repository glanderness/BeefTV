import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let estimateDelayMs = 0;
let estimateSummaryText = "预计费用：¥1.8";

beforeAll(async () => {
    const bundle = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/generation-cost-estimate-harness.tsx"],
        target: "browser",
        define: {
            "import.meta.env.DEV": "false",
            "import.meta.env.PROD": "true",
            "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
            "process.env.NODE_ENV": '"production"',
        },
        plugins: [{
            name: "source",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            },
        }],
    });
    if (!bundle.success) throw new Error(bundle.logs.join("\n"));
    const js = await bundle.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const css = await productCss();
    server = Bun.serve({
        port: 0,
        async fetch(req) {
            const path = new URL(req.url).pathname;
            if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            if (path === "/api/ops/generation.estimate") {
                if (estimateDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, estimateDelayMs));
                return Response.json({
                    code: 0,
                    data: {
                        operation: "generation.estimate",
                        result: {
                            items: [{ amount: 1.8, basis: "1K ¥1.8/张 × 1 张", text: "预计 ¥1.8（1K ¥1.8/张 × 1 张）" }],
                            summary: { amount: 1.8, priced: 1, unknown: 0, text: estimateSummaryText },
                        },
                    },
                });
            }
            if (path.startsWith("/api/")) return Response.json({ code: 0, data: {} });
            return new Response('<!doctype html><html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body class="app-product-overlays app-user-overlays"><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
        },
    });
    browser = await chromium.launch({ headless: true });
}, 60000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("切换生成参数时立即清空旧价格并忽略已过期的慢响应，键盘聚焦可打开计价依据", async () => {
    const page = await browser.newPage();
    try {
        await page.addInitScript(() => {
            const resolvers: Array<{ seconds: string; aborted: boolean; resolve: (value: unknown) => void }> = [];
            (window as unknown as { __resolvers: typeof resolvers }).__resolvers = resolvers;
            window.__costEstimateFetcher = (targets, signal) => new Promise((resolve) => {
                const entry = { seconds: targets[0]?.parameters?.seconds || "", aborted: false, resolve: resolve as (value: unknown) => void };
                signal?.addEventListener("abort", () => { entry.aborted = true; }, { once: true });
                resolvers.push(entry);
            }) as ReturnType<typeof window.__costEstimateFetcher>;
        });
        await page.goto(server.url.href);
        await page.waitForFunction(() => (window as unknown as { __resolvers: Array<{ seconds: string }> }).__resolvers.some((item) => item.seconds === "4"));
        await page.evaluate(() => {
            const items = (window as unknown as { __resolvers: Array<{ seconds: string; aborted: boolean; resolve: (v: unknown) => void }> }).__resolvers;
            const current = items.findLast((item) => item.seconds === "4" && !item.aborted);
            current?.resolve({ items: [{ amount: 3.9744, approx: true, basis: "4s", text: "约 ¥3.97（720p ¥0.9936/秒 × 4 秒）" }], summary: { amount: 3.97, priced: 1, unknown: 0, approx: true, text: "预计费用：约 ¥3.97" } });
        });
        const badge = page.getByTestId("generation-cost-badge");
        await badge.waitFor({ state: "visible" });
        expect(await badge.textContent()).toBe("约 ¥3.97");
        expect(await badge.getAttribute("role")).toBeNull();

        await badge.focus();
        await page.getByRole("tooltip").waitFor({ state: "visible" });
        expect(await page.getByRole("tooltip").textContent()).toContain("720p ¥0.9936/秒 × 4 秒");
        await page.keyboard.press("Escape");
        await page.getByRole("tooltip").waitFor({ state: "hidden" });

        await page.getByRole("button", { name: "Switch 10s", exact: true }).click();
        expect(await badge.count()).toBe(0);
        await page.waitForFunction(() => (window as unknown as { __resolvers: Array<{ seconds: string }> }).__resolvers.some((item) => item.seconds === "10"));

        await page.evaluate(() => {
            const items = (window as unknown as { __resolvers: Array<{ seconds: string; aborted: boolean; resolve: (v: unknown) => void }> }).__resolvers;
            const current = items.findLast((item) => item.seconds === "10" && !item.aborted);
            current?.resolve({ items: [{ amount: 9.936, approx: true, basis: "10s", text: "约 ¥9.94（720p ¥0.9936/秒 × 10 秒）" }], summary: { amount: 9.94, priced: 1, unknown: 0, approx: true, text: "预计费用：约 ¥9.94" } });
        });
        await badge.waitFor({ state: "visible" });
        expect(await badge.textContent()).toBe("约 ¥9.94");
    } finally {
        await page.close();
    }
}, 30000);

test("批量创作表估算期间防连点重复弹窗，切画布取消后不弹出旧确认框", async () => {
    const page = await browser.newPage();
    try {
        estimateDelayMs = 150;
        estimateSummaryText = "预计费用：¥1.8";
        await page.addInitScript(() => {
            window.__costEstimateFetcher = async () => ({ items: [], summary: { amount: 0, priced: 0, unknown: 0, text: "" } });
        });
        await page.goto(server.url.href);
        const trigger = page.getByRole("button", { name: "Trigger Batch", exact: true });
        await trigger.click();
        await trigger.click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor({ state: "visible" });
        expect(await dialog.count()).toBe(1);
        expect(await dialog.textContent()).toContain("预计费用：¥1.8");
        await page.getByRole("button", { name: /确\s*认\s*生\s*成/ }).click();
        await dialog.waitFor({ state: "hidden" });
        expect(await page.getByTestId("enqueued").textContent()).toBe("[1]");

        estimateDelayMs = 250;
        await trigger.click();
        await page.getByRole("button", { name: "Switch Project", exact: true }).click();
        await page.waitForTimeout(350);
        expect(await dialog.count()).toBe(0);
        expect(await page.getByTestId("enqueued").textContent()).toBe("[1]");
    } finally {
        estimateDelayMs = 0;
        await page.close();
    }
}, 30000);
