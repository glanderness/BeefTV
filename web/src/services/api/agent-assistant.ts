// 内置创作助手：浏览器只与同源 Go 代理通信，宿主/owner/模型凭据都不进入页面。
// 三个端点的真实路径都在 /api/assistant/* 下；写错路径会让面板永远拿不到回复。
import { ApiError, http } from "./request";
import {
    assistantMutationConfig,
    assistantReadConfig,
    ensureAgentUiSession,
    resetAgentUiSession,
    uiSessionConfig,
} from "./agent-assistant-session";
import {
    ASSISTANT_STATUS_TIMEOUT_MS,
    agentAssistantFailureText,
    assistantThinkingLevel,
    normalizeAssistantProposal,
    type AgentHostStatus,
    type AssistantContextUsage,
    type AssistantGenerationProposal,
    type AssistantHistory,
    type AssistantScriptProposal,
    type AssistantScriptRunResult,
    type AssistantSessionList,
    type AssistantThinkingLevel,
    type AssistantUndoFailure,
    type AssistantUndoResult,
    type GenerationOrder,
} from "./agent-assistant-types";

export * from "./agent-assistant-types";
export { ensureAgentUiSession, resetAgentUiSession };
export { streamAgentChat, cancelAgentChat, steerAgentChat } from "./agent-assistant-stream";

// 与服务端技能脚本最大超时一致，另留出排队和结果回传时间。
const SKILL_SCRIPT_MAX_TIMEOUT_SEC = 1800;
const SKILL_SCRIPT_CONFIRM_TIMEOUT_MS = (SKILL_SCRIPT_MAX_TIMEOUT_SEC + 30) * 1000;
const PRODUCTION_CONFIRM_TIMEOUT_MS = 30_000;
const ASSISTANT_COMPACT_TIMEOUT_MS = 240_000;

export async function confirmAssistantScriptProposal(
    canvasId: string,
    turnId: string,
    proposalId: string,
    alwaysAllowSession = false,
) {
    const sessionConfig = await uiSessionConfig();
    return http.post<{
        proposal: AssistantScriptProposal;
        result: AssistantScriptRunResult;
        woken?: boolean;
        continuationMessage?: string;
    }>(
        `/assistant/turns/${encodeURIComponent(turnId)}/script-proposals/${encodeURIComponent(proposalId)}/run`,
        { canvasId, alwaysAllowSession },
        { ...sessionConfig, timeout: SKILL_SCRIPT_CONFIRM_TIMEOUT_MS },
    );
}

export async function confirmAssistantProduction(canvasId: string, turnId: string, proposal: AssistantGenerationProposal, continuePlan = false) {
    const normalized = normalizeAssistantProposal(proposal);
    return http.post<{ taskIds: string[]; continuationId: string; orderId?: string; order?: GenerationOrder }>(`/assistant/turns/${encodeURIComponent(turnId)}/proposals/${encodeURIComponent(normalized.proposalId)}/production`, {
        canvasId, kind: normalized.kind, nodeIds: normalized.nodeIds, targets: normalized.production?.targets, continuePlan,
        ...(normalized.regenerate ? { regenerate: true } : {}),
    }, { ...(await uiSessionConfig()), timeout: PRODUCTION_CONFIRM_TIMEOUT_MS });
}

export async function autoConfirmAssistantProduction(canvasId: string, turnId: string, proposal: AssistantGenerationProposal, continuePlan = false) {
    const normalized = normalizeAssistantProposal(proposal);
    return http.post<{
        taskIds: string[];
        continuationId?: string;
        orderId?: string;
        order?: GenerationOrder;
        autoConfirmed?: boolean;
        estimatedCny?: number;
        sessionSpentCny?: number;
        limitCny?: number;
    }>(`/assistant/turns/${encodeURIComponent(turnId)}/proposals/${encodeURIComponent(normalized.proposalId)}/auto-confirm`, {
        canvasId, kind: normalized.kind, nodeIds: normalized.nodeIds, targets: normalized.production?.targets, continuePlan,
        ...(normalized.regenerate ? { regenerate: true } : {}),
    }, { ...(await uiSessionConfig()), timeout: PRODUCTION_CONFIRM_TIMEOUT_MS });
}

export async function listGenerationOrders(canvasId: string) {
    return http.get<{ orders: GenerationOrder[] }>(`/assistant/generation-orders?canvasId=${encodeURIComponent(canvasId)}`, await uiSessionConfig());
}

export async function approveGenerationOrder(proposalId: string) {
    return http.post<{ taskIds: string[]; continuationId?: string; order?: GenerationOrder }>(`/assistant/generation-orders/${encodeURIComponent(proposalId)}/approve`, {}, { ...(await uiSessionConfig()), timeout: PRODUCTION_CONFIRM_TIMEOUT_MS });
}

export async function getAgentHostStatus(options?: { signal?: AbortSignal }): Promise<AgentHostStatus> {
    const data = await http.get<AgentHostStatus>("/assistant/status", {
        timeout: ASSISTANT_STATUS_TIMEOUT_MS,
        signal: options?.signal,
    });
    return data;
}

/** 重新拉起助手运行环境。失败必须抛出，界面才不会把「没启动」显示成「已就绪」。 */
export async function restartAgentHost(): Promise<void> {
    await http.post<{ restarted: boolean }>("/assistant/host/restart", {}, await assistantMutationConfig());
}

/** 读取失败必须与空历史区分，由界面保留原内容并提供重新读取。 */
export async function listAssistantSessions(canvasId: string): Promise<AssistantSessionList> {
    return http.get<AssistantSessionList>(`/assistant/sessions?canvasId=${encodeURIComponent(canvasId)}`, await assistantReadConfig());
}

