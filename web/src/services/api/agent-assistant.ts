// 内置创作助手：浏览器只与同源 Go 代理通信，宿主/owner/模型凭据都不进入页面。
// 三个端点的真实路径都在 /api/assistant/* 下；写错路径会让面板永远拿不到回复。
import { ApiError, http } from "./request";

export type AgentHostStatus = {
    available: boolean;
    reason?: string;
    url?: string;
    health?: { raw?: string };
};

export type AgentToolCall = {
    toolCallId?: string;
    tool: string;
    args?: Record<string, unknown>;
    isError?: boolean;
    error?: string;
    replayed?: boolean;
};

export type AgentTurnEnd = {
    type: "turn_end";
    reply: string;
    toolCalls: AgentToolCall[];
    error: string | null;
    cancelled: boolean;
    persistence?: string;
    metrics?: { firstTokenMs: number | null; totalMs: number };
};

// UI 会话凭据只保存在内存里：刷新页面即重新签发，不写入 localStorage。
let uiSessionToken: string | null = null;

/**
 * 服务端失败原因只用于分支，展示给用户的永远是用户语。
 * 这些 reason 由后端给出（见 handler/agent_proxy.go 与 agent_host_lifecycle.go）。
 */
export function agentAssistantFailureText(reason: string | undefined, fallback = "创作助手暂时不可用，请稍后再试") {
    switch (reason) {
        case "host_unreachable":
        case "host_unhealthy":
        case "host_token_missing":
        case "host_command_missing":
        case "host_start_failed":
            return "创作助手还没准备好，请稍后再试";
        case "unauthenticated":
        case "read_only_client":
        case "forbidden":
            return "当前页面无法使用创作助手，请重新打开画布";
        case "session_busy":
            return "上一条消息还在处理中，请等它结束";
        case "update_rerun":
            return "这次修改没有提交，画布已保留你现在的编辑";
        default:
            return fallback;
    }
}

export async function getAgentHostStatus(): Promise<AgentHostStatus> {
    const data = await http.get<AgentHostStatus>("/assistant/status");
    return data;
}

export async function ensureAgentUiSession(): Promise<string> {
    if (uiSessionToken) return uiSessionToken;
    let data: { token?: string };
    try {
        data = await http.post<{ token: string }>("/assistant/ui-session", {});
    } catch (error) {
        const status = error instanceof ApiError ? error.status : undefined;
        if (status === 403) {
            resetAgentUiSession();
            throw new Error(agentAssistantFailureText("forbidden"));
        }
        throw new Error(agentAssistantFailureText(undefined, "创作助手暂时不可用，请稍后再试"));
    }
    if (!data?.token) throw new Error("创作助手暂时不可用，请稍后再试");
    uiSessionToken = data.token;
    return data.token;
}

export function resetAgentUiSession() {
    uiSessionToken = null;
}

export type StreamHandlers = {
    onDelta?: (delta: string) => void;
    onTurnEnd?: (end: AgentTurnEnd) => void;
};

/**
 * 流式结束但本次回合没有结算事件时的用户可见错误。
 *
 * 宿主对每一次对话都恰好发一条 `turn_end`；收到它才算这一回合真的结束。
 * 把「流断了」当成正常结束会让面板停在一段半截回复上，必须显式失败。
 */
export const AGENT_STREAM_INCOMPLETE_MESSAGE = "创作助手的回复没有完整结束，请再试一次";

// NDJSON 流式对话：http 客户端只做信封解包，流式必须用原生 fetch（同源）。
export async function streamAgentChat(
    canvasId: string,
    message: string,
    handlers: StreamHandlers,
    signal?: AbortSignal,
    selectedNodeIds: string[] = [],
): Promise<void> {
    const token = await ensureAgentUiSession();
    const response = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Beeftv-Ui-Session": token },
        body: JSON.stringify({ canvasId, message, selectedNodeIds }),
        signal,
    });
    if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        let reason = `http_${response.status}`;
        try { reason = JSON.parse(text)?.reason || reason; } catch { /* 非 JSON */ }
        if (response.status === 403) resetAgentUiSession();
        throw new Error(agentAssistantFailureText(reason));
    }
    const result = await readAgentTurnStream(response.body, handlers, signal);
    if (!result.settled) throw new Error(AGENT_STREAM_INCOMPLETE_MESSAGE);
    if (result.turnEnd && !result.turnEnd.cancelled && result.turnEnd.error) {
        // 原始错误只进控制台；用户看到的是可操作的一句话。
        console.error("创作助手回合失败", { canvasId, error: result.turnEnd.error });
        throw new Error(agentAssistantFailureText(undefined, "这一回合没有完成，请再试一次"));
    }
}

/**
 * 逐行解析 NDJSON 回合流。
 *
 * 三处必须显式处理，否则会把截断当成成功：
 * 1. 流结束时先 flush 解码器，再处理没有换行符结尾的最后一行；
 * 2. 任何一行 JSON 损坏都按协议破损处理，不能 continue 吞掉；
 * 3. 必须见到 `turn_end` 才认为本次回合已结算。
 */
async function readAgentTurnStream(
    body: ReadableStream<Uint8Array>,
    handlers: StreamHandlers,
    signal?: AbortSignal,
): Promise<{ settled: boolean; turnEnd: AgentTurnEnd | null; malformedLine: string | null }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let settled = false;
    let turnEnd: AgentTurnEnd | null = null;
    let malformedLine: string | null = null;

    const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let payload: Record<string, unknown>;
        try {
            payload = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
            malformedLine = trimmed.slice(0, 200);
            return;
        }
        if (payload.type === "text_delta" && typeof payload.delta === "string") {
            handlers.onDelta?.(payload.delta);
            return;
        }
        if (payload.type === "turn_end") {
            settled = true;
            turnEnd = payload as unknown as AgentTurnEnd;
            handlers.onTurnEnd?.(turnEnd);
        }
    };

    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                buffer += decoder.decode();
                if (buffer.trim()) handleLine(buffer);
                buffer = "";
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) handleLine(line);
        }
    } finally {
        reader.releaseLock();
    }
    if (malformedLine !== null) throw new Error(AGENT_STREAM_INCOMPLETE_MESSAGE);
    if (signal?.aborted && !settled) throw new DOMException("请求已取消", "AbortError");
    return { settled, turnEnd, malformedLine };
}

/**
 * 请求停止当前画布正在进行的回合。
 *
 * 停止失败必须如实抛出：只 await fetch 会把 404/5xx 当成「已停止」，
 * 让界面显示与真实运行状态不一致。
 */
export async function cancelAgentChat(canvasId: string): Promise<void> {
    const token = await ensureAgentUiSession();
    const response = await fetch("/api/assistant/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Beeftv-Ui-Session": token },
        body: JSON.stringify({ canvasId }),
    });
    const text = await response.text().catch(() => "");
    let payload: { code?: number; reason?: string } | null = null;
    try { payload = JSON.parse(text) as { code?: number; reason?: string }; } catch { payload = null; }
    if (response.status === 403) resetAgentUiSession();
    const businessFailed = payload !== null && typeof payload.code === "number" && payload.code !== 0;
    if (!response.ok || businessFailed) {
        throw new Error(agentAssistantFailureText(payload?.reason, "停止失败，请再试一次"));
    }
}
