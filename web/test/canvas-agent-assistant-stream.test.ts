import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * NDJSON 回合流的确定性边界用例：分片切割、末尾无换行、中途断流。
 * 全部用内存流，不调用模型。
 */

const requests: Array<{ url: string; method: string; body: string }> = [];
let chatResponse: (() => Response) | null = null;
let sessionResponse: (() => Response) | null = null;

mock.module("@/services/api/request", () => ({
	apiBaseURL: "http://127.0.0.1:54321/api",
    ApiError: class ApiError extends Error {
        status?: number;
        constructor(message: string, options: { status?: number } = {}) {
            super(message);
            this.status = options.status;
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

const {
    AGENT_STREAM_INCOMPLETE_MESSAGE,
    cancelAgentChat,
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
});
