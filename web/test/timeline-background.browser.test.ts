import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

let browser: Browser, server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/timeline-background-harness.tsx"], target: "browser",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "source-alias", setup(build) {
            build.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync(resolve(import.meta.dir, "../src", args.path.slice(2)), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/fixture/persist") return new Response("ok");
        if (path.startsWith("/api/resources/")) return new Response("rendered-video", { headers: { "Content-Type": "video/mp4", "Content-Disposition": 'attachment; filename="timeline.mp4"' } });
        return new Response('<!doctype html><meta charset="UTF-8"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 30_000);
afterAll(async () => { await browser?.close(); server?.stop(true); });
const envelope = (data: unknown) => ({ code: 0, data, msg: "ok" });
const task = (id: string, status = "running") => ({ id, type: "timeline_render", projectId: "canvas-a", status, progress: 50, stage: "渲染中", resultJson: status === "succeeded" ? JSON.stringify({ resourceId: "render-result", fileName: "timeline.mp4" }) : undefined });
const resource = { id: "render-result", status: "ready", kind: "video", publicUrl: "", objectKey: "objects/render-output.mp4", width: 720, height: 1280, durationMs: 6000, size: 999, mimeType: "video/mp4" };
async function open(query = "") {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => console.error("timeline fixture:", error.message));
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.goto(server.url + query);
    await page.waitForFunction(() => Boolean((window as any).timelineBackground));
    return page;
}
const state = (page: Page) => page.evaluate(() => (window as any).timelineBackground.receipt);
const click = (page: Page, name: string | RegExp) => page.getByRole("button", { name, exact: true }).evaluate(button => (button as HTMLElement).click());
async function until(predicate: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for HTTP/UI boundary");
}
async function queued(page: Page) {
    const requests: string[] = [];
    await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        requests.push(`${route.request().method()} ${path}`);
        await route.fulfill({ json: envelope(path.endsWith("/renders") ? task("task-1") : task("task-1")) });
    });
    await click(page, "生成新片段");
    await until(() => page.getByRole("button", { name: "取消导出", exact: true }).isEnabled());
    return requests;
}

test("canvas entry freezes audio/output, submits once, and attaches the owned result without uploading bytes", async () => {
    const page = await open(); const requests: string[] = []; const submissions: any[] = [];
    try {
        await page.route("**/api/**", async route => {
            const path = new URL(route.request().url()).pathname;
            requests.push(`${route.request().method()} ${path}`);
            if (path.endsWith("/renders")) { submissions.push(route.request().postDataJSON()); await route.fulfill({ json: envelope(task("task-1", "succeeded")) }); }
            else if (path === "/api/tasks/task-1") await route.fulfill({ json: envelope(task("task-1", "succeeded")) });
            else if (path === "/api/resources/render-result") await route.fulfill({ json: envelope({ resource }) });
            else await route.continue();
        });
        await page.locator('input[type="file"]').setInputFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.from("fixture") });
        await until(async () => (await state(page)).uploads === 1);
        await page.getByRole("button", { name: "生成新片段", exact: true }).evaluate(button => { (button as HTMLElement).click(); (button as HTMLElement).click(); });
        await page.getByText("已生成新视频片段并放到画布，可继续编辑字幕与样式", { exact: true }).waitFor().catch(async error => { console.error(await page.locator("body").innerText(), requests); throw error; });
        expect(submissions).toHaveLength(1);
        expect(submissions[0].projectId).toBe("canvas-a");
        expect(submissions[0].timeline.clips.slice(0, 3).map((clip: any) => clip.directMedia.storageKey)).toEqual(["resource:source-video", "resource:source-voice", "resource:source-bgm"]);
        expect(submissions[0].timeline.output).toEqual({ width: 720, height: 1280, fps: 24 });
        const receipt = await state(page);
        expect(receipt.nodes).toHaveLength(1);
        expect(receipt.nodes[0].metadata).toMatchObject({ storageKey: "resource:render-result", content: "/api/resources/render-result/file", naturalWidth: 720, naturalHeight: 1280, bytes: 999, durationMs: 6000 });
        expect(requests.filter(value => value.startsWith("POST"))).toEqual(["POST /api/timeline/renders"]);
        expect(receipt.saved).toHaveLength(1);
    } finally { await page.close(); }
}, 15_000);

