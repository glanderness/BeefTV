import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

/**
 * NDJSON 回合流的确定性边界用例：分片切割、末尾无换行、中途断流。
 * 全部用内存流，不调用模型。
 */

const requests: Array<{ url: string; method: string; body: string }> = [];
let chatResponse: (() => Response | Promise<Response>) | null = null;
let sessionResponse: (() => Response) | null = null;

mock.module("@/services/api/request", () => ({
	apiBaseURL: "http://127.0.0.1:54321/api",
    ApiError: class ApiError extends Error {
        status?: number;
        reason?: string;
        constructor(message: string, options: { status?: number; reason?: string } = {}) {
            super(message);
            this.status = options.status;
            this.reason = options.reason;
        }
    },
    http: {
        get: async () => ({ available: true }),
        post: async () => {
            const response = sessionResponse ? sessionResponse() : new Response(JSON.stringify({ code: 0, data: { token: "ui-token" } }), { status: 200, headers: { "Content-Type": "application/json" } });
            if (!response.ok) throw new (class extends Error { status = response.status; })("session failed");
            const payload = await response.json();
            return payload.data;
        },
    },
}));

const { ApiError } = await import("@/services/api/request");
const { setActiveUserScope } = await import("@/lib/user-scope");
const {
    AgentChatNotAdmittedError,
    AGENT_STREAM_INCOMPLETE_MESSAGE,
    assistantUndoFailure,
    cancelAgentChat,
    ensureAgentUiSession,
    resetAgentUiSession,
    streamAgentChat,
} = await import("@/services/api/agent-assistant");

/** 把整段 NDJSON 按给定分片切开发成流，模拟真实网络分片（可切到单个字节）。 */
function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
            controller.close();
        },
    });
}

