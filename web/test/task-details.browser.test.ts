import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let phase = "running";
let delayA = false;
let fail = false;
let reads: string[] = [];

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/task-details-harness.tsx"], target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "source-alias", setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync(resolve(import.meta.dir, "../src", args.path.slice(2)), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path.startsWith("/api/tasks/")) {
            reads.push(path);
            const id = path.split("/")[3];
            const capturedPhase = phase;
            if (id === "a" && delayA) await Bun.sleep(800);
            if (fail) return Response.json({ code: 1, msg: "temporary read failure" }, { status: 503 });
            const terminal = capturedPhase !== "running";
            const data = path.endsWith("/logs")
                ? [{ level: "info", message: terminal ? "completed" : "running", createdAt: "2026-09-29T15:00:00Z" }]
                : { id, type: "video", status: capturedPhase, stage: terminal ? capturedPhase : "分析视频", progress: terminal ? 100 : 35, prompt: "test", attempts: 1, createdAt: "2026-09-29T15:00:00Z", startedAt: "2026-09-29T15:00:01Z", updatedAt: "2026-09-29T15:00:02Z", ...(terminal ? { completedAt: "2026-09-29T15:00:03Z" } : {}) };
            return Response.json({ code: 0, data });
        }
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 30_000);

beforeEach(async () => {
    await page?.close();
    phase = "running"; delayA = false; fail = false; reads = [];
    page = await browser.newPage();
    await page.goto(server.url.toString());
});

afterAll(async () => { await browser?.close(); server?.stop(true); });

async function waitStatus(status: string, id = "a") {
    await page.waitForFunction(({ status, id }) => {
        const snapshot = JSON.parse(document.getElementById("snapshot")!.textContent!);
        return snapshot.data?.task.id === id && snapshot.data?.task.status === status;
    }, { status, id }, { timeout: 8_000 });
}

for (const terminal of ["succeeded", "failed", "cancelled"]) {
    test(`an open desktop task detail follows running -> ${terminal} and stops polling`, async () => {
        await page.getByRole("button", { name: "a", exact: true }).click();
        await waitStatus("running");
        const running = JSON.parse(await page.locator("#snapshot").innerText());
        expect(running.data.task.progress).toBe(35);
        expect(running.data.task.startedAt).toBeTruthy();
        expect(running.data.logs).toHaveLength(1);
        phase = terminal;
        if (terminal === "cancelled") await page.getByRole("button", { name: "cancel event" }).click();
        await waitStatus(terminal);
        expect(JSON.parse(await page.locator("#snapshot").innerText()).data.task.completedAt).toBeTruthy();
        const count = reads.length;
        await page.waitForTimeout(2_200);
        expect(reads.length).toBe(count);
    }, 12_000);
}

test("late task reads cannot replace a different task or reopen a closed detail", async () => {
    delayA = true;
    await page.getByRole("button", { name: "a", exact: true }).click();
    await page.waitForTimeout(100);
    await page.getByRole("button", { name: "b", exact: true }).click();
    await waitStatus("running", "b");
    await page.waitForTimeout(1_000);
    expect(JSON.parse(await page.locator("#snapshot").innerText()).data.task.id).toBe("b");
    await page.getByRole("button", { name: "a", exact: true }).click();
    await page.getByRole("button", { name: "close", exact: true }).click();
    await page.waitForTimeout(1_000);
    expect(JSON.parse(await page.locator("#snapshot").innerText()).data).toBeUndefined();
    const count = reads.length;
    await page.waitForTimeout(2_200);
    expect(reads.length).toBe(count);
}, 10_000);

test("temporary read failure remains visible and recovers without reopening", async () => {
    fail = true;
    await page.getByRole("button", { name: "a", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).error);
    fail = false;
    await waitStatus("running");
    expect(JSON.parse(await page.locator("#snapshot").innerText()).error).toBe(false);
}, 10_000);

test("a confirmed cancellation remains visible when the following detail read fails", async () => {
    await page.getByRole("button", { name: "a", exact: true }).click();
    await waitStatus("running");
    fail = true;
    await page.getByRole("button", { name: "cancel event" }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).error);
    const snapshot = JSON.parse(await page.locator("#snapshot").innerText());
    expect(snapshot.data.task.status).toBe("cancelled");
    expect(snapshot.data.logs).toHaveLength(1);
});