test("closing and unmounting stop observation without cancelling the background task", async () => {
    for (const close of [true, false]) {
        const page = await open();
        try {
            const requests = await queued(page);
            if (close) await click(page, /^取\s*消$/);
            else await page.evaluate(() => (window as any).timelineBackground.target({ mounted: false }));
            await page.getByRole("button", { name: "生成新片段", exact: true }).waitFor({ state: "hidden" });
            expect(requests.filter(value => value.includes("/cancel"))).toEqual([]);
            expect((await state(page)).nodes).toEqual([]);
        } finally { await page.close(); }
    }
}, 15_000);

for (const outcome of ["cancelled", "succeeded", "http400"] as const) test(`cancel ${outcome} suppresses delivery and reports the actual backend outcome`, async () => {
    const page = await open();
    try {
        const requests = await queued(page);
        const cancels: string[] = [];
        await page.route("**/api/tasks/*/cancel", async route => {
            cancels.push(new URL(route.request().url()).pathname);
            await route.fulfill(outcome === "http400" ? { status: 400, json: { code: 400, msg: "任务已完成" } } : { json: envelope(task("task-1", outcome)) });
        });
        await click(page, "取消导出");
        await page.getByText(outcome === "cancelled" ? "后台导出已取消" : outcome === "succeeded" ? "任务状态已变化，请到任务中心确认并下载成片" : /取消未完成/).first().waitFor();
        expect(cancels).toEqual(["/api/tasks/task-1/cancel"]);
        expect((await state(page)).nodes).toEqual([]);
        expect(requests.some(value => value.includes("render-result"))).toBe(false);
        if (outcome !== "cancelled") expect(await page.getByText("后台导出已取消", { exact: true }).count()).toBe(0);
    } finally { await page.close(); }
}, 15_000);

test("uncertain submission retries reuse the same key and frozen payload; edited inputs use a new key", async () => {
    const page = await open(); const submissions: any[] = [];
    try {
        await page.route("**/api/timeline/renders", async route => {
            submissions.push(route.request().postDataJSON());
            await route.fulfill({ status: 503, json: { code: 503, msg: "暂时无法确认提交" } });
        });
        for (let i = 1; i <= 2; i++) {
            await click(page, "生成新片段");
            await page.waitForFunction(() => !document.querySelector(".ant-btn-loading"));
            expect(submissions).toHaveLength(i);
        }
        expect(submissions[0]).toEqual(submissions[1]);
        await page.evaluate(() => (window as any).timelineBackground.target({ nodeId: "timeline-b" }));
        await click(page, "生成新片段");
        await page.waitForFunction(() => !document.querySelector(".ant-btn-loading"));
        expect(submissions[2].clientOperationId).not.toBe(submissions[0].clientOperationId);
        await page.evaluate(() => (window as any).timelineBackground.target({ open: false }));
        await page.getByRole("button", { name: "生成新片段", exact: true }).waitFor({ state: "hidden" });
        await page.evaluate(() => (window as any).timelineBackground.target({ open: true }));
        await click(page, "生成新片段");
        await until(() => submissions.length === 4);
        expect(submissions[3].clientOperationId).not.toBe(submissions[2].clientOperationId);
    } finally { await page.close(); }
}, 15_000);

test("switching node or canvas while metadata is pending cannot attach an old result or reset the new run", async () => {
    for (const change of [{ nodeId: "timeline-b" }, { canvasId: "canvas-b" }]) {
        const page = await open(); let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
        let reads = 0, submissions = 0;
        try {
            await page.route("**/api/timeline/renders", async route => { submissions++; await route.fulfill({ json: envelope(task(`task-${submissions}`, submissions === 1 ? "succeeded" : "running")) }); });
            await page.route("**/api/resources/render-result", async route => { reads++; await pending; await route.fulfill({ json: envelope({ resource }) }).catch(() => {}); });
            await page.route("**/api/tasks/*", route => route.fulfill({ json: envelope(route.request().url().endsWith("task-1") ? task("task-1", "succeeded") : task("task-2")) }));
            await click(page, "生成新片段");
            await until(() => reads === 1);
            await page.evaluate(change => (window as any).timelineBackground.target(change), change);
            await click(page, "生成新片段");
            await until(() => submissions === 2);
            release();
            await page.getByText("渲染中", { exact: true }).waitFor();
            expect((await state(page)).nodes).toEqual([]);
            expect(await page.getByRole("button", { name: "取消导出", exact: true }).isEnabled()).toBe(true);
        } finally { release(); await page.close(); }
    }
}, 20_000);

