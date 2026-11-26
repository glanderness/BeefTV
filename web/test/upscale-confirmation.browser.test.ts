import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let creates: Record<string, unknown>[] = [];
let estimates: Record<string, unknown>[] = [];

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/upscale-confirmation-harness.tsx"], target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "source-alias", setup(builder) {
        // Bun 1.3.9 needs one explicit file identity when the fixture and the
        // component reach these shared contexts through different import forms.
        builder.onResolve({ filter: /^\.\.?\/.*(?:canvas-node-(?:graph|action)-context|canvas-theme|user-scope)$/ }, args => ({ path: Bun.resolveSync(args.path, args.resolveDir) }));
        builder.onResolve({ filter: /^@\// }, args => {
            // This suite owns the actual component, hook, quote client and AntD
            // controls. Canvas persistence is covered by repository tests; isolate
            // it here so submission cannot depend on a running desktop backend.
            if (args.path === "@/services/local-workspace-sync" || args.path === "@/stores/canvas/use-canvas-store") return { path: args.path, namespace: "upscale-persistence" };
            return { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) };
        });
        builder.onLoad({ filter: /.*/, namespace: "upscale-persistence" }, () => ({ contents: "export const syncLocalCanvasSnapshot = async () => {}; export const flushCanvasStorePersistence = async () => {}; export const useCanvasStore = { getState: () => ({updateProject: () => {}}) };", loader: "js" }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/api/media-upscale/capabilities") return Response.json({ code: 0, data: { cloudProcessing: true, maxVideoDurationMs: 300000, modes: [{ mediaType: "image", mode: "precision", models: ["Standard V2"], modelOptions: [{ id: "topaz-standard-v2", label: "Standard V2" }], scales: [1, 2, 3, 4], outputFormats: ["png", "jpeg"] }, { mediaType: "video", mode: "generative", models: ["tencent-video-enhance-seedance2"], modelOptions: [{ id: "tencent-video-enhance-seedance2", label: "Seedance2", billingMode: "mps_video_seconds" }], scales: [1, 2, 3, 4], outputFormats: ["mp4"] }] } });
        if (path === "/api/media-upscale/estimate") { estimates.push(await request.json() as Record<string, unknown>); return Response.json({ code: 0, data: { mediaType: "image", source: { width: 100, height: 100 }, output: { width: 200, height: 200 }, currency: "CNY", reservation: 1.25, generationSubmitted: false, cloudProcessing: true } }); }
        if (path.startsWith("/api/tasks/by-operation/")) return Response.json({ code: 404, msg: "not found" }, { status: 404 });
        if (path === "/api/media-upscale/tasks") {
            creates.push(await request.json() as Record<string, unknown>);
            return Response.json({ code: 0, data: { id: "original-task", type: "canvas_image", model: "topaz-standard-v2", status: "queued", prompt: "AI 超分", attempts: 1, createdAt: "", updatedAt: "" } });
        }
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: [] });
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true });
}, 30_000);
beforeEach(async () => { await page?.close(); creates = []; estimates = []; page = await browser.newPage({ viewport: { width: 390, height: 844 } }); });
afterAll(async () => { await browser?.close(); server?.stop(true); });

test("a timed-out model lookup recovers automatically before allowing submission", async () => {
    let lookups = 0;
    await page.route("**/api/media-upscale/capabilities", route => {
        lookups++;
        return lookups === 1 ? route.abort("timedout") : route.continue();
    });
    await page.goto(server.url.toString());
    await page.getByText("预计先扣 ¥1.25", { exact: true }).waitFor({ timeout: 5_000 });
    expect(lookups).toBe(2);
    expect(await page.getByRole("button", { name: "开始批量超分", exact: true }).isEnabled()).toBe(true);
    expect(creates).toHaveLength(0);
}, 12_000);

test("retries an unavailable model list in place without submitting a paid task", async () => {
    let available = false;
    await page.route("**/api/media-upscale/capabilities", route => available
        ? route.continue()
        : route.fulfill({ status: 503, json: { code: 503, msg: "model list unavailable" } }));
    await page.goto(server.url.toString());
    const retry = page.getByRole("button", { name: "重试加载模型", exact: true });
    await retry.waitFor({ timeout: 5_000 });
    const start = page.getByRole("button", { name: "开始批量超分", exact: true });
    expect(await start.isEnabled()).toBe(false);
    available = true;
    await retry.click();
    await page.getByText("预计先扣 ¥1.25", { exact: true }).waitFor();
    expect(await start.isEnabled()).toBe(true);
    expect(creates).toHaveLength(0);
}, 12_000);

