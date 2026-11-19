import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const bundle = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-creation-preferences-harness.tsx"], target: "browser",
        define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "source", setup(builder) {
            builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
            builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
            builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        } }],
    });
    if (!bundle.success) throw new Error(bundle.logs.join("\n"));
    const js = await bundle.outputs.find(output => output.path.endsWith(".js"))!.text();
    const css = await productCss();
    server = Bun.serve({ port: 0, fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: { items: [], providers: [], total: 0 } });
        return new Response('<!doctype html><html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body class="app-product-overlays"><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true });
}, 60000);

afterAll(async () => { await browser?.close(); server?.stop(true); });

for (const mode of ["image", "video"]) {
    test(`new nodes restore the active ${mode} defaults at the expected confirmation point`, async () => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", route => new URL(route.request().url()).origin === server.url.origin ? route.continue() : route.abort());
        try {
            await page.goto(`${server.url}?mode=${mode}`);
            const panel = page.getByTestId("node-panel");
            await panel.getByRole("button", { name: `${mode}-a`, exact: true }).click();
            await page.getByRole("option", { name: `${mode}-b`, exact: true }).click();
            let current = JSON.parse((await page.getByTestId("current-config").textContent())!);
            expect(current.model).toBe(`fixture::${mode}-b`);
            expect(current.size).toBe(mode === "image" ? "1:1" : "9:16");
            if (mode === "video") {
                await page.getByRole("button", { name: "New node", exact: true }).click();
                expect(JSON.parse((await page.getByTestId("next-config").textContent())!).model).toBe("fixture::video-a");
                await panel.getByRole("button", { name: /^高级设置/ }).click();
                const settings = page.locator("[data-canvas-settings-popover]");
                const duration = settings.getByRole("slider");
                await duration.press("End");
                expect(await settings.getByText("恢复初始默认").count()).toBe(0);
                expect(await settings.getByText("当前参数已自动设为默认").count()).toBe(0);
                await panel.getByRole("button", { name: /^高级设置/ }).click();
                expect(JSON.parse((await page.getByTestId("preferences").textContent())!).model).toBe("fixture::video-a");
                await panel.getByRole("button", { name: "生成", exact: true }).click();
                current = JSON.parse((await page.getByTestId("current-config").textContent())!);
                expect(current.videoSeconds).toBe("10");
            }
            await page.getByRole("button", { name: "New node", exact: true }).click();
            const next = JSON.parse((await page.getByTestId("next-config").textContent())!);
            const keys = mode === "image" ? ["model", "size", "quality", "count", "transparentBackground"] : ["model", "size", "videoSeconds", "vquality", "videoGenerateAudio", "videoWatermark"];
            for (const key of keys) expect(next[key]).toBe(current[key]);
            if (mode === "video") {
                const settingsButton = panel.getByRole("button", { name: /^高级设置/ });
                await settingsButton.click();
                await page.getByRole("slider").press("Home");
                await settingsButton.click();
                expect(JSON.parse((await page.getByTestId("current-config").textContent())!).videoSeconds).toBe("5");
                for (const [from, to] of [["video-b", "video-a"], ["video-a", "video-b"]]) {
                    await panel.getByRole("button", { name: from, exact: true }).click();
                    await page.getByRole("option", { name: to, exact: true }).click();
                }
                expect(JSON.parse((await page.getByTestId("current-config").textContent())!).videoSeconds).toBe("10");
            }
            expect(errors).toEqual([]);
        } finally { await page.close(); }
    }, 30000);
}

test("video provider opens beside the model list and persists independently of the node model", async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    try {
        await page.goto(server.url + "?mode=video");
        const open = page.getByRole("button", { name: "video-a", exact: true });
        await open.click();
        const picker = page.getByRole("dialog", { name: "选择视频模型" });
        const header = picker.getByRole("button", { name: /默认供应商/ });
        expect(await picker.getByRole("option").allTextContents()).toEqual(["video-a", "video-b"]);
        await header.click();
        const providers = picker.getByRole("menu", { name: "供应商" });
        await providers.waitFor();
        const first = (await header.boundingBox())!;
        expect((await providers.boundingBox())!.x).toBeGreaterThanOrEqual(first.x + first.width);
        await providers.getByRole("menuitemradio", { name: "BeefTV" }).click();
        expect(await picker.getByRole("option").allTextContents()).toEqual([
            "Seedance 2.0 Fast", "Seedance 2.0 Mini", "Seedance 2.0", "Seedance 2.5", "Wan 3.0",
            "MiniMax H3", "MiniMax H3 Max", "MiniMax H3 Max Turbo", "TokenHub 可灵 V3",
        ]);
        await header.click();
        await providers.getByRole("menuitemradio", { name: "Second" }).click();
        expect(await picker.getByRole("option").allTextContents()).toEqual(["video-c"]);
        expect(await open.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await open.click();
        expect(await header.textContent()).toContain("Second");
        await picker.getByRole("option", { name: "video-c" }).click();
        await page.getByRole("button", { name: "video-c", exact: true }).waitFor();
        expect(JSON.parse((await page.getByTestId("current-config").textContent())!).model).toBe("second::video-c");
    } finally { await page.close(); }
}, 20000);


test("video reference mode defaults to all and follows the last completed generation", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url + "?mode=video&references");
        const modeGroup = page.getByRole("group", { name: "视频参考模式" });
        const all = modeGroup.getByRole("button", { name: "全能参考模式" });
        const frames = modeGroup.getByRole("button", { name: "首尾帧模式" });
        const freshNode = page.getByRole("button", { name: "Open fresh video node" });
        const generate = page.getByTestId("node-panel").getByRole("button", { name: "生成", exact: true });
        await all.waitFor();
        expect(await modeGroup.getByRole("button").allTextContents()).toEqual(["全能参考", "首尾帧"]);
        expect(await all.getAttribute("aria-pressed")).toBe("true");
        await frames.click();
        expect(await frames.getAttribute("aria-pressed")).toBe("true");
        await freshNode.click();
        expect(await all.getAttribute("aria-pressed")).toBe("true");
        await frames.click();
        await generate.click();
        await freshNode.click();
        expect(await frames.getAttribute("aria-pressed")).toBe("true");
        await page.reload();
        await frames.waitFor();
        expect(await frames.getAttribute("aria-pressed")).toBe("true");
        await all.click();
        await generate.click();
        await freshNode.click();
        expect(await all.getAttribute("aria-pressed")).toBe("true");
    } finally { await page.close(); }
}, 15000);
