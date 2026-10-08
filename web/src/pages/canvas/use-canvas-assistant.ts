import { Grid } from "antd";
import { useCallback, useEffect, useRef, useState, useMemo, useSyncExternalStore } from "react";

import { ApiError } from "@/services/api/request";
import { scopedLocalStorage, getActiveUserScope, getActiveUserScopeEpoch, subscribeUserScope } from "@/lib/user-scope";
import { captureUserScope, userScopeMatches, assertUserScope } from "@/lib/user-scope-guard";
import { flushModelConfig, getModelConfigPersistenceState } from "@/services/model-config-repository";
import { workspaceCapabilities } from "@/services/workspace-mode";
import {
    activateAssistantSession,
    agentAssistantFailureText,
    assistantPermissionMode,
    AgentTurnFailedError,
    AgentChatNotAdmittedError,
    cancelAgentChat,
    createAssistantSession,
    getAgentHostStatus,
    getAssistantHistory,
    listAssistantSessions,
    restartAgentHost,
    streamAgentChat,
    steerAgentChat,
    undoAssistantTurn,
    type AgentChatReference,
    type AssistantAttachment,
    type AssistantSkillSelection,
    type AssistantPermissionMode,
    type AgentHostStatus,
    type AssistantSessionSummary,
    type AssistantTurn,
    type AssistantUndoFailure,
} from "@/services/api/agent-assistant";
import { assistantChangedNodeIds, assistantLifecycleText } from "./canvas-assistant-copy";
import { waitForAssistant } from "./assistant-readiness";
import { findRecoveredAssistantTurn, type PendingAssistantRecovery } from "./canvas-assistant-recovery";

export const ASSISTANT_MIN_WIDTH = 320;
export const ASSISTANT_MAX_WIDTH = 560;
export const ASSISTANT_DEFAULT_WIDTH = 380;
/** 停靠宽度以下改成覆盖式抽屉：与版本记录侧栏共用同一个折返宽度。 */
export const ASSISTANT_DOCK_MIN_SHELL_WIDTH = 1050;

const OPEN_STORAGE_KEY = "canvas:assistant-open";
const WIDTH_STORAGE_KEY = "canvas:assistant-width";
const PERMISSION_STORAGE_KEY = "canvas:assistant-permission";
const PROPOSAL_STORAGE_KEY = "canvas:assistant-proposals";
const PROPOSAL_MEMORY = 200;

/** 已决定过的提议只记一个键：同意用 proposalId，谢绝加后缀，两种结果不会互相冒充。 */
export function dismissedProposalKey(proposalId: string) {
    return `${proposalId}:skipped`;
}

export type CanvasRightPanel = "assistant" | "versions" | null;

/**
 * 画布右侧只有一个栏位：版本记录一旦打开就占住它。
 * 渲染两侧都读这一个判断，避免出现两块面板同时挤压画布。
 */
export function resolveCanvasRightPanel(assistantOpen: boolean, versionsOpen: boolean): CanvasRightPanel {
    if (versionsOpen) return "versions";
    return assistantOpen ? "assistant" : null;
}

export function clampAssistantWidth(width: number) {
    if (!Number.isFinite(width)) return ASSISTANT_DEFAULT_WIDTH;
    return Math.min(ASSISTANT_MAX_WIDTH, Math.max(ASSISTANT_MIN_WIDTH, Math.round(width)));
}

export type AssistantTurnStatus = {
    undoing?: boolean;
    undone?: boolean;
    undoFailure?: AssistantUndoFailure;
};