test("task result exposes the canonical resource download, never treats fileName as a URL, and ignores unfinished or malformed results", async () => {
    const page = await open("?result=1");
    try {
        const download = page.waitForEvent("download");
        await click(page, "下载成片");
        expect((await download).suggestedFilename()).toBe("timeline.mp4");
        expect(await page.locator('video[src="timeline.mp4"], img[src="timeline.mp4"]').count()).toBe(0);
        for (const result of [{ value: "{", status: "succeeded" }, { value: '{"resourceId":""}', status: "succeeded" }, { value: '{"resourceId":"render-result"}', status: "running" }]) {
            await page.evaluate(result => (window as any).timelineBackground.result(result), result);
            await page.getByRole("button", { name: "下载成片", exact: true }).waitFor({ state: "hidden" });
        }
    } finally { await page.close(); }
}, 15_000);

test("native save receives only the resource ID, locks close while saving, and distinguishes cancel, error and success", async () => {
    for (const outcome of ["cancel", "error", "success"]) {
        const page = await open(); const requests: string[] = [];
        try {
            await page.route("**/api/**", route => {
                requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
                return route.fulfill({ json: envelope(task("task-1", "succeeded")) });
            });
            await page.evaluate(() => {
                const calls: unknown[] = [];
                const native = { calls, finish: (_outcome: string) => {} };
                (window as any).nativeSave = native;
                (window as any).go = { main: { DesktopApp: { SaveOwnedMedia: (...args: unknown[]) => {
                    calls.push(args);
                    return new Promise((resolve, reject) => {
                        native.finish = outcome => outcome === "error" ? reject(new Error("selected path is not writable")) : resolve(outcome === "cancel" ? "" : "/selected/timeline.mp4");
                    });
                } } } };
            });
            await click(page, "导出成片");
            await until(() => page.evaluate(() => (window as any).nativeSave.calls.length === 1));
            expect(await page.evaluate(() => (window as any).nativeSave.calls)).toEqual([["测试成片.mp4", "render-result"]]);
            expect(await page.getByRole("button", { name: /^取\s*消$/, exact: true }).isDisabled()).toBe(true);
            await page.keyboard.press("Escape");
            expect(await page.getByRole("button", { name: /导出成片$/ }).isVisible()).toBe(true);
            await page.evaluate(outcome => (window as any).nativeSave.finish(outcome), outcome);
            await until(async () => await page.locator(".ant-btn-loading").count() === 0);
            if (outcome === "error") await page.getByText(/selected path is not writable/).waitFor();
            expect(await page.getByText("成片导出完成", { exact: true }).count()).toBe(outcome === "success" ? 1 : 0);
            expect(requests.filter(value => !value.startsWith("GET /api/resources/source-"))).toEqual(["POST /api/timeline/renders", "GET /api/tasks/task-1"]);
        } finally { await page.close(); }
    }
}, 20_000);

test("late cancel response cannot clear a reopened window's newer export", async () => {
    const page = await open(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let submissions = 0, cancelling = false;
    try {
        await page.route("**/api/**", async route => {
            const path = new URL(route.request().url()).pathname;
            if (path.endsWith("/cancel")) { cancelling = true; await pending; return route.fulfill({ json: envelope(task("task-1", "cancelled")) }); }
            if (path.endsWith("/renders")) submissions++;
            await route.fulfill({ json: envelope(task(`task-${submissions}`)) });
        });
        await click(page, "生成新片段");
        await until(() => page.getByRole("button", { name: "取消导出", exact: true }).isEnabled());
        await click(page, "取消导出");
        await until(() => cancelling);
        await page.evaluate(() => (window as any).timelineBackground.target({ open: false }));
        await page.getByRole("button", { name: "生成新片段", exact: true }).waitFor({ state: "hidden" });
        await page.evaluate(() => (window as any).timelineBackground.target({ open: true }));
        await click(page, "生成新片段");
        await until(() => submissions === 2);
        const response = page.waitForResponse("**/api/tasks/task-1/cancel");
        release(); await (await response).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(await page.getByRole("button", { name: "取消导出", exact: true }).isEnabled()).toBe(true);
        expect(await page.getByText("后台导出已取消", { exact: true }).count()).toBe(0);
        expect((await state(page)).nodes).toEqual([]);
    } finally { release(); await page.close(); }
}, 15_000);
