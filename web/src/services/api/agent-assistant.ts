// 内置创作助手：浏览器只与同源 Go 代理通信，宿主/owner/模型凭据都不进入页面。
import { http } from "./request";

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

export async function getAgentHostStatus(): Promise<AgentHostStatus> {
    const data = await http.get<AgentHostStatus>("/assistant/status");
    return data;
}

export async function ensureAgentUiSession(): Promise<string> {
    if (uiSessionToken) return uiSessionToken;
    const data = await http.post<{ token: string }>("/assistant/ui-session", {});
    if (!data?.token) throw new Error("内置助手会话签发失败：宿主未就绪");
    uiSessionToken = data.token;
    return data.token;
}

export function resetAgentUiSession() {
    uiSessionToken = null;
}

export type StreamHandlers = {
    onDelta?: (delta: string) => void;
    onToolCall?: (call: AgentToolCall) => void;
    onTurnEnd?: (end: AgentTurnEnd) => void;
};

// NDJSON 流式对话：http 客户端只做信封解包，流式必须用原生 fetch（同源）。
export async function streamAgentChat(
    canvasId: string,
    message: string,
    handlers: StreamHandlers,
    signal?: AbortSignal,
    selectedNodeIds: string[] = [],
): Promise<void> {
    const token = await ensureAgentUiSession();
    const response = await fetch("/api/agent/chat", {
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
        throw new Error(`内置助手不可用：${reason}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let payload: Record<string, unknown>;
            try { payload = JSON.parse(trimmed); } catch { continue; }
            if (payload.type === "text_delta" && typeof payload.delta === "string") handlers.onDelta?.(payload.delta);
            else if (payload.type === "turn_end") handlers.onTurnEnd?.(payload as unknown as AgentTurnEnd);
        }
    }
}

export async function cancelAgentChat(canvasId: string): Promise<void> {
    const token = await ensureAgentUiSession();
    await fetch("/api/agent/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Beeftv-Ui-Session": token },
        body: JSON.stringify({ canvasId }),
    });
}