type CanvasRun = {
    sessionId: string | null;
    sessions: AssistantSessionSummary[];
    turns: AssistantTurn[];
    historyLoaded: boolean;
    historyError: string | null;
    historyHostUnavailable: boolean;
    historyRequest: number;
    sessionBusy: boolean;
    dispatched: boolean;
    backgroundActive: boolean;
    recovery: PendingAssistantRecovery | null;
    pendingUserText: string | null;
    pendingSelectedNodeIds: string[];
    pendingAttachments: AssistantAttachment[];
    pendingSkills: AssistantSkillSelection[];
    pendingPermissionMode: AssistantPermissionMode | null;
    streamed: string;
    streaming: boolean;
    lifecycleNotice: string | null;
    supplementBusy: boolean;
    supplements: { text: string; status: "sending" | "accepted" | "unconfirmed"; attachments?: AssistantAttachment[]; skills?: AssistantSkillSelection[] }[];
    controller: AbortController | null;
    error: string | null;
    lastSent: { text: string; selectedNodeIds: string[]; references: AgentChatReference[]; attachments?: AssistantAttachment[]; skills?: AssistantSkillSelection[]; permissionMode: AssistantPermissionMode } | null;
    turnStatus: Record<string, AssistantTurnStatus>;
};

const createRun = (): CanvasRun => ({
    sessionId: null,
    sessions: [],
    turns: [],
    historyLoaded: false,
    historyError: null,
    historyHostUnavailable: false,
    historyRequest: 0,
    sessionBusy: false,
    dispatched: false,
    backgroundActive: false,
    recovery: null,
    pendingUserText: null,
    pendingSelectedNodeIds: [],
    pendingAttachments: [],
    pendingSkills: [],
    pendingPermissionMode: null,
    streamed: "",
    streaming: false,
    lifecycleNotice: null,
    supplementBusy: false,
    supplements: [],
    controller: null,
    error: null,
    lastSent: null,
    turnStatus: {},
});

type Options = {
    canvasId: string;
    /** 回合落地后画布要立刻拉取最新内容，并把改动过的节点高亮出来。 */
    onCanvasChanged?: (canvasId: string, changedNodeIds: string[]) => void;
};