test("a failed submit-time estimate stops before creating a paid task", async () => {
    await page.goto(server.url.toString());
    await page.getByText("预计先扣 ¥1.25", { exact: true }).waitFor();
    await page.route("**/api/media-upscale/estimate", route =>
        route.fulfill({ status: 503, json: { code: 503, msg: "费用服务暂不可用" } }));
    await page.getByRole("button", { name: "开始批量超分", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("snapshot")?.textContent?.includes("费用服务暂不可用"));
    expect(creates).toHaveLength(0);
    expect(JSON.parse(await page.locator("#snapshot").innerText()).nodes).toHaveLength(2);
}, 15_000);

test("one click submits once without a dialog and subsequent clicks query the original", async () => {
    await page.goto(server.url.toString());
    await page.getByLabel("图片输出尺寸").click();
    for (const [index, label] of ["1K", "2K", "3K", "4K"].entries()) {
        const pixels = 1024 * (index + 1);
        expect(await page.locator(".ant-select-item-option").filter({ hasText: label }).getAttribute("title")).toBe(`${pixels} × ${pixels}`);
    }
    await page.locator(".ant-select-item-option").filter({ hasText: "4K" }).click();
    await page.getByRole("button", { name: "开始批量超分", exact: true }).click();
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).observed === "original-task");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ channelId: "beeftv", scale: 4 });
    expect(creates[0].clientOperationId).toBeTruthy();
    await page.getByRole("button", { name: "继续 / 查询批次", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".ant-btn-loading"));
    expect(creates).toHaveLength(1);
    expect(JSON.parse(await page.locator("#snapshot").innerText()).error).toBe("");
}, 15_000);

test("a definitively failed batch can start a new operation after changing settings", async () => {
    let firstOperation: string | undefined;
    await page.route("**/api/media-upscale/tasks", route => {
        if (firstOperation) return route.continue();
        firstOperation = route.request().postDataJSON().clientOperationId;
        return route.fulfill({ json: { code: 0, data: { id: "failed-task", status: "failed", outcome: { phase: "failed", regenerate: "allowed", reason: "task_failed" } } } });
    });
    await page.goto(server.url.toString());
    await page.getByRole("button", { name: "开始批量超分", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).observed === "failed-task");
    await page.getByLabel("图片输出尺寸").click({ timeout: 2000 });
    await page.getByText("4K", { exact: true }).click();
    await page.getByRole("button", { name: "开始新批次", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).observed === "original-task");
    expect(creates).toHaveLength(1);
    expect(creates[0].scale).toBe(4);
    expect(creates[0].clientOperationId).not.toBe(firstOperation);
}, 12_000);

test("mixed media waits for every quote and displays the total before submitting", async () => {
    let release!: () => void;
    const prepared = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/media-upscale/estimate", async route => {
        if (route.request().postDataJSON().resourceId === "prepared-source") await prepared;
        await route.continue();
    });
    await page.goto(server.url + "?mixed");
    const submit = page.getByRole("button", { name: "开始批量超分", exact: true });
    await page.getByText("正在估价…", { exact: true }).waitFor();
    expect(await submit.isEnabled()).toBe(false);
    expect(await page.getByText("预计先扣 ¥1.25", { exact: true }).count()).toBe(0);
    release();
    await page.getByText("预计先扣 ¥2.50", { exact: true }).waitFor();
    expect(creates).toHaveLength(0);
    await submit.click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).nodes.length === 5);
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).nodes
        .find((node: { id: string }) => node.id === "processor").metadata.upscaleBatch.items.every((item: { status: string }) => item.status === "accepted"));
    expect(creates.map(task => task.resourceId).sort()).toEqual(["owned-source", "prepared-source"]);
}, 12_000);

test("a price change after the total is shown stops before submitting", async () => {
    await page.goto(server.url.toString());
    await page.getByText("预计先扣 ¥1.25", { exact: true }).waitFor();
    await page.route("**/api/media-upscale/estimate", route => route.fulfill({
        json: { code: 0, data: { reservation: 2.50, currency: "CNY", generationSubmitted: false } },
    }));
    await page.getByRole("button", { name: "开始批量超分", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("snapshot")?.textContent?.includes("超分费用已变更"));
    await page.getByText(/预计先扣 ¥2\.50/).waitFor();
    expect(creates).toHaveLength(0);
}, 10_000);

test("a deleted result is reconciled by original task ID without creating another task", async () => {
    let queries = 0;
    await page.route("**/api/tasks/original-task", route => {
        queries++;
        return route.fulfill({ json: { code: 0, data: { id: "original-task", status: queries === 1 ? "running" : "succeeded" } } });
    });
    await page.goto(server.url.toString());
    await page.getByRole("button", { name: "开始批量超分", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).observed === "original-task");
    await page.getByRole("button", { name: "测试删除结果", exact: true }).click();
    await page.getByRole("button", { name: "开始新批次", exact: true }).waitFor({ timeout: 7000 });
    expect(queries).toBe(2);
    expect(creates).toHaveLength(1);
    const snapshot = JSON.parse(await page.locator("#snapshot").innerText());
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.nodes.find((node: { id: string }) => node.id === "processor").metadata.upscaleBatch.items[0])
        .toMatchObject({ taskId: "original-task", detachedResult: "succeeded" });
}, 12_000);

