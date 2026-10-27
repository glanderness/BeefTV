import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/timeline-ui-harness.tsx"], target: "browser",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "encoder-task-failure-boundaries", setup(build) {
            build.onResolve({ filter: /^(?:@\/lib\/timeline\/timeline-export|@\/services\/api\/(?:task-center|timeline-tasks)|file-saver)$/ }, () => ({ path: import.meta.dir + "/fixtures/timeline-ui-runtime.ts" }));
            // Resolve remaining source aliases explicitly on the CI-pinned Bun 1.3.9.
            build.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(resolve(import.meta.dir, "../src", args.path.slice(2)), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch(request) {
        return new URL(request.url).pathname === "/harness.js"
            ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
            : new Response('<!doctype html><meta charset="UTF-8"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

const snapshot = (page: Page) => page.evaluate(() => (window as any).timelineFixture.receipt);
const clipLefts = async (page: Page) => page.evaluate(() => {
    const lefts: Record<string, number> = {};
    document.querySelectorAll("[data-timeline-clip-id]").forEach((element) => {
        lefts[element.getAttribute("data-timeline-clip-id") || ""] = Number.parseInt((element as HTMLElement).style.left, 10);
    });
    return lefts;
});
async function dragClip(page: Page, clipId: string, deltaX: number) {
    const target = page.locator(`[data-timeline-clip-id="${clipId}"]`);
    await target.hover();
    await page.mouse.down();
    // 选中片段会插入「片段编辑」面板并让轨道整体位移，因此按 down 之后的横坐标计算目标位置；
    // 指针已被片段捕获，纵向偏移不影响拖动。
    const box = (await target.boundingBox())!;
    expect(await target.getAttribute("data-selected")).toBe("true");
    await page.mouse.move(box.x + box.width / 2 + deltaX, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);
}
async function clickTwice(page: Page, name: string) {
    await page.getByRole("button", { name, exact: true }).evaluate((button) => { (button as HTMLElement).click(); (button as HTMLElement).click(); });
}

for (const mode of ["editor", "canvas"] as const) {
    test(`${mode}: audio sources survive the UI entry, duplicate clicks submit once, subtitle failure never saves`, async () => {
        const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
        try {
            await page.goto(`${server.url}?mode=${mode}`);
            const name = mode === "editor" ? "本地导出（ffmpeg.wasm）" : "生成新片段";
            await clickTwice(page, name);
            await page.getByRole("button", { name: "取消导出", exact: true }).waitFor();
            const pending = await snapshot(page);
            expect(pending.local).toHaveLength(1);
            expect(pending.local[0].map((source: any) => source.nodeId)).toEqual(["video", "voice", "bgm"]);
            expect(pending.local[0].every((source: any) => source.url?.startsWith("data:"))).toBe(true);
            await page.evaluate(() => (window as any).timelineFixture.receipt.failLocal());
            await page.getByText("字幕烧录失败，未导出无字幕成片", { exact: true }).waitFor();
            expect((await snapshot(page)).downloads).toBe(0);
            expect((await snapshot(page)).created).toBe(0);
            expect(await page.getByText(/导出完成|已生成新视频片段/).count()).toBe(0);
        } finally { await page.close(); }
    }, 15_000);

    test(`${mode}: cancel and unmount abort work without downloading or creating a node`, async () => {
        const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
        try {
            await page.goto(`${server.url}?mode=${mode}`);
            const name = mode === "editor" ? "本地导出（ffmpeg.wasm）" : "导出成片";
            await page.getByRole("button", { name, exact: true }).click();
            await page.getByRole("button", { name: "取消导出", exact: true }).click();
            await page.getByRole("button", { name: "取消导出", exact: true }).waitFor({ state: "hidden" });
            expect((await snapshot(page)).aborted).toBe(1);
            await page.getByRole("button", { name, exact: true }).click();
            await page.getByRole("button", { name: "取消导出", exact: true }).waitFor();
            await page.evaluate(() => (window as any).timelineFixture.unmount());
            const final = await snapshot(page);
            expect(final.aborted).toBe(2);
            expect(final.local).toHaveLength(2);
            expect(final.downloads).toBe(0);
            expect(final.created).toBe(0);
        } finally { await page.close(); }
    }, 15_000);
}

test("CanvasTimelineDialog 首个片段右侧紧贴下一段时仍可拖动，相邻片段顺次让位", async () => {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    try {
        await page.goto(`${server.url}?mode=canvas-drag`);
        await page.locator('[data-timeline-clip-id="clip-first"]').waitFor();
        // 等弹窗动画与工具栏自适应测量结束，否则首帧布局位移会让按下位置落空
        await page.waitForTimeout(600);
        // 384px = 4000ms × 0.096 px/ms（默认缩放）
        expect(await clipLefts(page)).toEqual({ "clip-first": 0, "clip-second": 384 });
        await dragClip(page, "clip-first", 120);
        const moved = await clipLefts(page);
        expect(moved["clip-first"]).toBe(120);
        // 被压到的下一段顺次让位，保持首尾紧贴且不重叠
        expect(moved["clip-second"]).toBe(120 + 384);
        // 让位只处理碰撞，不自动回填空白：被推开的片段留在新位置
        await dragClip(page, "clip-first", -120);
        expect(await clipLefts(page)).toEqual({ "clip-first": 0, "clip-second": 120 + 384 });
        // 有空隙时向左拖动照常落位，重新紧贴前一段
        await dragClip(page, "clip-second", -120);
        expect(await clipLefts(page)).toEqual({ "clip-first": 0, "clip-second": 384 });
        // 左侧没有空间时保持原位：拖动永远不产生同轨重叠
        await dragClip(page, "clip-second", -120);
        expect(await clipLefts(page)).toEqual({ "clip-first": 0, "clip-second": 384 });
    } finally { await page.close(); }
}, 30_000);

test("EditorExport default server route preserves all media, submits once and displays rendering failure", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await clickTwice(page, "渲染成片（服务端）");
        await page.getByRole("button", { name: "渲染中…", exact: true }).waitFor();
        const pending = await snapshot(page);
        expect(pending.remote).toHaveLength(1);
        expect(pending.remote[0].clips.map((clip: any) => clip.kind)).toEqual(["video", "audio", "audio"]);
        await page.evaluate(() => (window as any).timelineFixture.receipt.failRemote());
        await page.getByText("服务端字幕字体缺失，渲染失败", { exact: true }).waitFor();
        expect(await page.locator("video, a[download]").count()).toBe(0);
        expect((await snapshot(page)).downloads).toBe(0);
    } finally { await page.close(); }
}, 15_000);