function chatResponseOf(chunks: string[]): Response {
    return new Response(streamOf(chunks), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

function installFetch() {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        requests.push({ url, method: init?.method || "GET", body: String(init?.body || "") });
        if (url.includes("/api/assistant/chat")) return chatResponse ? chatResponse() : new Response(null, { status: 500 });
        if (url.includes("/api/assistant/cancel")) return cancelResponse();
        if (url.includes("/api/assistant/ui-session")) return new Response(JSON.stringify({ code: 0, data: { token: "ui-token" } }), { status: 200 });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

let cancelResponse: () => Response = () => new Response(JSON.stringify({ code: 0, accepted: true }), { status: 202 });

beforeEach(() => {
    requests.length = 0;
    chatResponse = null;
    sessionResponse = null;
    cancelResponse = () => new Response(JSON.stringify({ code: 0, accepted: true }), { status: 202 });
    resetAgentUiSession();
    installFetch();
});

afterEach(() => {
    resetAgentUiSession();
});

const TURN_END = JSON.stringify({ type: "turn_end", reply: "完成", toolCalls: [], error: null, cancelled: false });

describe("创作助手回合流边界", () => {
    test("身份切换后不会复用凭据，旧签发也不能跨身份回写", async () => {
        let issued = 0;
        sessionResponse = () => new Response(JSON.stringify({ data: { token: `token-${++issued}`, expiresAt: new Date(Date.now() + 1_800_000).toISOString() } }));
        try {
            setActiveUserScope("a");
            expect(await ensureAgentUiSession()).toBe("token-1");
            setActiveUserScope("b");
            const stale = ensureAgentUiSession().catch((error: Error) => error);
            setActiveUserScope("a");
            expect(await ensureAgentUiSession()).toBe("token-3");
            expect(await stale).toBeInstanceOf(Error);
            expect((await stale as Error).message).toContain("账号已切换");
            expect(await ensureAgentUiSession()).toBe("token-3");
        } finally { setActiveUserScope(null); }
    });

    test("临近30分钟过期前续签，并发调用共用一次签发", async () => {
        let now = Date.parse("2026-10-02T00:00:00Z");
        const clock = spyOn(Date, "now").mockImplementation(() => now);
        let issued = 0;
        sessionResponse = () => new Response(JSON.stringify({ data: { token: `token-${++issued}`, expiresAt: new Date(now + 30 * 60_000).toISOString() } }));
        try {
            expect(await Promise.all([ensureAgentUiSession(), ensureAgentUiSession()])).toEqual(["token-1", "token-1"]);
            now += 29 * 60_000;
            expect(await ensureAgentUiSession()).toBe("token-1");
            now += 30_000;
            expect(await ensureAgentUiSession()).toBe("token-2");
            expect(issued).toBe(2);
        } finally { clock.mockRestore(); }
    });

    test("reset 后旧签发不能回写或返回旧凭据", async () => {
        let issued = 0;
        sessionResponse = () => new Response(JSON.stringify({ data: { token: `token-${++issued}`, expiresAt: new Date(Date.now() + 1_800_000).toISOString() } }));
        const stale = ensureAgentUiSession().catch((error: Error) => error);
        resetAgentUiSession();
        expect(await ensureAgentUiSession()).toBe("token-2");
        expect(await stale).toBeInstanceOf(Error);
        expect((await stale as Error).message).toContain("当前页面会话已更新");
        expect(await ensureAgentUiSession()).toBe("token-2");
    });

    test("明确的403接纳拒绝清除旧凭据但绝不自动重放消息", async () => {
        let issued = 0;
        sessionResponse = () => new Response(JSON.stringify({ data: { token: `token-${++issued}`, expiresAt: new Date(Date.now() + 1_800_000).toISOString() } }));
        chatResponse = () => new Response(JSON.stringify({ reason: "unauthenticated" }), { status: 403, headers: { "X-Beeftv-Turn-Admission": "rejected" } });
        await expect(streamAgentChat("c1", "hi", {})).rejects.toBeInstanceOf(AgentChatNotAdmittedError);
        expect(requests.filter((r) => r.url.endsWith("/chat"))).toHaveLength(1);
        expect(await ensureAgentUiSession()).toBe("token-2");
    });

    test("签发失败没有发送chat，按未接纳处理", async () => {
        sessionResponse = () => new Response("", { status: 403 });
        await expect(streamAgentChat("c1", "hi", {})).rejects.toBeInstanceOf(AgentChatNotAdmittedError);
        expect(requests).toHaveLength(0);
    });

    test("旧请求延迟返回403不会清除已经续签的新凭据", async () => {
        let issued = 0;
        sessionResponse = () => new Response(JSON.stringify({ data: { token: `token-${++issued}`, expiresAt: new Date(Date.now() + 1_800_000).toISOString() } }));
        let rejectResponse!: (response: Response) => void;
        let sent!: () => void;
        const dispatched = new Promise<void>((resolve) => { sent = resolve; });
        chatResponse = () => {
            sent();
            return new Promise<Response>((resolve) => { rejectResponse = resolve; });
        };
        const oldRequest = streamAgentChat("c1", "hi", {}).catch((error: Error) => error);
        await dispatched;
        resetAgentUiSession();
        expect(await ensureAgentUiSession()).toBe("token-2");
        rejectResponse(new Response(JSON.stringify({ reason: "unauthenticated" }), { status: 403, headers: { "X-Beeftv-Turn-Admission": "rejected" } }));
        expect(await oldRequest).toBeInstanceOf(AgentChatNotAdmittedError);
        expect(await ensureAgentUiSession()).toBe("token-2");
        expect(issued).toBe(2);
    });

    test("没有明确拒绝标记的HTTP错误和已接纳断流继续视为结果未知", async () => {
        for (const admission of [null, "unknown", "admitted"]) {
            chatResponse = () => new Response(JSON.stringify({ reason: "host_unreachable" }), { status: 503, headers: admission ? { "X-Beeftv-Turn-Admission": admission } : {} });
            const error = await streamAgentChat("c1", "hi", {}).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(Error);
            expect(error).not.toBeInstanceOf(AgentChatNotAdmittedError);
        }
        chatResponse = () => chatResponseOf([`{"type":"text_delta","delta":"半截"}\n`]);
        const error = await streamAgentChat("c1", "hi", {}).catch((e: unknown) => e);
        expect(error).not.toBeInstanceOf(AgentChatNotAdmittedError);
        expect(requests.filter((r) => r.url.endsWith("/chat"))).toHaveLength(4);
    });
	 test("对话和取消连接当前桌面运行时地址", async () => {
		chatResponse = () => chatResponseOf([TURN_END + "\n"]);
		await streamAgentChat("canvas-1", "test", {});
		await cancelAgentChat("canvas-1");
		expect(requests.map((request) => request.url)).toEqual([
			"http://127.0.0.1:54321/api/assistant/chat",
			"http://127.0.0.1:54321/api/assistant/cancel",
		]);
	 });
    test("分片切割（含跨行与多字节中文）仍能完整取回增量与最终回合", async () => {
        const line = JSON.stringify({ type: "text_delta", delta: "雨夜巷口" }) + "\n";
        const bytes = new TextEncoder().encode(line + TURN_END + "\n");
        // 在每个字节边界切一刀：任何依赖「一次读到整行」的实现都会露馅，
        // 同时覆盖中文被切断在多字节序列中间的情况。
        const chunks: Uint8Array[] = [];
        for (let index = 0; index < bytes.length; index += 1) chunks.push(bytes.slice(index, index + 1));
        chatResponse = () => new Response(streamOf(chunks), { status: 200 });

        const deltas: string[] = [];
        let ended = 0;
        await streamAgentChat("c1", "hi", { onDelta: (delta) => deltas.push(delta), onTurnEnd: () => { ended += 1; } });

        expect(deltas.join("")).toBe("雨夜巷口");
        expect(ended).toBe(1);
    });

    test("最后一行没有换行符也要处理（不能丢尾部）", async () => {
        chatResponse = () => chatResponseOf([`${JSON.stringify({ type: "text_delta", delta: "尾" })}\n`, TURN_END]);

        const deltas: string[] = [];
        let reply = "";
        await streamAgentChat("c1", "hi", { onDelta: (delta) => deltas.push(delta), onTurnEnd: (end) => { reply = end.reply; } });

        expect(deltas.join("")).toBe("尾");
        expect(reply).toBe("完成");
    });

    test("流结束但没有最终回合事件 → 显式未完成错误，不当成功", async () => {
        chatResponse = () => chatResponseOf([`${JSON.stringify({ type: "text_delta", delta: "半截" })}\n`]);

        await expect(streamAgentChat("c1", "hi", { onDelta: () => {} })).rejects.toThrow(AGENT_STREAM_INCOMPLETE_MESSAGE);
    });

    test("损坏的 JSON 行 → 显式未完成错误，不再被 continue 吞掉", async () => {
        chatResponse = () => chatResponseOf(["{ this is not json }\n", `${TURN_END}\n`]);

        await expect(streamAgentChat("c1", "hi", {})).rejects.toThrow(AGENT_STREAM_INCOMPLETE_MESSAGE);
    });

    test("中途断流（reader 抛错）向上抛出，不当作正常结束", async () => {
        const encoder = new TextEncoder();
        chatResponse = () => new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(`${JSON.stringify({ type: "text_delta", delta: "半" })}\n`));
                controller.error(new Error("network down"));
            },
        }), { status: 200 });

        await expect(streamAgentChat("c1", "hi", {})).rejects.toThrow("network down");
    });

    test("宿主返回 error 的回合 → 用户可见失败，且不泄露实现者术语", async () => {
        chatResponse = () => chatResponseOf([`${JSON.stringify({ type: "turn_end", reply: "", toolCalls: [], error: "TypeError: x is not a function", cancelled: false })}\n`]);

        await expect(streamAgentChat("c1", "hi", {})).rejects.toThrow("这一回合没有完成，请再试一次");
    });

    test("lifecycle 事件不会把回合当成结束，agent_end 也不结算", async () => {
        const lifecycle = JSON.stringify({ type: "lifecycle", phase: "compaction", reason: "threshold" });
        const agentEnd = JSON.stringify({ type: "agent_end", willRetry: false, messages: [] });
        chatResponse = () => chatResponseOf([`${lifecycle}\n`, `${agentEnd}\n`]);
        const phases: string[] = [];
        await expect(streamAgentChat("c1", "hi", {
            onLifecycle: (event) => { phases.push(event.phase); },
        })).rejects.toThrow(AGENT_STREAM_INCOMPLETE_MESSAGE);
        expect(phases).toEqual(["compaction"]);
    });

    test("cancelled 回合按正常结束处理", async () => {
        chatResponse = () => chatResponseOf([`${JSON.stringify({ type: "turn_end", reply: "已停止", toolCalls: [], error: null, cancelled: true })}\n`]);

        let cancelled = false;
        await streamAgentChat("c1", "hi", { onTurnEnd: (end) => { cancelled = end.cancelled; } });

        expect(cancelled).toBe(true);
    });

    test("停止失败（404 会话不存在）必须抛出，不能当成已停止", async () => {
        cancelResponse = () => new Response(JSON.stringify({ code: 404, reason: "session_not_found" }), { status: 404 });

        await expect(cancelAgentChat("c1")).rejects.toThrow();
    });

    test("停止返回业务失败（HTTP 202 但 code 非 0）也要抛出", async () => {
        cancelResponse = () => new Response(JSON.stringify({ code: 500, reason: "internal_error" }), { status: 202 });

        await expect(cancelAgentChat("c1")).rejects.toThrow();
    });

    test("停止成功时不抛错", async () => {
        await expect(cancelAgentChat("c1")).resolves.toBeUndefined();
    });

    test("最终回合带回 turnId、改动清单与生成提议", async () => {
        const end = {
            type: "turn_end",
            turnId: "turn-7",
            reply: "已经建好三个镜头",
            toolCalls: [{ toolCallId: "t1", tool: "canvas.nodes.create" }],
            change: { revisionBefore: 4, revisionAfter: 5, createdNodeIds: ["n1", "n2", "n3"], updatedNodeIds: [], createdEdgeIds: ["e1", "e2"] },
            proposals: [{ proposalId: "p1", kind: "image", nodeIds: ["n1"], model: "seedream-4", modelKey: "ch::seedream-4" }],
            error: null,
            cancelled: false,
        };
        chatResponse = () => chatResponseOf([`${JSON.stringify(end)}\n`]);

        let received: Record<string, unknown> | null = null;
        await streamAgentChat("c1", "hi", { onTurnEnd: (value) => { received = value as unknown as Record<string, unknown>; } });

        expect(received).not.toBeNull();
        expect(received!.turnId).toBe("turn-7");
        expect(received!.change).toEqual(end.change);
        expect(received!.proposals).toEqual(end.proposals);
    });

    test("旧格式（没有 turnId / change / proposals）仍然按成功结束", async () => {
        chatResponse = () => chatResponseOf([`${TURN_END}\n`]);
        let received: Record<string, unknown> | null = null;
        await streamAgentChat("c1", "hi", { onTurnEnd: (value) => { received = value as unknown as Record<string, unknown>; } });
        expect(received!.turnId).toBeUndefined();
        expect(received!.change).toBeUndefined();
    });

    test("会话不是当前会话时给出可操作的一句话", async () => {
        chatResponse = () => new Response(JSON.stringify({ code: 409, reason: "session_not_current" }), { status: 409 });
        await expect(streamAgentChat("c1", "hi", {}, { sessionId: "stale" })).rejects.toThrow("你已经换到别的对话了，请重新发送这条消息");
    });

    test("指定会话时才把 sessionId 放进请求体", async () => {
        chatResponse = () => chatResponseOf([`${TURN_END}\n`]);
        await streamAgentChat("c1", "hi", {}, { sessionId: "s-1", selectedNodeIds: ["n1"] });
        const chat = requests.find((item) => item.url.includes("/assistant/chat"));
        expect(JSON.parse(chat!.body)).toEqual({ canvasId: "c1", message: "hi", selectedNodeIds: ["n1"], sessionId: "s-1" });

        requests.length = 0;
        await streamAgentChat("c1", "hi", {});
        const plain = requests.find((item) => item.url.includes("/assistant/chat"));
        expect(JSON.parse(plain!.body)).toEqual({ canvasId: "c1", message: "hi", selectedNodeIds: [] });
    });
});

describe("撤销失败原因", () => {
    test("三种 409 各自可分辨，未知原因归到 unknown", () => {
        // 必须用同一个 ApiError 类，instanceof 才会命中（这里是被替换掉的那个）。
        const failure = (reason?: string) => new ApiError("failed", { status: 409, reason });
        expect(assistantUndoFailure(failure("canvas_changed_since_turn"))).toBe("canvas_changed");
        expect(assistantUndoFailure(failure("turn_already_undone"))).toBe("already_undone");
        expect(assistantUndoFailure(failure("turn_has_no_change"))).toBe("no_change");
        expect(assistantUndoFailure(failure("brand_new_reason"))).toBe("unknown");
        expect(assistantUndoFailure(new Error("boom"))).toBe("unknown");
    });
});