function readStoredProposals(): Set<string> {
    try {
        const raw = scopedLocalStorage.getItem(PROPOSAL_STORAGE_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
    } catch {
        return new Set();
    }
}

/**
 * 画布内助手的全部状态。
 *
 * 每个画布各持一条运行记录：发送时冻结画布归属，异步结果只写回当时那条记录，
 * 切画布不会把回复落到别的画布上。已结束的回合来自服务端历史，刷新页面不丢。
 */
export function useCanvasAssistant({ canvasId, onCanvasChanged }: Options) {
    const [open, setOpenState] = useState(() => scopedLocalStorage.getItem(OPEN_STORAGE_KEY) !== "0");
    const [width, setWidthState] = useState(() => clampAssistantWidth(Number(scopedLocalStorage.getItem(WIDTH_STORAGE_KEY)) || ASSISTANT_DEFAULT_WIDTH));
    const [status, setStatus] = useState<AgentHostStatus | null>(null);
    const [statusBusy, setStatusBusy] = useState(false);
    const [handledProposals, setHandledProposals] = useState<Set<string>>(readStoredProposals);
    const [, forceRender] = useState(0);

    const accountIdentity = useSyncExternalStore(subscribeUserScope, () => JSON.stringify([getActiveUserScope(), getActiveUserScopeEpoch()]), () => "");
    const expectedScope = useMemo(() => captureUserScope(), [accountIdentity]);
    const [permissionPreference, setPermissionPreference] = useState(() => ({ accountIdentity, mode: assistantPermissionMode(scopedLocalStorage.getItem(PERMISSION_STORAGE_KEY)) }));
    const preferredPermissionMode = permissionPreference.accountIdentity === accountIdentity ? permissionPreference.mode : assistantPermissionMode(scopedLocalStorage.getItem(PERMISSION_STORAGE_KEY));
    const runPrefix = `${accountIdentity}:`;
    const runsRef = useRef<Map<string, CanvasRun>>(new Map());
    const activeCanvasRef = useRef(canvasId);
    activeCanvasRef.current = canvasId;
    const onCanvasChangedRef = useRef(onCanvasChanged);
    onCanvasChangedRef.current = onCanvasChanged;

    const runFor = useCallback((id: string): CanvasRun => {
        const key = runPrefix + id;
        const existing = runsRef.current.get(key);
        if (existing) return existing;
        const created = createRun();
        runsRef.current.set(key, created);
        return created;
    }, [runPrefix]);

    const rerenderIfActive = useCallback((id: string) => {
        if (userScopeMatches(expectedScope) && activeCanvasRef.current === id) forceRender((value) => value + 1);
    }, [expectedScope]);

    const setPermissionMode = useCallback((mode: AssistantPermissionMode) => {
        if (!userScopeMatches(expectedScope)) return;
        const run = runFor(activeCanvasRef.current);
        if (run.streaming || run.recovery || run.sessionBusy) return;
        const selected = assistantPermissionMode(mode);
        scopedLocalStorage.setItem(PERMISSION_STORAGE_KEY, selected);
        setPermissionPreference({ accountIdentity, mode: selected });
    }, [accountIdentity, expectedScope, runFor]);

    useEffect(() => {
        setStatus(null);
        setStatusBusy(false);
        setHandledProposals(readStoredProposals());
        setOpenState(scopedLocalStorage.getItem(OPEN_STORAGE_KEY) !== "0");
        setWidthState(clampAssistantWidth(Number(scopedLocalStorage.getItem(WIDTH_STORAGE_KEY)) || ASSISTANT_DEFAULT_WIDTH));
        return () => {
            for (const [key, run] of runsRef.current) {
                if (!key.startsWith(runPrefix)) continue;
                ++run.historyRequest;
                // Detach the old browser observer; durable work is stopped only by explicit Stop.
                run.controller?.abort();
                runsRef.current.delete(key);
            }
        };
    }, [runPrefix]);

    const setOpen = useCallback((next: boolean) => {
        if (!userScopeMatches(expectedScope)) return;
        setOpenState(next);
        scopedLocalStorage.setItem(OPEN_STORAGE_KEY, next ? "1" : "0");
    }, [expectedScope]);

    const setWidth = useCallback((next: number) => {
        if (!userScopeMatches(expectedScope)) return;
        const clamped = clampAssistantWidth(next);
        setWidthState(clamped);
        scopedLocalStorage.setItem(WIDTH_STORAGE_KEY, String(clamped));
    }, [expectedScope]);

    // 状态只在面板打开时复查：关着的面板不该一直问后端。正在启动时节奏更快。
    const starting = status?.reason === "host_starting";
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        const refresh = () => {
            getAgentHostStatus()
                .then((value) => { if (!cancelled && userScopeMatches(expectedScope)) setStatus(value); })
                .catch(() => { if (!cancelled && userScopeMatches(expectedScope)) setStatus({ available: false }); });
        };
        refresh();
        const timer = setInterval(refresh, starting ? 2000 : 15000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [open, starting, expectedScope]);

    const loadHistory = useCallback(async (targetCanvas: string, sessionId?: string) => {
        if (!userScopeMatches(expectedScope)) return false;
        const run = runFor(targetCanvas);
        const request = ++run.historyRequest;
        try {
            const [sessionList, history] = await Promise.all([
                listAssistantSessions(targetCanvas),
                getAssistantHistory(targetCanvas, sessionId),
            ]);
            if (!userScopeMatches(expectedScope) || request !== run.historyRequest) return false;
            const nextSession = sessionId || history.sessionId || sessionList.currentSessionId || null;
            const known = new Set(history.turns.map((turn) => turn.turnId));
            const recent = nextSession === run.sessionId ? run.turns.filter((turn) => !known.has(turn.turnId)) : [];
            if (findRecoveredAssistantTurn(run.recovery, history)) {
                run.pendingUserText = null;
                run.pendingSelectedNodeIds = [];
                run.pendingAttachments = [];
                run.pendingSkills = [];
                run.pendingPermissionMode = null;
                run.streamed = "";
                run.error = null;
                run.recovery = null;
                run.backgroundActive = false;
                run.lifecycleNotice = null;
                run.supplements = [];
                if (!run.controller) run.streaming = false;
            }
            if (history.active) {
                const active = history.active;
                run.backgroundActive = true;
                run.streaming = true;
                run.dispatched = true;
                run.pendingUserText = active.userText;
                run.pendingSelectedNodeIds = active.selectedNodeIds || [];
                run.pendingAttachments = active.attachments || [];
                run.pendingSkills = active.skills || [];
                run.pendingPermissionMode = assistantPermissionMode(active.permissionMode);
                run.supplements = active.supplementInputs?.length ? active.supplementInputs.map(input => ({ text: input.message, attachments: input.attachments, skills: input.skills, status: "accepted" })) : (active.supplements || []).map(text => ({ text, status: "accepted" }));
                run.recovery = { sessionId: nextSession, turnId: active.turnId, knownTurnIds: history.turns.map(turn => turn.turnId), text: active.userText, selectedNodeIds: active.selectedNodeIds || [] };
                run.lifecycleNotice = "这次创作仍在继续，正在读取最新结果。";
                run.error = null;
            }
            run.sessions = sessionList.sessions;
            run.sessionId = nextSession;
            run.turns = [...history.turns, ...recent];
            for (const turn of history.turns) {
                if (turn.undone) run.turnStatus[turn.turnId] = { undone: true };
            }
            run.historyLoaded = true;
            run.historyError = null;
            run.historyHostUnavailable = false;
            return true;
        } catch (error) {
            if (userScopeMatches(expectedScope) && request === run.historyRequest) {
                run.historyHostUnavailable = error instanceof ApiError && (error.reason === "host_unreachable" || error.reason === "model_not_configured");
                run.historyError = run.turns.length || run.pendingUserText || run.pendingAttachments.length || run.streamed
                    ? "没能读取对话，已有内容仍然保留。请重新读取。" : "没能读取对话。请重新读取。";
            }
            return false;
        } finally {
            rerenderIfActive(targetCanvas);
        }
    }, [rerenderIfActive, runFor, expectedScope]);

    // 打开面板或切画布时补齐这条画布的历史；已经载入过就不重复拉。
    useEffect(() => {
        if (!open) return;
        let reading = false;
        const timer = setInterval(() => {
            const run = runFor(canvasId);
            if (reading || run.controller || (!run.backgroundActive && !run.recovery)) return;
            reading = true;
            void loadHistory(canvasId).finally(() => { reading = false; });
        }, 2000);
        return () => clearInterval(timer);
    }, [canvasId, loadHistory, open, runFor]);

    useEffect(() => {
        if (!open) return;
        const run = runFor(canvasId);
        if (run.historyLoaded || run.streaming || run.sessionBusy) return;
        void loadHistory(canvasId);
    }, [canvasId, loadHistory, open, runFor, status?.available]);

    const send = useCallback(async (text: string, selectedNodeIds: string[], references: AgentChatReference[] = [], input: { attachments?: AssistantAttachment[]; skills?: AssistantSkillSelection[]; permissionMode?: AssistantPermissionMode } = {}) => {
        if (!userScopeMatches(expectedScope)) return;
        const message = text.trim();
        if (!message && !input.attachments?.length) return;
        // 发送时冻结归属：此后即使用户切到别的画布，结果也只写回这条记录。
        const targetCanvas = activeCanvasRef.current;
        const selectedSnapshot = [...selectedNodeIds];
        const referenceSnapshot = references.map((reference) => ({ ...reference }));
        const attachments = (input.attachments || []).map(item => ({ ...item }));
        const skills = (input.skills || []).map(item => ({ ...item }));
        const run = runFor(targetCanvas);
        if (run.streaming) {
            if (!run.dispatched || !run.sessionId || run.supplementBusy) return;
            const supplement = { text: message, attachments, skills, status: "sending" as "sending" | "accepted" | "unconfirmed" };
            run.supplements.push(supplement);
            run.supplementBusy = true;
            rerenderIfActive(targetCanvas);
            try {
                await steerAgentChat(targetCanvas, run.sessionId, message, { attachments, skills, references: referenceSnapshot });
                supplement.status = "accepted";
            } catch {
                supplement.status = "unconfirmed";
            } finally {
                run.supplementBusy = false;
                rerenderIfActive(targetCanvas);
            }
            return;
        }
        if (run.recovery) return;
        if (run.sessionBusy || run.supplementBusy) return;
        const permissionMode = assistantPermissionMode(input.permissionMode ?? preferredPermissionMode);
        const controller = new AbortController();
        run.pendingUserText = message;
        run.pendingSelectedNodeIds = selectedSnapshot;
        run.pendingAttachments = attachments;
        run.pendingSkills = skills;
        run.pendingPermissionMode = permissionMode;
        run.streamed = "";
        run.streaming = true;
        run.lifecycleNotice = null;
        run.supplements = [];
        run.controller = controller;
        run.error = null;
        run.dispatched = false;
        run.backgroundActive = false;
        run.recovery = null;
        run.lastSent = { text: message, selectedNodeIds: selectedSnapshot, references: referenceSnapshot, attachments, skills, permissionMode };
        rerenderIfActive(targetCanvas);
        try {
            if (workspaceCapabilities().local) {
                await flushModelConfig();
                const persistence = getModelConfigPersistenceState();
                if (persistence.dirty || persistence.status === "error") throw new Error("助手模型还没保存成功，请稍后重试");
            }
            controller.signal.throwIfAborted();
            const ready = await waitForAssistant(controller.signal);
            assertUserScope(expectedScope);
            setStatus(ready);
            if (!run.historyLoaded && !await loadHistory(targetCanvas)) throw new Error("对话还没读回来，请重新读取后再发送");
            assertUserScope(expectedScope);
            if (!run.sessionId) run.sessionId = await createAssistantSession(targetCanvas);
            assertUserScope(expectedScope);
            controller.signal.throwIfAborted();
            run.recovery = { sessionId: run.sessionId, knownTurnIds: run.turns.map((turn) => turn.turnId), text: message, selectedNodeIds: selectedSnapshot };
            run.dispatched = true;
            await streamAgentChat(targetCanvas, message, {
                onDelta: (delta) => {
                    if (!userScopeMatches(expectedScope)) return;
                    const current = runFor(targetCanvas);
                    current.streamed += delta;
                    rerenderIfActive(targetCanvas);
                },
                onLifecycle: (event) => {
                    if (!userScopeMatches(expectedScope)) return;
                    const current = runFor(targetCanvas);
                    current.lifecycleNotice = assistantLifecycleText(event);
                    rerenderIfActive(targetCanvas);
                },
                onTurnEnd: (end) => {
                    if (!userScopeMatches(expectedScope)) return;
                    const current = runFor(targetCanvas);
                    const turn: AssistantTurn = {
                        turnId: end.turnId || `${targetCanvas}:${Date.now()}`,
                        permissionMode: assistantPermissionMode(end.permissionMode),
                        userText: message,
                        selectedNodeIds: selectedSnapshot,
                        reply: end.reply || current.streamed,
                        toolCalls: end.toolCalls || [],
                        change: end.change ?? null,
                        proposals: end.proposals || [],
                        error: end.error ? agentAssistantFailureText(end.errorReason ?? undefined, "这一轮没有全部完成，请核对已经落地的改动。") : null,
                        errorReason: end.errorReason,
                        cancelled: Boolean(end.cancelled),
                        supplements: end.supplements || current.supplements.filter(item => item.status === "accepted").map(item => item.text),
                        attachments: end.attachments || attachments,
                        skills: end.skills || skills,
                        supplementInputs: end.supplementInputs || current.supplements.filter(item => item.status === "accepted").map(item => ({ message: item.text, attachments: item.attachments, skills: item.skills })),
                        createdAt: new Date().toISOString(),
                    };
                    current.turns = [...current.turns, turn];
                    current.recovery = null;
                    current.backgroundActive = false;
                    current.historyError = null;
                    current.pendingUserText = null;
                    current.pendingSelectedNodeIds = [];
                    current.pendingAttachments = [];
                    current.pendingSkills = [];
                    current.pendingPermissionMode = null;
                    current.streamed = "";
                    current.lifecycleNotice = null;
                    if (turn.change?.canvasChanges?.length) {
                        for (const changed of turn.change.canvasChanges) onCanvasChangedRef.current?.(changed.canvasId, assistantChangedNodeIds(changed));
                    } else onCanvasChangedRef.current?.(targetCanvas, assistantChangedNodeIds(turn.change));
                    rerenderIfActive(targetCanvas);
                },
            }, { signal: controller.signal, selectedNodeIds: selectedSnapshot, references: referenceSnapshot, sessionId: run.sessionId ?? undefined, attachments, skills, permissionMode });
        } catch (streamError) {
            if (!userScopeMatches(expectedScope)) return;
            if (streamError instanceof AgentTurnFailedError) {
                // onTurnEnd 已保存真实失败及画布变化，不再额外显示「结果未知」或触发重放。
                runFor(targetCanvas).error = null;
                rerenderIfActive(targetCanvas);
                return;
            }
            // 用户点「停止」会以 AbortError 结束这次请求：这是预期结果，不当成失败。
            const aborted = streamError instanceof DOMException && streamError.name === "AbortError";
            const current = runFor(targetCanvas);
            if (streamError instanceof AgentChatNotAdmittedError) {
                current.dispatched = false;
                current.recovery = null;
            }
            // 停止和断线都先保留已显示的内容；只在读取到本轮回执后替换。
            current.lifecycleNotice = null;
            current.error = aborted ? null : current.dispatched
                ? "这一轮未能确认完成，可能已有改动。请先查看画布并重新读取对话，再决定下一步。"
                : streamError instanceof Error ? streamError.message : String(streamError);
            if (current.dispatched) {
                onCanvasChangedRef.current?.(targetCanvas, []);
                void loadHistory(targetCanvas);
            }
            rerenderIfActive(targetCanvas);
        } finally {
            if (!userScopeMatches(expectedScope)) return;
            const current = runFor(targetCanvas);
            current.streaming = current.backgroundActive;
            current.lifecycleNotice = null;
            current.controller = null;
            rerenderIfActive(targetCanvas);
            void listAssistantSessions(targetCanvas).then((list) => {
                if (!userScopeMatches(expectedScope)) return;
                const latest = runFor(targetCanvas);
                latest.sessions = list.sessions;
                if (!latest.sessionId) latest.sessionId = list.currentSessionId;
                rerenderIfActive(targetCanvas);
            }).catch(() => { /* 会话列表读取失败不覆盖本轮结果；重新读取入口仍可用。 */ });
        }
    }, [loadHistory, rerenderIfActive, runFor, expectedScope, preferredPermissionMode]);

    // 停止只作用于当前正在查看的画布，不会取消别的画布。
    const stop = useCallback(async () => {
        if (!userScopeMatches(expectedScope)) return;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        run.controller?.abort();
        if (!run.dispatched) return;
        try {
            await cancelAgentChat(targetCanvas);
            if (!userScopeMatches(expectedScope)) return;
            await loadHistory(targetCanvas);
        } catch (cancelError) {
            if (!userScopeMatches(expectedScope)) return;
            run.error = cancelError instanceof Error ? cancelError.message : String(cancelError);
            rerenderIfActive(targetCanvas);
        }
    }, [loadHistory, rerenderIfActive, runFor, expectedScope]);

    const retryLast = useCallback(() => {
        const run = runFor(activeCanvasRef.current);
        if (!run.lastSent || run.dispatched) return;
        void send(run.lastSent.text, run.lastSent.selectedNodeIds, run.lastSent.references, { attachments: run.lastSent.attachments, skills: run.lastSent.skills, permissionMode: run.lastSent.permissionMode });
    }, [runFor, send]);

    const dismissError = useCallback(() => {
        const run = runFor(activeCanvasRef.current);
        run.error = null;
        run.pendingUserText = null;
        run.pendingSelectedNodeIds = [];
        rerenderIfActive(activeCanvasRef.current);
    }, [rerenderIfActive, runFor, expectedScope]);

    const startNewSession = useCallback(async () => {
        if (!userScopeMatches(expectedScope)) return;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        if (run.streaming || run.sessionBusy) return;
        run.sessionBusy = true;
        ++run.historyRequest;
        rerenderIfActive(targetCanvas);
        try {
            const sessionId = await createAssistantSession(targetCanvas);
            if (!userScopeMatches(expectedScope)) return;
            run.sessionId = sessionId;
            run.recovery = null;
            run.turns = [];
            run.error = null;
            run.pendingUserText = null;
            run.lastSent = null;
            run.turnStatus = {};
            run.historyLoaded = true;
            run.historyError = null;
            void loadHistory(targetCanvas);
        } catch {
            run.error = "没能新建对话，当前对话仍然保留。请重试。";
        } finally {
            run.sessionBusy = false;
            rerenderIfActive(targetCanvas);
        }
    }, [loadHistory, rerenderIfActive, runFor, expectedScope]);

    const activateSession = useCallback(async (sessionId: string) => {
        if (!userScopeMatches(expectedScope)) return;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        if (run.streaming || run.sessionBusy) return;
        run.sessionBusy = true;
        ++run.historyRequest;
        rerenderIfActive(targetCanvas);
        try {
            const activated = await activateAssistantSession(targetCanvas, sessionId);
            if (!activated || !userScopeMatches(expectedScope)) return;
            // 激活成功但读取失败时阻止把旧显示当作新对话继续发送。
            run.historyLoaded = false;
            if (await loadHistory(targetCanvas, activated)) {
                run.recovery = null;
                run.turnStatus = {};
                run.error = null;
                run.lastSent = null;
                run.pendingUserText = null;
            }
        } catch {
            run.error = "没能切换对话，当前对话仍然保留。请重试。";
        } finally {
            run.sessionBusy = false;
            rerenderIfActive(targetCanvas);
        }
    }, [loadHistory, rerenderIfActive, runFor, expectedScope]);

    const undoTurn = useCallback(async (turnId: string) => {
        if (!userScopeMatches(expectedScope)) return;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        run.turnStatus = { ...run.turnStatus, [turnId]: { undoing: true } };
        rerenderIfActive(targetCanvas);
        const result = await undoAssistantTurn(turnId, targetCanvas);
        if (!userScopeMatches(expectedScope)) return;
        const next = runFor(targetCanvas);
        next.turnStatus = { ...next.turnStatus, [turnId]: result.ok ? { undone: true } : { undoFailure: result.failure } };
        rerenderIfActive(targetCanvas);
        if (result.ok) {
            const change = next.turns.find(turn => turn.turnId === turnId)?.change;
            const canvasIds = change?.canvasChanges?.length ? [...new Set(change.canvasChanges.map(item => item.canvasId))] : [targetCanvas];
            for (const id of canvasIds) onCanvasChangedRef.current?.(id, []);
        }
    }, [rerenderIfActive, runFor, expectedScope]);

    const restartHost = useCallback(async () => {
        if (!userScopeMatches(expectedScope)) return;
        setStatusBusy(true);
        try {
            await restartAgentHost();
            if (!userScopeMatches(expectedScope)) return;
            const nextStatus = await getAgentHostStatus();
            if (userScopeMatches(expectedScope)) setStatus(nextStatus);
        } catch {
            if (userScopeMatches(expectedScope)) setStatus({ available: false, reason: "host_start_failed" });
        } finally {
            if (userScopeMatches(expectedScope)) setStatusBusy(false);
        }
    }, [expectedScope]);

    const rememberProposal = useCallback((key: string) => {
        if (!userScopeMatches(expectedScope)) return;
        setHandledProposals((current) => {
            if (current.has(key)) return current;
            const next = new Set(current);
            next.add(key);
            const kept = [...next].slice(-PROPOSAL_MEMORY);
            scopedLocalStorage.setItem(PROPOSAL_STORAGE_KEY, JSON.stringify(kept));
            return new Set(kept);
        });
    }, [expectedScope]);
    const markProposalHandled = useCallback((proposalId: string) => rememberProposal(proposalId), [rememberProposal]);
    const markProposalDismissed = useCallback((proposalId: string) => rememberProposal(dismissedProposalKey(proposalId)), [rememberProposal]);

    const run = runFor(canvasId);

    return {
        canvasId,
        open,
        setOpen,
        width,
        setWidth,
        status,
        statusBusy,
        modelBusy: statusBusy || [...runsRef.current.entries()].some(([key, item]) => key.startsWith(runPrefix) && (item.streaming || item.sessionBusy)),
        sessions: run.sessions,
        sessionId: run.sessionId,
        turns: run.turns,
        historyLoaded: run.historyLoaded,
        historyError: status?.reason === "model_not_configured" && run.historyHostUnavailable && !run.turns.length && !run.pendingUserText && !run.pendingAttachments.length && !run.streamed ? null : run.historyError,
        sessionBusy: run.sessionBusy,
        reloadHistory: () => loadHistory(canvasId),
        pendingUserText: run.pendingUserText,
        pendingSelectedNodeIds: run.pendingSelectedNodeIds,
        pendingAttachments: run.pendingAttachments,
        pendingSkills: run.pendingSkills,
        permissionMode: run.streaming || run.recovery ? run.pendingPermissionMode ?? "canvas" : preferredPermissionMode,
        permissionLocked: run.streaming || Boolean(run.recovery) || run.sessionBusy,
        setPermissionMode,
        streamed: run.streamed,
        streaming: run.streaming,
        lifecycleNotice: run.lifecycleNotice,
        supplements: run.supplements,
        supplementBusy: run.supplementBusy,
        canSupplement: run.streaming && run.dispatched && Boolean(run.sessionId),
        awaitingReceipt: Boolean(run.recovery) && !run.streaming && !run.controller,
        error: run.error,
        canRetry: Boolean(run.lastSent) && !run.dispatched,
        turnStatus: run.turnStatus,
        handledProposals,
        markProposalHandled,
        markProposalDismissed,
        send,
        stop,
        retryLast,
        dismissError,
        startNewSession,
        activateSession,
        undoTurn,
        restartHost,
    };
}

export type CanvasAssistantController = ReturnType<typeof useCanvasAssistant>;

/**
 * 编辑器外壳够宽才做停靠栏；窄了改成覆盖式抽屉，不把画布挤到不能用。
 */
export function useCanvasAssistantDockable(shellRef: { current: HTMLElement | null }) {
    const desktop = Boolean(Grid.useBreakpoint().lg);
    const [wide, setWide] = useState(true);
    useEffect(() => {
        const element = shellRef.current;
        if (!element || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver((entries) => {
            const box = entries[0]?.contentRect;
            if (box) setWide(box.width >= ASSISTANT_DOCK_MIN_SHELL_WIDTH);
        });
        observer.observe(element);
        setWide(element.clientWidth >= ASSISTANT_DOCK_MIN_SHELL_WIDTH);
        return () => observer.disconnect();
    }, [shellRef]);
    return desktop && wide;
}