test("video uses the selected output resolution and only the Seedance video preset", async () => {
    await page.goto(server.url + "?video");
    await page.getByText("BeefTV超分模型", { exact: true }).waitFor();
    expect(await page.getByLabel("超分倍率").count()).toBe(0);
    expect(await page.getByText("原图", { exact: true }).count()).toBe(0);
    await page.getByLabel("输出清晰度").click();
    await page.getByText("2K", { exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes("预计先扣 ¥1.25"));
    expect(estimates.at(-1)).toMatchObject({ model: "tencent-video-enhance-seedance2", targetShortEdge: 1440 });
    await page.getByRole("button", { name: "开始批量超分", exact: true }).click();
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).observed === "original-task");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ model: "tencent-video-enhance-seedance2", targetShortEdge: 1440 });
});

test("an empty processor attaches the parameter panel below the node at both zoom levels", async () => {
    await page.goto(server.url + "?video&overview");
    const card = page.locator("#world-card");
    expect((await card.boundingBox())?.width).toBeCloseTo(72);
    expect(await card.getByLabel("输出清晰度").count()).toBe(0);
    await card.click();
    const panel = page.getByRole("region", { name: "画质提升参数" });
    await panel.waitFor({ timeout: 2_500 });
    const low = (await card.boundingBox())!;
    expect((await panel.boundingBox())!.y).toBeGreaterThan(low.y + low.height);
    expect(await panel.getByText("帧率").count()).toBe(0);
    await page.getByRole("button", { name: "测试缩放画布" }).click();
    const normal = (await card.boundingBox())!;
    expect(normal.width).toBeCloseTo(360);
    expect((await panel.boundingBox())!.y).toBeGreaterThan(normal.y + normal.height);
});

test("falls back to server-advertised upscale model when preset IDs are replaced upstream", async () => {
    await page.route("**/api/media-upscale/capabilities", route => route.fulfill({
        json: {
            code: 0,
            data: {
                cloudProcessing: true,
                maxVideoDurationMs: 300000,
                modes: [
                    { mediaType: "image", mode: "precision", models: ["topaz-standard-v3"], modelOptions: [{ id: "topaz-standard-v3", label: "Standard V3" }], scales: [1, 2, 3, 4], outputFormats: ["png"] },
                    { mediaType: "video", mode: "generative", models: ["tencent-video-enhance-v3"], modelOptions: [{ id: "tencent-video-enhance-v3", label: "Enhance V3", billingMode: "mps_video_seconds" }], scales: [1, 2, 3, 4], outputFormats: ["mp4"] },
                ],
            },
        },
    }));
    await page.goto(server.url + "?video");
    await page.getByText("预计先扣 ¥1.25", { exact: true }).waitFor({ timeout: 5_000 });
    expect(estimates.at(-1)).toMatchObject({ model: "tencent-video-enhance-v3" });
    await page.getByRole("button", { name: "开始批量超分", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).observed === "original-task");
    expect(creates[0]).toMatchObject({ model: "tencent-video-enhance-v3" });
}, 12_000);

test("fallback video model without mps billing omits targetShortEdge, and image-only patch does not persist 720p or block canvas delete", async () => {
    await page.route("**/api/media-upscale/capabilities", route => route.fulfill({
        json: {
            code: 0,
            data: {
                cloudProcessing: true,
                maxVideoDurationMs: 300000,
                modes: [
                    { mediaType: "image", mode: "precision", models: ["Standard V2"], modelOptions: [{ id: "topaz-standard-v2", label: "Standard V2" }], scales: [1, 2, 3, 4], outputFormats: ["png"] },
                    { mediaType: "video", mode: "generative", models: ["Starlight Fast 2"], modelOptions: [{ id: "topaz-starlight-fast-2", label: "Starlight Fast 2" }], scales: [1, 2, 3, 4], outputFormats: ["mp4"] },
                ],
            },
        },
    }));
    await page.goto(server.url + "?video");
    await page.getByText("预计先扣 ¥1.25", { exact: true }).waitFor({ timeout: 5_000 });
    expect(await page.getByLabel("输出清晰度").count()).toBe(0);
    expect(estimates.at(-1)?.targetShortEdge).toBeUndefined();
    expect(await page.locator("[data-canvas-keyboard-scope]").count()).toBe(0);

    await page.goto(server.url.toString());
    await page.getByLabel("图片输出尺寸").click();
    await page.locator(".ant-select-item-option").filter({ hasText: "4K" }).click();
    const snapshot = JSON.parse(await page.locator("#snapshot").innerText());
    const processor = snapshot.nodes.find((node: { id: string }) => node.id === "processor");
    expect(processor.metadata.upscale.videoTargetShortEdge).toBeUndefined();
}, 12_000);