test("an in-flight running response cannot overwrite a cancellation receipt", async () => {
    await page.getByRole("button", { name: "a", exact: true }).click();
    await waitStatus("running");
    delayA = true;
    const deadline = Date.now() + 4_000;
    while (reads.filter((path) => path === "/api/tasks/a").length < 2 && Date.now() < deadline) await Bun.sleep(20);
    expect(reads.filter((path) => path === "/api/tasks/a").length).toBeGreaterThanOrEqual(2);
    phase = "cancelled";
    await page.getByRole("button", { name: "cancel event" }).click();
    await waitStatus("cancelled");
    await page.waitForTimeout(1_200);
    expect(JSON.parse(await page.locator("#snapshot").innerText()).data.task.status).toBe("cancelled");
}, 10_000);

test("legacy metadata-only history never requests a nonexistent backend task", async () => {
    await page.getByRole("button", { name: "local:legacy", exact: true }).click();
    await page.waitForTimeout(2_200);
    expect(reads).toEqual([]);
});

test("canvas panel only counts generating nodes and removes ended or deleted tasks", async () => {
    let terminal = false;
    let unavailable = false;
    const task = (id: string, status: string, nodeId?: string, phase = "running") => ({
        id, projectId: "test-canvas", type: "canvas_video", model: id === "live" ? "Test Live Model" : "Test Video Model", status, prompt: id === "live" ? "" : id, attempts: 1,
        clientContext: nodeId ? { nodeId } : undefined,
        outcome: { phase, regenerate: "blocked", reason: "provider_result_pending" },
        createdAt: "2026-11-25T06:56:21Z", updatedAt: "2026-11-26T06:23:55Z",
    });
    await page.route("**/api/tasks?*", route => {
        expect(new URL(route.request().url()).searchParams.get("allActive")).toBe("true");
        if (unavailable) return route.fulfill({ status: 503, json: { code: 1, msg: "unavailable" } });
        return route.fulfill({ json: { code: 0, data: [
            task("live", terminal ? "failed" : "running", undefined, terminal ? "retrievable" : "running"),
            task("fail", terminal ? "failed" : "running", "fail-node", terminal ? "retrievable" : "running"),
            task("succeed", terminal ? "succeeded" : "running", "succeed-node", terminal ? "fetching" : "running"),
            task("cancel", terminal ? "cancelled" : "queued", "cancel-node", terminal ? "retrievable" : "running"),
            task("child-task", "running", "child"),
            task("orphan", "running", "missing-node"),
            task("recovery-task", "failed", "recovery-node", "retrievable"),
            ...Array.from({ length: terminal ? 0 : 34 }, (_, i) => task(`queued-${i}`, "queued", `queued-node-${i}`)),
        ] } });
    });

    await page.goto(server.url + "?panel");
    const panel = page.getByRole("region", { name: "当前画布生成任务" });
    await panel.getByText("39 项", { exact: true }).waitFor({ timeout: 4500 });
    await panel.getByRole("button", { name: /生成任务/ }).click();
    const rows = panel.getByRole("listitem");
    expect(await rows.count()).toBe(39);
    expect(await panel.getByText(/recovery-task|orphan/).count()).toBe(0);
    await panel.getByRole("button", { name: /Test Live Model/ }).click();
    await panel.getByRole("button", { name: "定位到画布节点", exact: true }).click();
    expect(await page.getByRole("status", { name: "定位结果" }).innerText()).toBe("live-node");

    unavailable = true;
    await page.getByRole("button", { name: "读取最新任务" }).click();
    await panel.getByText("刷新失败，显示上次状态").waitFor({ timeout: 5500 });
    await page.getByRole("button", { name: "删除视频节点" }).click();
    await panel.getByText("刷新失败，显示上次状态").waitFor();
    expect(await rows.count()).toBe(39); // 38 remaining tasks and one refresh status row.

    terminal = true;
    unavailable = false;
    await panel.getByRole("button", { name: "重试刷新" }).click();
    await panel.getByText("1 项", { exact: true }).waitFor();
    expect(await rows.count()).toBe(1);
    await page.getByRole("button", { name: "删除工作流画框" }).click();
    await panel.waitFor({ state: "detached" });
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks");
    await page.getByRole("button", { name: "读取最新任务" }).click();
    await refreshed;
    expect(await panel.count()).toBe(0);
    await page.getByRole("button", { name: "继续取回" }).click();
    expect(await page.getByRole("status", { name: "取回任务" }).innerText()).toBe("recovery-task");
}, 15_000);
