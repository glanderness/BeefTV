import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

/**
 * 断流后的回执恢复（真实 hook + 假宿主）。
 *
 * 场景来源：内置助手停在「正在读取这次处理的最终结果」，最终报「这一轮未能确认完成」。
 * 观察流断掉时这一轮已经提交到宿主，面板只能靠读回执收尾；下面两条覆盖「读不到回执」
 * 和「用户放弃等待」两个收尾路径。
 */
let browser: Browser, server: ReturnType<typeof Bun.serve>;
let chatStarted = false, settled = false, pointerMoved = false, historyReads = 0;

const FAILED_TURN = { turnId: "t-cut", userText: "只创建草案", selectedNodeIds: [], reply: "", toolCalls: [], change: null,
    proposals: [], error: "模型没有完成回复。已经完成的操作会保留，请检查结果后再继续。", errorReason: "model_error", cancelled: false, createdAt: "2026-10-27T16:16:18Z" };

beforeEach(() => { chatStarted = false; settled = false; pointerMoved = false; historyReads = 0; });
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/assistant-stop-harness.tsx"], target: "browser", define: {
        "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"',
        "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"',
    }, plugins: [{ name: "test-source", setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find(output => output.path.endsWith(".js"))!.text();
    const ok = (data: unknown) => Response.json({ code: 0, data });
    server = Bun.serve({ port: 0, async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/harness.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
        if (url.pathname.endsWith("/assistant/ui-session")) return ok({ token: "synthetic-only", expiresAt: new Date(Date.now() + 1800000).toISOString() });
        if (url.pathname.endsWith("/assistant/status")) return ok({ available: true });
        if (url.pathname.endsWith("/assistant/sessions")) return ok({ currentSessionId: pointerMoved ? "durable:moved" : "s1", sessions: [] });
        if (url.pathname.endsWith("/assistant/history")) {
            historyReads++;
            // 假宿主与真宿主同形：点名读哪条对话就读哪条；不点名才回画布当前指针指向的那条。
            const requested = url.searchParams.get("sessionId");
            if (requested === "s1") return ok({ sessionId: "s1", active: null, turns: settled ? [FAILED_TURN] : [] });
            const current = pointerMoved ? "durable:moved" : "s1";
            if (current === "s1") return ok({ sessionId: "s1", active: null, turns: settled ? [FAILED_TURN] : [] });
            return ok({ sessionId: current, active: null, turns: [] });
        }
        if (url.pathname.endsWith("/assistant/chat")) {
            chatStarted = true;
            // 观察流断掉：没有 turn_end，也没有 observer_error。
            return new Response([
                JSON.stringify({ type: "session", sessionId: "s1", turnId: "t-cut" }),
                JSON.stringify({ type: "text_delta", delta: "开始处理" }),
            ].join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
        }
        if (url.pathname.startsWith("/api/")) return ok({});
        return new Response('<html><div id="root"></div><script type="module" src="/harness.js"></script></html>', { headers: { "content-type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

async function startAndLoseStream(page: import("playwright").Page) {
    await page.waitForFunction(() => document.querySelector('[data-testid="streaming"]')?.textContent === "false");
    await page.getByRole("button", { name: "开始", exact: true }).click();
    await page.getByTestId("awaiting").filter({ hasText: "true" }).waitFor({ timeout: 5000 });
    await page.getByTestId("error").filter({ hasText: "这一轮未能确认完成" }).waitFor({ timeout: 5000 });
}

test("画布当前对话被切走，回执仍按这次发送的对话读回来", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await startAndLoseStream(page);
        // 发送之后画布当前指针移到别处（会话交接或别处切换）：读「当前对话」永远看不到这一轮的回执。
        pointerMoved = true;
        settled = true;
        await page.waitForFunction(() => document.querySelector('[data-testid="awaiting"]')?.textContent === "false", null, { timeout: 8000 });
        expect(await page.getByTestId("error").innerText()).toBe("");
        expect(await page.getByTestId("pending").innerText()).toBe("");
        expect(await page.getByTestId("session").innerText()).toBe("s1");
        // 认领回执之后不再继续轮询。
        const reads = historyReads;
        await new Promise(resolve => setTimeout(resolve, 2600));
        expect(historyReads).toBe(reads);
    } finally { await page.close(); }
}, 30000);

test("回执永远读不到时，「知道了」释放输入框并停止轮询", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await startAndLoseStream(page);
        await page.getByRole("button", { name: "知道了", exact: true }).click();
        expect(await page.getByTestId("awaiting").innerText()).toBe("false");
        expect(await page.getByTestId("error").innerText()).toBe("");
        expect(await page.getByTestId("pending").innerText()).toBe("");
        const reads = historyReads;
        await new Promise(resolve => setTimeout(resolve, 2600));
        expect(historyReads).toBe(reads);
        // 输入框确实解锁：能再发一条。
        await page.getByRole("button", { name: "开始", exact: true }).click();
        await page.getByTestId("awaiting").filter({ hasText: "true" }).waitFor({ timeout: 5000 });
    } finally { await page.close(); }
}, 30000);
