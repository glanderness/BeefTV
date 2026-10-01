// 内置创作助手：浏览器只与同源 Go 代理通信，宿主/owner/模型凭据都不进入页面。
// 三个端点的真实路径都在 /api/assistant/* 下；写错路径会让面板永远拿不到回复。
import { ApiError, apiBaseURL, http } from "./request";

/** 后端给出的不可用原因（穷举，见契约 A1）；未知值一律走兜底文案。 */
export type AssistantUnavailableReason =
    | "model_not_configured"
    | "credential_missing"
    | "model_protocol_unsupported"
    | "host_starting"
    | "host_start_failed"
    | "host_unreachable";

export type AssistantModelInfo = {
    id: string;
    channelId: string;
    channelName: string;
};

export type AgentHostStatus = {
    available: boolean;
    reason?: string;
    model?: AssistantModelInfo;
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

/** 一个回合真正落到画布上的改动；没写任何东西时后端给 null。 */
export type AssistantTurnChange = {
    revisionBefore: number;
    revisionAfter: number;
    createdNodeIds: string[];
    updatedNodeIds: string[];
    createdEdgeIds: string[];
};

/** 付费生成提议：后端只登记，不生成、不扣费，执行发生在画布既有生成链路。 */
export type AssistantGenerationProposal = {
    proposalId: string;
    kind: "image" | "video";
    nodeIds: string[];
    model: string;
    modelKey: string;
    note?: string;
    source?: { canvasId: string; canvasRevision: number; modelConfigRevision: number };
};

export type AgentTurnEnd = {
    type: "turn_end";
    turnId?: string;
    reply: string;
    toolCalls: AgentToolCall[];
    change?: AssistantTurnChange | null;
    proposals?: AssistantGenerationProposal[];
    error: string | null;
    errorReason?: string | null;
    cancelled: boolean;
    persistence?: string;
    metrics?: { firstTokenMs: number | null; totalMs: number };
};

export type AssistantTurn = {
    turnId: string;
    userText: string;
    selectedNodeIds: string[];
    reply: string;
    toolCalls: AgentToolCall[];
    change: AssistantTurnChange | null;
    proposals: AssistantGenerationProposal[];
    error: string | null;
    errorReason?: string | null;
    cancelled: boolean;
    createdAt: string;
};

export type AssistantSessionSummary = {
    sessionId: string;
    title: string;
    updatedAt: string;
    turnCount: number;
};

export type AssistantSessionList = {
    currentSessionId: string | null;
    sessions: AssistantSessionSummary[];
};

export type AssistantHistory = {
    sessionId: string;
    turns: (AssistantTurn & { undone?: boolean })[];
};

// UI 会话凭据只保存在内存里：刷新页面即重新签发，不写入 localStorage。
let uiSessionToken: string | null = null;

/**
 * 服务端失败原因只用于分支，展示给用户的永远是用户语。
 * 这些 reason 由后端给出（见 handler/agent_proxy.go 与 agent_host_lifecycle.go）。
 */
export function agentAssistantFailureText(reason: string | undefined, fallback = "创作助手暂时不可用，请稍后再试") {
    switch (reason) {
        case "turn_timeout":
            return "这一轮处理超时，已停止继续执行。已落地的改动会保留，可以缩小要求后继续。";
        case "turn_interrupted":
            return "上一轮执行中断，已经落地的改动已保留。请查看画布和改动记录后再继续。";
        case "turn_request_budget_exhausted":
        case "turn_tool_step_budget_exhausted":
            return "这一轮已达到调用上限，已停止继续执行。可以发送新消息继续，已落地的改动会保留。";
        case "request_budget_exhausted":
            return "当前配置的总调用预算已用完，请检查助手运行配置。已落地的改动会保留。";
        case "model_request_failed":
            return "这一轮的模型调用失败，请核对已经落地的改动后再继续。";
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
        case "session_not_current":
            return "你已经换到别的对话了，请重新发送这条消息";
        default:
            return fallback;
    }
}

export async function getAgentHostStatus(): Promise<AgentHostStatus> {
    const data = await http.get<AgentHostStatus>("/assistant/status");
    return data;
}

/** UI 会话头由页面内存里的凭据提供；助手的每条路由都走同一套认证。 */
async function uiSessionConfig() {
    const token = await ensureAgentUiSession();
    return { headers: { "X-Beeftv-Ui-Session": token } };
}

/** 重新拉起助手运行环境。失败必须抛出，界面才不会把「没启动」显示成「已就绪」。 */
export async function restartAgentHost(): Promise<void> {
    await http.post<{ restarted: boolean }>("/assistant/host/restart", {}, await uiSessionConfig());
}

/** 读取失败必须与空历史区分，由界面保留原内容并提供重新读取。 */
export async function listAssistantSessions(canvasId: string): Promise<AssistantSessionList> {
    return http.get<AssistantSessionList>(`/assistant/sessions?canvasId=${encodeURIComponent(canvasId)}`, await uiSessionConfig());
}

export async function createAssistantSession(canvasId: string): Promise<string | null> {
    const data = await http.post<{ sessionId: string }>("/assistant/sessions", { canvasId }, await uiSessionConfig());
    if (!data?.sessionId) throw new Error("没能新建对话，请重试");
    return data.sessionId;
}

export async function activateAssistantSession(canvasId: string, sessionId: string): Promise<string | null> {
    const data = await http.post<{ sessionId: string }>("/assistant/sessions/activate", { canvasId, sessionId }, await uiSessionConfig());
    if (!data?.sessionId) throw new Error("没能切换对话，请重试");
    return data.sessionId;
}

export async function getAssistantHistory(canvasId: string, sessionId?: string): Promise<AssistantHistory> {
    const query = new URLSearchParams({ canvasId });
    if (sessionId) query.set("sessionId", sessionId);
    const data = await http.get<AssistantHistory>(`/assistant/history?${query.toString()}`, await uiSessionConfig());
    if (!data || !Array.isArray(data.turns)) throw new Error("没能读取对话，请重试");
    return { sessionId: data.sessionId || sessionId || "", turns: data.turns.map((turn) => ({
        ...turn,
        error: turn.error ? agentAssistantFailureText(turn.errorReason ?? undefined, "这一轮没有全部完成，请核对已经落地的改动。") : null,
    })) };
}

/** 撤销失败的机器可读原因，映射到卡片里的一句话。 */
export type AssistantUndoFailure = "canvas_changed" | "already_undone" | "no_change" | "unknown";

export type AssistantUndoResult = { ok: true; revision: number } | { ok: false; failure: AssistantUndoFailure };

/**
 * 撤销一整回合的改动。后端以新修订号回滚，不倒退历史；
 * 409 的三种原因必须区分，否则用户看不出「能不能再试」。
 */
export async function undoAssistantTurn(turnId: string, canvasId: string): Promise<AssistantUndoResult> {
    try {
        const data = await http.post<{ revision: number }>(`/assistant/turns/${encodeURIComponent(turnId)}/undo`, { canvasId }, await uiSessionConfig());
        return { ok: true, revision: data?.revision ?? 0 };
    } catch (error) {
        return { ok: false, failure: assistantUndoFailure(error) };
    }
}

export function assistantUndoFailure(error: unknown): AssistantUndoFailure {
    const reason = error instanceof ApiError ? error.reason : undefined;
    switch (reason) {
        case "canvas_changed_since_turn":
            return "canvas_changed";
        case "turn_already_undone":
            return "already_undone";
        case "turn_has_no_change":
            return "no_change";
        default:
            return "unknown";
    }
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

export type AgentLifecycleEvent = {
    type: "lifecycle";
    phase: "compaction" | "compaction_end" | "retry" | "retry_end";
    reason?: string;
    aborted?: boolean;
    willRetry?: boolean;
    attempt?: number;
    maxAttempts?: number;
    success?: boolean;
};

export type StreamHandlers = {
    onDelta?: (delta: string) => void;
    onTurnEnd?: (end: AgentTurnEnd) => void;
    onLifecycle?: (event: AgentLifecycleEvent) => void;
};

/**
 * 流式结束但本次回合没有结算事件时的用户可见错误。
 *
 * 宿主对每一次对话都恰好发一条 `turn_end`；收到它才算这一回合真的结束。
 * 把「流断了」当成正常结束会让面板停在一段半截回复上，必须显式失败。
 */
export const AGENT_STREAM_INCOMPLETE_MESSAGE = "创作助手的回复没有完整结束，请再试一次";

/**
 * 界面明确引用、且后端会再校验归属的额外资源。
 * 内置助手默认能读当前画布与画布关联的素材/任务；额外画布只读，素材只读。
 */
export type AgentChatReference = {
    kind: "asset" | "canvas";
    id: string;
};

export type AgentChatRequest = {
    signal?: AbortSignal;
    selectedNodeIds?: string[];
    /** 当前消息里 @ 引用到的资源；后端逐项校验归属，任何一项非法都整轮拒绝。 */
    references?: AgentChatReference[];
    /** 只发当前会话；后端发现它已不是该画布的当前会话会整回合拒绝。 */
    sessionId?: string;
};

/** 已收到回合终态的业务失败，不等同于断流后的「执行结果未知」。 */
export class AgentTurnFailedError extends Error {
    constructor(readonly reason?: string | null) {
        super(agentAssistantFailureText(reason ?? undefined, "这一回合没有完成，请再试一次"));
        this.name = "AgentTurnFailedError";
    }
}

// NDJSON 流式对话：http 客户端只做信封解包，流式必须用原生 fetch（同源）。
export async function streamAgentChat(
    canvasId: string,
    message: string,
    handlers: StreamHandlers,
    request: AgentChatRequest = {},
): Promise<void> {
    const { signal, selectedNodeIds = [], references = [], sessionId } = request;
    const token = await ensureAgentUiSession();
    const body: Record<string, unknown> = { canvasId, message, selectedNodeIds };
    if (references.length) body.references = references;
    if (sessionId) body.sessionId = sessionId;
    const response = await fetch(`${apiBaseURL}/assistant/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Beeftv-Ui-Session": token },
        body: JSON.stringify(body),
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
        // 上游错误可能包含请求细节，控制台同样不记录原文。
        console.error("创作助手回合失败", { canvasId });
        throw new AgentTurnFailedError(result.turnEnd.errorReason);
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
        if (payload.type === "lifecycle") {
            handlers.onLifecycle?.(payload as unknown as AgentLifecycleEvent);
            return;
        }
        if (payload.type === "agent_end") {
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
    const response = await fetch(`${apiBaseURL}/assistant/cancel`, {
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
