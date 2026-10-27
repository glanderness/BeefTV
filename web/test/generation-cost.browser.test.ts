import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { productCss } from "./fixtures/product-css";

/**
 * 费用展示的浏览器验收：目录单价（模型选择器价格弹层）和一次生成的总价
 * （助手提议卡）都必须是用户看得懂的钱数，算不出的项照实说原因。
 * BEEFTV_UI_EVIDENCE_DIR 存在时把截图写进该目录，供 PR 使用。
 */
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/generation-cost-harness.tsx"], target: "browser",
        define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' },
        plugins: [{
            name: "source",
            setup(builder) {
                // Vite 负责图标 glob 展开，这个夹具不需要真实图标。
                builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
                builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
                builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            },
        }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const css = (await build.outputs.find((output) => output.path.endsWith(".css"))?.text() || "") + await productCss();
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            if (path.startsWith("/api/")) return Response.json({ code: 0, data: {} });
            const dark = new URL(request.url).searchParams.get("theme") === "dark";
            return new Response(`<html class="${dark ? "dark" : ""}"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body class="app-product-overlays"><div id="root" class="app-product-workspace"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 180000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 30000);

async function open(dark: boolean): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
    await page.goto(server.url.toString() + (dark ? "?theme=dark" : ""));
    await page.getByTestId("proposal-card").waitFor();
    return page;
}

const evidenceDir = process.env.BEEFTV_UI_EVIDENCE_DIR;

for (const dark of [false, true]) {
    test(`${dark ? "暗色" : "亮色"}下模型选择器给出目录单价、提议卡给出总价和单项`, async () => {
        const page = await open(dark);
        const card = await page.getByTestId("proposal-card").textContent();
        expect(card).toContain("预计费用 ¥5.08（已知部分），另有 1 项暂无价格");
        expect(card).toContain("预计费用 ¥0.35（1K 高质量 ¥0.35 × 1 张）");
        expect(card).toContain("预计费用 ¥2.58（1080p ¥0.43/秒 × 6秒）");
        expect(card).toContain("预计费用 ¥2.15（1080p ¥0.43/秒 × 5秒）");
        // 算不出的项只说原因，不能显示成 0 元。
        expect(card).toContain("缺少台词文本");
        expect(card).not.toContain("预计费用 ¥0（");

        const shot = (name: string) => evidenceDir ? `${evidenceDir}/${name}-${dark ? "dark" : "light"}.png` : "";
        if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
        if (evidenceDir) await page.getByTestId("proposal-card").screenshot({ path: shot("assistant-cost-card") });

        // 一次生成多个节点：每一项都有自己的金额和依据（含参考图）。
        const multi = await page.getByTestId("proposal-card-multi").textContent();
        expect(multi).toContain("预计费用 ¥1.8");
        expect(multi).toContain("换装 · 1 · ¥0.65（1K 低质量 ¥0.35 × 1 张 + 参考图 ¥0.15 × 2 张）");
        expect(multi).toContain("换装 · 3 · ¥0.5（1K 低质量 ¥0.35 × 1 张 + 参考图 ¥0.15 × 1 张）");
        if (evidenceDir) await page.getByTestId("proposal-card-multi").screenshot({ path: shot("assistant-cost-card-multi") });

        // 批量确认框：合计在前，逐项金额与依据在后（和批量表格、分镜两处确认框同源）。
        await page.getByTestId("batch-confirm").click();
        const dialog = page.locator(".ant-modal-confirm").first();
        await dialog.waitFor();
        const dialogText = await dialog.textContent();
        expect(dialogText).toContain("确认提交 3 个批量图片任务");
        expect(dialogText).toContain("预计费用 ¥1.8；换装 · 1 · ¥0.65（1K 低质量 ¥0.35 × 1 张 + 参考图 ¥0.15 × 2 张）；换装 · 2 · ¥0.65（1K 低质量 ¥0.35 × 1 张 + 参考图 ¥0.15 × 2 张）；换装 · 3 · ¥0.5（1K 低质量 ¥0.35 × 1 张 + 参考图 ¥0.15 × 1 张）");
        if (evidenceDir) await dialog.screenshot({ path: shot("batch-confirm-cost") });
        await page.locator(".ant-modal-confirm .ant-btn").first().click();

        await page.getByRole("button", { name: "参考单价" }).click();
        const popover = page.locator(".ant-popover:not(.ant-popover-hidden)").first();
        await popover.waitFor();
        const price = await popover.textContent();
        expect(price).toContain("高质量：1K ¥0.35 / 2K ¥0.6");
        expect(price).toContain("参考图 ¥0.15 / 张");
        expect(price).toContain("实际费用见生成账单");

        if (evidenceDir) {
            // 价格弹层有进场动画，刚可见时盒子可能还是 0 宽，等它量出尺寸再截图。
            await page.waitForFunction(() => (document.querySelector(".ant-popover:not(.ant-popover-hidden)")?.getBoundingClientRect().width ?? 0) > 0);
            await popover.screenshot({ path: shot("model-picker-price-popover") });
            await page.getByTestId("model-picker").screenshot({ path: shot("model-picker-price") });
        }
        await page.close();
    }, 60000);
}