export async function createAssistantSession(canvasId: string): Promise<string | null> {
    const data = await http.post<{ sessionId: string }>("/assistant/sessions", { canvasId }, await assistantMutationConfig());
    if (!data?.sessionId) throw new Error("没能新建对话，请重试");
    return data.sessionId;
}

export async function activateAssistantSession(canvasId: string, sessionId: string): Promise<string | null> {
    const data = await http.post<{ sessionId: string }>("/assistant/sessions/activate", { canvasId, sessionId }, await assistantMutationConfig());
    if (!data?.sessionId) throw new Error("没能切换对话，请重试");
    return data.sessionId;
}

export async function forkAssistantSession(canvasId: string, sessionId: string, turnId: string): Promise<{ sessionId: string; conversationId?: number; turnCount?: number }> {
    const data = await http.post<{ sessionId: string; conversationId?: number; turnCount?: number }>(
        "/assistant/sessions/fork",
        { canvasId, sessionId, turnId },
        await assistantMutationConfig(),
    );
    if (!data?.sessionId) throw new Error("没能创建分支对话，请重试");
    return data;
}

export async function deleteAssistantSession(canvasIdOrSessionId: string, maybeSessionId?: string): Promise<{ deleted: boolean; sessionId: string; currentSessionId: string | null }> {
    const hasCanvas = typeof maybeSessionId === "string";
    const canvasId = hasCanvas ? canvasIdOrSessionId : "";
    const sessionId = hasCanvas ? maybeSessionId : canvasIdOrSessionId;
    const query = canvasId ? `?canvasId=${encodeURIComponent(canvasId)}` : "";
    return http.delete<{ deleted: boolean; sessionId: string; currentSessionId: string | null }>(
        `/assistant/sessions/${encodeURIComponent(sessionId)}${query}`,
        await assistantMutationConfig(),
    );
}

export async function getAssistantHistory(canvasId: string, sessionId?: string): Promise<AssistantHistory> {
    const query = new URLSearchParams({ canvasId });
    if (sessionId) query.set("sessionId", sessionId);
    const data = await http.get<AssistantHistory>(`/assistant/history?${query.toString()}`, await assistantReadConfig());
    if (!data || !Array.isArray(data.turns)) throw new Error("没能读取对话，请重试");
    return {
        sessionId: data.sessionId || sessionId || "",
        active: data.active,
        plan: data.plan ?? null,
        pausedTurnReason: data.pausedTurnReason ?? null,
        thinkingLevel: data.thinkingLevel ? assistantThinkingLevel(data.thinkingLevel) : undefined,
        contextUsage: data.contextUsage ?? null,
        forkedFrom: data.forkedFrom ?? null,
        turns: data.turns.map((turn) => ({
            ...turn,
            proposals: Array.isArray(turn.proposals) ? turn.proposals.map(normalizeAssistantProposal) : [],
            error: turn.error ? agentAssistantFailureText(turn.errorReason ?? undefined, "这一轮没有全部完成，请核对已经落地的改动。") : null,
        })),
    };
}

export async function configureAssistantSession(
    canvasId: string,
    thinkingLevel: AssistantThinkingLevel,
    sessionId?: string,
): Promise<{ sessionId: string; thinkingLevel: AssistantThinkingLevel; contextUsage?: AssistantContextUsage | null }> {
    return http.post(
        "/assistant/session-config",
        { canvasId, ...(sessionId ? { sessionId } : {}), thinkingLevel },
        await assistantMutationConfig(),
    );
}

export async function compactAssistantSession(
    canvasId: string,
    sessionId?: string,
    instructions?: string,
): Promise<{ sessionId: string; compacted: boolean; entryId?: number | null; thinkingLevel?: AssistantThinkingLevel; contextUsage?: AssistantContextUsage | null }> {
    const sessionConfig = await uiSessionConfig();
    return http.post(
        "/assistant/compact",
        {
            canvasId,
            ...(sessionId ? { sessionId } : {}),
            ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
        },
        { ...sessionConfig, timeout: ASSISTANT_COMPACT_TIMEOUT_MS },
    );
}

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

/** 已撤销的一轮不再开始生成；这是后端给出的唯一判定，界面隐藏按钮只是提示。 */
export const ASSISTANT_PROPOSAL_UNDONE_TEXT = "这一轮已撤销，不会生成。";
export const ASSISTANT_PROPOSAL_INVALIDATED_TEXT = "已失效，请让助手重新提出生成方案。";

/**
 * 开始生成前由后端确认生成建议所属的一轮仍然有效。
 * 返回 null 表示可以继续；否则返回给用户看的一句话，不会提交任何生成。
 */
export async function confirmAssistantProposalRunnable(turnId: string, proposalId: string, canvasId: string): Promise<string | null> {
    try {
        await http.post<{ runnable: boolean }>(`/assistant/turns/${encodeURIComponent(turnId)}/proposals/${encodeURIComponent(proposalId)}/run`, { canvasId }, await uiSessionConfig());
        return null;
    } catch (error) {
        const reason = error instanceof ApiError ? error.reason : undefined;
        if (reason === "turn_undone") return ASSISTANT_PROPOSAL_UNDONE_TEXT;
        if (reason === "continuation_intent_changed") return ASSISTANT_PROPOSAL_INVALIDATED_TEXT;
        if (reason === "turn_not_found") return "找不到这一轮对话，未提交生成。请让助手重新提出方案。";
        return "无法确认这项生成是否还能进行，未提交生成。请检查连接后重试。";
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
