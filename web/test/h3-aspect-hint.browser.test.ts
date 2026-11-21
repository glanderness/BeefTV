import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { compileAppStyles } from "./helpers/app-styles";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const errors: string[] = [];

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/h3-aspect-hint-harness.tsx"], target: "browser", define: {
        "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"',
    }, plugins: [{ name: "source", setup(builder) {
        builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
        builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const css = await compileAppStyles();
    server = Bun.serve({ port: 0, fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (url.pathname === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (url.pathname.startsWith("/api/")) return Response.json({ code: 0, data: {}, msg: "ok" });
        const dark = url.searchParams.get("theme") === "dark";
        return new Response(`<html class="${dark ? "dark" : ""}"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body class="app-product-overlays"><div id="root" class="app-product-workspace"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    if (!(await fetch(`${server.url}harness.css`)).ok) throw new Error("Product CSS failed to load");
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);

afterAll(async () => { server?.stop(true); await browser?.close(); }, 30000);

async function open(width = 1280, dark = false) {
    const page = await browser.newPage({ viewport: { width, height: 850 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.toString() + (dark ? "?theme=dark" : ""));
    await page.getByRole("button", { name: /高级设置：.*随首帧图片/ }).waitFor();
    return page;
}

async function selectScenario(page: Page, label: string) {
    const settings = page.getByRole("button", { name: /^高级设置/, expanded: true });
    if (await settings.isVisible()) await settings.click();
    await page.getByRole("navigation", { name: "验证场景" }).getByRole("button", { name: label, exact: true }).click();
}

async function assertLocked(page: Page, frame = "首帧", savedSize = "9:16") {
    await page.getByRole("button", { name: new RegExp(`高级设置：.*随${frame}图片`) }).click();
    const panel = page.locator(".canvas-image-settings-popover");
    const help = `视频比例由${frame}图片决定。需要其他比例时，请先裁切或扩图，再生成视频。`;
    await panel.getByText(help, { exact: true }).waitFor();
    expect(await panel.getByRole("button", { name: "9:16", exact: true }).count()).toBe(0);
    expect(await panel.getByText(/^W\s/).count()).toBe(0);
    expect(await page.getByTestId("saved-size").textContent()).toBe(savedSize);
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await panel.getByText(help, { exact: true }).evaluate((element) => {
        const { fontSize, fontWeight } = getComputedStyle(element);
        return { fontSize, fontWeight };
    })).toEqual({ fontSize: "12px", fontWeight: "500" });
}

async function assertCharacterWarning(page: Page) {
    await page.getByRole("button", { name: /高级设置：.*16:9/ }).click();
    const panel = page.locator(".canvas-image-settings-popover");
    await panel.getByText("角色卡带参考图时，不能与指定的首尾帧同时使用。请移除角色卡，或取消首尾帧指定后再生成。", { exact: true }).waitFor();
    expect(await panel.getByRole("button", { name: "9:16", exact: true }).isVisible()).toBe(true);
}

test("actual prompt panel updates keyframe hints, reconnects and changes H3 modes", async () => {
    const page = await open();
    try {
        await assertLocked(page);
        await selectScenario(page, "只用尾帧");
        await assertLocked(page, "尾帧");
        await selectScenario(page, "首尾帧");
        await assertLocked(page);
        await selectScenario(page, "断开图片");
        await page.getByRole("button", { name: /高级设置：.*9:16/ }).click();
        await page.locator(".canvas-image-settings-popover").getByRole("button", { name: "16:9", exact: true }).click();
        expect(await page.getByTestId("saved-size").textContent()).toBe("16:9");
        await selectScenario(page, "接入图片");
        await page.getByRole("button", { name: /高级设置：.*随首帧图片/ }).waitFor();
        await selectScenario(page, "minimax-h3-max");
        await page.getByRole("button", { name: /高级设置：.*随首帧图片/ }).waitFor();
        await selectScenario(page, "minimax-h3");
        await page.getByRole("button", { name: /高级设置：.*16:9/ }).waitFor();
        await selectScenario(page, "指定首帧");
        await page.getByRole("button", { name: /高级设置：.*随首帧图片/ }).waitFor();
        await selectScenario(page, "加入角色卡");
        await assertCharacterWarning(page);
        await selectScenario(page, "只用尾帧");
        await assertCharacterWarning(page);
        await selectScenario(page, "普通参考");
        await page.getByRole("button", { name: /高级设置：.*16:9/ }).click();
        await page.locator(".canvas-image-settings-popover").getByRole("button", { name: "9:16", exact: true }).click();
        expect(await page.getByTestId("saved-size").textContent()).toBe("9:16");
        await selectScenario(page, "minimax-h3-max-turbo");
        await selectScenario(page, "仅角色卡");
        await page.getByRole("button", { name: /高级设置：.*9:16/ }).click();
        await page.getByText("首尾帧生成时，比例随实际参考图；多素材参考生成使用所选比例。", { exact: true }).waitFor();
        expect(errors).toEqual([]);
    } finally { await page.close(); }
}, 30000);

test("keyframe explanation fits light desktop and dark 390px panels", async () => {
    for (const [width, dark] of [[1280, false], [390, true]] as const) {
        const page = await open(width, dark);
        try {
            await assertLocked(page);
            expect(await page.getByText("视频比例由首帧图片决定。需要其他比例时，请先裁切或扩图，再生成视频。", { exact: true }).evaluate((element) => getComputedStyle(element).fontSize)).toBe("12px");
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            if (process.env.BEEFTV_UI_EVIDENCE_DIR) {
                mkdirSync(process.env.BEEFTV_UI_EVIDENCE_DIR, { recursive: true });
                await page.locator(".canvas-image-settings-popover").screenshot({ path: `${process.env.BEEFTV_UI_EVIDENCE_DIR}/h3-aspect-${dark ? "dark-390" : "light-desktop"}.png` });
            }
            expect(errors).toEqual([]);
        } finally { await page.close(); }
    }
}, 30000);

test("Max and Turbo reference ratios remain editable alongside H3 advanced controls", async () => {
    const page = await open();
    try {
        for (const model of ["minimax-h3-max", "minimax-h3-max-turbo"]) {
            await selectScenario(page, model);
            await selectScenario(page, "普通参考");
            await page.getByRole("button", { name: /高级设置：.*9:16/ }).click();
            const panel = page.locator(".canvas-image-settings-popover");
            await panel.getByRole("button", { name: "16:9", exact: true }).click();
            expect(await page.getByTestId("saved-size").textContent()).toBe("16:9");
            await panel.getByRole("button", { name: "9:16", exact: true }).click();
            await panel.getByText("高级参数", { exact: true }).click();
            const seed = panel.getByRole("spinbutton", { name: "随机种子", exact: true });
            await seed.fill("42");
            await seed.press("Tab");
            await panel.getByRole("combobox", { name: "提示词增强" }).click();
            const qualityMode = page.locator(".canvas-h3-option-popup").getByText("高质量", { exact: true });
            await qualityMode.waitFor();
            for (const control of [seed, qualityMode]) {
                expect(await control.evaluate(element => {
                    const { fontSize, fontWeight } = getComputedStyle(element);
                    return { fontSize, fontWeight };
                })).toEqual({ fontSize: "12px", fontWeight: "500" });
            }
            await qualityMode.click();
            expect(await page.getByTestId("saved-seed").textContent()).toBe("42");
            await page.getByRole("button", { name: /高级设置：.*9:16/ }).click();
        }
        expect(errors).toEqual([]);
    } finally { await page.close(); }
}, 30000);

test("Styles keyframes lock ratios and unresolved character views leave them editable", async () => {
    const page = await open();
    try {
        await selectScenario(page, "加入角色卡");
        await page.getByRole("button", { name: /高级设置：.*9:16/ }).click();
        const panel = page.locator(".canvas-image-settings-popover");
        await panel.getByText("首尾帧生成时，比例随实际参考图；多素材参考生成使用所选比例。", { exact: true }).waitFor();
        await panel.getByRole("button", { name: "16:9", exact: true }).click();
        expect(await page.getByTestId("saved-size").textContent()).toBe("16:9");
        await selectScenario(page, "断开图片");
        await selectScenario(page, "接入图片");
        await selectScenario(page, "H3 手绘");
        await assertLocked(page, "首帧", "16:9");
        await selectScenario(page, "断开图片");
        await page.getByRole("button", { name: /高级设置：.*16:9/ }).click();
        await panel.getByRole("button", { name: "9:16", exact: true }).click();
        expect(await page.getByTestId("saved-size").textContent()).toBe("9:16");
        expect(errors).toEqual([]);
    } finally { await page.close(); }
}, 30000);
