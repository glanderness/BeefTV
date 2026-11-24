import { isDesktopStreamingAvailable } from "@/services/workspace-startup-state";
import { apiBaseURL } from "./request";
import { ensureAgentUiSession, resetAgentUiSessionIfMatches } from "./agent-assistant-session";
import {
    AGENT_STREAM_INCOMPLETE_MESSAGE,
    AgentChatNotAdmittedError,
    AgentStreamDetachedError,
    AgentTurnFailedError,
    agentAssistantFailureText,
    assistantPermissionMode,
    normalizeAssistantProposal,
    type AgentCancelState,
    type AgentChatRequest,
    type AgentLifecycleEvent,
    type AgentTurnEnd,
    type AssistantAttachment,
    type AssistantPlan,
    type AssistantReasoningSegment,
    type StreamHandlers,
} from "./agent-assistant-types";

/** Only persisted resource descriptors cross HTTP; never copy local preview/File data. */
function attachmentRequestValue({ resourceId, kind, name, mimeType, bytes, purpose, start, end, durationMs, nodeId, assetId }: AssistantAttachment): AssistantAttachment {
    return { resourceId, kind, name, mimeType, bytes, purpose, start, end, durationMs, nodeId, assetId };
}

// NDJSON 流式对话：http 客户端只做信封解包，流式必须用原生 fetch（同源）。
export async function streamAgentChat(
    canvasId: string,
    message: string,
    handlers: StreamHandlers,
    request: AgentChatRequest = {},
): Promise<void> {
    const { signal, selectedNodeIds = [], references = [], sessionId, requestId, attachments = [], skills = [] } = request;
    let token: string;
    try {
        token = await ensureAgentUiSession();
    } catch (error) {
        throw new AgentChatNotAdmittedError(error instanceof Error ? error.message : "消息未发送，请重试");
    }
    signal?.throwIfAborted();
    const body: Record<string, unknown> = { canvasId, message, selectedNodeIds, permissionMode: assistantPermissionMode(request.permissionMode) };
    if (references.length) body.references = references;
    if (sessionId) body.sessionId = sessionId;
    if (requestId) body.requestId = requestId;
    if (attachments.length) body.attachments = attachments.map(attachmentRequestValue);
    if (skills.length) body.skills = skills.map(({ skillId, versionId, contentHash }) => ({ skillId, versionId, contentHash }));
    const headers: Record<string, string> = { "Content-Type": "application/json", "X-Beeftv-Ui-Session": token };
    if (!isDesktopStreamingAvailable()) {
        headers["X-Beeftv-Observer-Mode"] = "detach";
    }
    const response = await fetch(`${apiBaseURL}/assistant/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        let reason = `http_${response.status}`;
        try { reason = JSON.parse(text)?.reason || reason; } catch { /* 非 JSON */ }
        if (response.status === 403) resetAgentUiSessionIfMatches(token);
        const failureMessage = agentAssistantFailureText(reason);
        if (response.headers.get("X-Beeftv-Turn-Admission") === "rejected") {
            throw new AgentChatNotAdmittedError(failureMessage);
        }
        throw new Error(failureMessage);
    }
    const result = await readAgentTurnStream(response.body, handlers, signal);
    if (!result.settled) throw result.detached !== null ? new AgentStreamDetachedError(result.detached) : new Error(AGENT_STREAM_INCOMPLETE_MESSAGE);
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
): Promise<{ settled: boolean; turnEnd: AgentTurnEnd | null; malformedLine: string | null; detached: string | null }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let settled = false;
    let turnEnd: AgentTurnEnd | null = null;
    let malformedLine: string | null = null;
    let detached: string | null = null;

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
        if (payload.type === "session" && typeof payload.sessionId === "string" && payload.sessionId) {
            handlers.onSession?.(payload.sessionId);
            return;
        }
        if (payload.type === "text_delta" && typeof payload.delta === "string") {
            handlers.onDelta?.(payload.delta);
            return;
        }
        if (payload.type === "text_snapshot" && typeof payload.text === "string") {
            handlers.onText?.(payload.text);
            return;
        }
        if (payload.type === "reasoning_snapshot" && Array.isArray(payload.segments)) {
            handlers.onReasoning?.(payload.segments as AssistantReasoningSegment[]);
            return;
        }
        if (payload.type === "plan") {
            handlers.onPlan?.(payload.plan as AssistantPlan | null);
            return;
        }
        if (payload.type === "lifecycle") {
            handlers.onLifecycle?.(payload as unknown as AgentLifecycleEvent);
            return;
        }
        if (payload.type === "agent_end") {
            return;
        }
        if (payload.type === "observer_error") {
            detached = typeof payload.reason === "string" && payload.reason ? payload.reason : "interrupted";
            return;
        }
        if (payload.type === "turn_end") {
            settled = true;
            const rawTurnEnd = payload as unknown as AgentTurnEnd;
            turnEnd = Array.isArray(rawTurnEnd.proposals)
                ? { ...rawTurnEnd, proposals: rawTurnEnd.proposals.map(normalizeAssistantProposal) }
                : rawTurnEnd;
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
    return { settled, turnEnd, malformedLine, detached };
}

/**
 * 请求停止一次发送；不带 target 时停止当前画布正在进行的回合。
 *
 * 停止失败必须如实抛出：只 await fetch 会把 404/5xx 当成「已停止」，
 * 让界面显示与真实运行状态不一致。
 */
export async function cancelAgentChat(canvasId: string, target?: { sessionId: string; requestId: string }): Promise<AgentCancelState | undefined> {
    const token = await ensureAgentUiSession();
    const response = await fetch(`${apiBaseURL}/assistant/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Beeftv-Ui-Session": token },
        body: JSON.stringify(target ? { canvasId, sessionId: target.sessionId, requestId: target.requestId } : { canvasId }),
    });
    const text = await response.text().catch(() => "");
    type CancelPayload = { code?: number; reason?: string; data?: { state?: AgentCancelState } };
    let payload: CancelPayload | null = null;
    try { payload = JSON.parse(text) as CancelPayload; } catch { payload = null; }
    if (response.status === 403) resetAgentUiSessionIfMatches(token);
    const businessFailed = payload !== null && typeof payload.code === "number" && payload.code !== 0;
    if (!response.ok || businessFailed) {
        throw new Error(agentAssistantFailureText(payload?.reason, "停止失败，请再试一次"));
    }
    return payload?.data?.state;
}

/** 补充已有回合，新增素材仍由后端校验授权，不创建新生成请求。 */
export async function steerAgentChat(canvasId: string, sessionId: string, message: string, input: Pick<AgentChatRequest, "attachments" | "references" | "skills"> = {}): Promise<void> {
    const token = await ensureAgentUiSession();
    const response = await fetch(`${apiBaseURL}/assistant/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Beeftv-Ui-Session": token },
        body: JSON.stringify({
            canvasId,
            sessionId,
            message,
            ...(input.references?.length ? { references: input.references } : {}),
            ...(input.attachments?.length ? { attachments: input.attachments.map(attachmentRequestValue) } : {}),
            ...(input.skills?.length ? { skills: input.skills.map(({ skillId, versionId, contentHash }) => ({ skillId, versionId, contentHash })) } : {}),
        }),
    });
    let payload: { code?: number; reason?: string; data?: { accepted?: boolean } } | null = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (response.status === 403) resetAgentUiSessionIfMatches(token);
    if (!response.ok || payload?.code !== 0 || payload?.data?.accepted !== true) {
        throw new Error(agentAssistantFailureText(payload?.reason, "未能确认助手收到补充要求，原任务仍会保留。请查看最新回复后再决定是否发送。"));
    }
}
