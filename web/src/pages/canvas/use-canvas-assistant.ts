import { Grid } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

import { scopedLocalStorage } from "@/lib/user-scope";
import {
    activateAssistantSession,
    agentAssistantFailureText,
    AgentTurnFailedError,
    AgentChatNotAdmittedError,
    cancelAgentChat,
    createAssistantSession,
    getAgentHostStatus,
    getAssistantHistory,
    listAssistantSessions,
    restartAgentHost,
    streamAgentChat,
    undoAssistantTurn,
    type AgentChatReference,
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
    historyRequest: number;
    sessionBusy: boolean;
    dispatched: boolean;
    recovery: PendingAssistantRecovery | null;
    pendingUserText: string | null;
    pendingSelectedNodeIds: string[];
    streamed: string;
    streaming: boolean;
    lifecycleNotice: string | null;
    controller: AbortController | null;
    error: string | null;
    lastSent: { text: string; selectedNodeIds: string[]; references: AgentChatReference[] } | null;
    turnStatus: Record<string, AssistantTurnStatus>;
};

const createRun = (): CanvasRun => ({
    sessionId: null,
    sessions: [],
    turns: [],
    historyLoaded: false,
    historyError: null,
    historyRequest: 0,
    sessionBusy: false,
    dispatched: false,
    recovery: null,
    pendingUserText: null,
    pendingSelectedNodeIds: [],
    streamed: "",
    streaming: false,
    lifecycleNotice: null,
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

    const runsRef = useRef<Map<string, CanvasRun>>(new Map());
    const activeCanvasRef = useRef(canvasId);
    activeCanvasRef.current = canvasId;
    const onCanvasChangedRef = useRef(onCanvasChanged);
    onCanvasChangedRef.current = onCanvasChanged;

    const runFor = useCallback((id: string): CanvasRun => {
        const existing = runsRef.current.get(id);
        if (existing) return existing;
        const created = createRun();
        runsRef.current.set(id, created);
        return created;
    }, []);

    const rerenderIfActive = useCallback((id: string) => {
        if (activeCanvasRef.current === id) forceRender((value) => value + 1);
    }, []);

    const setOpen = useCallback((next: boolean) => {
        setOpenState(next);
        scopedLocalStorage.setItem(OPEN_STORAGE_KEY, next ? "1" : "0");
    }, []);

    const setWidth = useCallback((next: number) => {
        const clamped = clampAssistantWidth(next);
        setWidthState(clamped);
        scopedLocalStorage.setItem(WIDTH_STORAGE_KEY, String(clamped));
    }, []);

    // 状态只在面板打开时复查：关着的面板不该一直问后端。正在启动时节奏更快。
    const starting = status?.reason === "host_starting";
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        const refresh = () => {
            getAgentHostStatus()
                .then((value) => { if (!cancelled) setStatus(value); })
                .catch(() => { if (!cancelled) setStatus({ available: false }); });
        };
        refresh();
        const timer = setInterval(refresh, starting ? 2000 : 15000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [open, starting]);

    const loadHistory = useCallback(async (targetCanvas: string, sessionId?: string) => {
        const run = runFor(targetCanvas);
        const request = ++run.historyRequest;
        try {
            const [sessionList, history] = await Promise.all([
                listAssistantSessions(targetCanvas),
                getAssistantHistory(targetCanvas, sessionId),
            ]);
            if (request !== run.historyRequest) return false;
            const nextSession = sessionId || history.sessionId || sessionList.currentSessionId || null;
            const known = new Set(history.turns.map((turn) => turn.turnId));
            const recent = nextSession === run.sessionId ? run.turns.filter((turn) => !known.has(turn.turnId)) : [];
            if (run.error && findRecoveredAssistantTurn(run.recovery, history)) {
                run.pendingUserText = null;
                run.pendingSelectedNodeIds = [];
                run.error = null;
                run.recovery = null;
            }
            run.sessions = sessionList.sessions;
            run.sessionId = nextSession;
            run.turns = [...history.turns, ...recent];
            for (const turn of history.turns) {
                if (turn.undone) run.turnStatus[turn.turnId] = { undone: true };
            }
            run.historyLoaded = true;
            run.historyError = null;
            return true;
        } catch {
            if (request === run.historyRequest) run.historyError = "没能读取对话，已有内容仍然保留。请重新读取。";
            return false;
        } finally {
            rerenderIfActive(targetCanvas);
        }
    }, [rerenderIfActive, runFor]);

    // 打开面板或切画布时补齐这条画布的历史；已经载入过就不重复拉。
    useEffect(() => {
        if (!open) return;
        const run = runFor(canvasId);
        if (run.historyLoaded || run.streaming || run.sessionBusy) return;
        void loadHistory(canvasId);
    }, [canvasId, loadHistory, open, runFor, status?.available]);

    const send = useCallback(async (text: string, selectedNodeIds: string[], references: AgentChatReference[] = []) => {
        const message = text.trim();
        if (!message) return;
        // 发送时冻结归属：此后即使用户切到别的画布，结果也只写回这条记录。
        const targetCanvas = activeCanvasRef.current;
        const selectedSnapshot = [...selectedNodeIds];
        const referenceSnapshot = references.map((reference) => ({ ...reference }));
        const run = runFor(targetCanvas);
        if (run.streaming || run.sessionBusy) return;
        const controller = new AbortController();
        run.pendingUserText = message;
        run.pendingSelectedNodeIds = selectedSnapshot;
        run.streamed = "";
        run.streaming = true;
        run.lifecycleNotice = null;
        run.controller = controller;
        run.error = null;
        run.dispatched = false;
        run.recovery = null;
        run.lastSent = { text: message, selectedNodeIds: selectedSnapshot, references: referenceSnapshot };
        rerenderIfActive(targetCanvas);
        try {
            const ready = await waitForAssistant(controller.signal);
            setStatus(ready);
            if (!run.historyLoaded && !await loadHistory(targetCanvas)) throw new Error("对话还没读回来，请重新读取后再发送");
            controller.signal.throwIfAborted();
            run.recovery = { sessionId: run.sessionId, knownTurnIds: run.turns.map((turn) => turn.turnId), text: message, selectedNodeIds: selectedSnapshot };
            run.dispatched = true;
            await streamAgentChat(targetCanvas, message, {
                onDelta: (delta) => {
                    const current = runFor(targetCanvas);
                    current.streamed += delta;
                    rerenderIfActive(targetCanvas);
                },
                onLifecycle: (event) => {
                    const current = runFor(targetCanvas);
                    current.lifecycleNotice = assistantLifecycleText(event);
                    rerenderIfActive(targetCanvas);
                },
                onTurnEnd: (end) => {
                    const current = runFor(targetCanvas);
                    const turn: AssistantTurn = {
                        turnId: end.turnId || `${targetCanvas}:${Date.now()}`,
                        userText: message,
                        selectedNodeIds: selectedSnapshot,
                        reply: end.reply || current.streamed,
                        toolCalls: end.toolCalls || [],
                        change: end.change ?? null,
                        proposals: end.proposals || [],
                        error: end.error ? agentAssistantFailureText(end.errorReason ?? undefined, "这一轮没有全部完成，请核对已经落地的改动。") : null,
                        errorReason: end.errorReason,
                        cancelled: Boolean(end.cancelled),
                        createdAt: new Date().toISOString(),
                    };
                    current.turns = [...current.turns, turn];
                    current.recovery = null;
                    current.historyError = null;
                    current.pendingUserText = null;
                    current.pendingSelectedNodeIds = [];
                    current.streamed = "";
                    current.lifecycleNotice = null;
                    onCanvasChangedRef.current?.(targetCanvas, assistantChangedNodeIds(turn.change));
                    rerenderIfActive(targetCanvas);
                },
            }, { signal: controller.signal, selectedNodeIds: selectedSnapshot, references: referenceSnapshot, sessionId: run.sessionId ?? undefined });
        } catch (streamError) {
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
            // 失败时保留用户刚发的那句话，错误卡片就贴在它下面；主动停止才收起。
            if (aborted) {
                current.pendingUserText = null;
                current.pendingSelectedNodeIds = [];
            }
            current.streamed = "";
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
            const current = runFor(targetCanvas);
            current.streaming = false;
            current.lifecycleNotice = null;
            current.controller = null;
            rerenderIfActive(targetCanvas);
            void listAssistantSessions(targetCanvas).then((list) => {
                const latest = runFor(targetCanvas);
                latest.sessions = list.sessions;
                if (!latest.sessionId) latest.sessionId = list.currentSessionId;
                rerenderIfActive(targetCanvas);
            }).catch(() => { /* 会话列表读取失败不覆盖本轮结果；重新读取入口仍可用。 */ });
        }
    }, [loadHistory, rerenderIfActive, runFor]);

    // 停止只作用于当前正在查看的画布，不会取消别的画布。
    const stop = useCallback(async () => {
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        run.controller?.abort();
        if (!run.dispatched) return;
        try {
            await cancelAgentChat(targetCanvas);
        } catch (cancelError) {
            run.error = cancelError instanceof Error ? cancelError.message : String(cancelError);
            rerenderIfActive(targetCanvas);
        }
    }, [rerenderIfActive, runFor]);

    const retryLast = useCallback(() => {
        const run = runFor(activeCanvasRef.current);
        if (!run.lastSent || run.dispatched) return;
        void send(run.lastSent.text, run.lastSent.selectedNodeIds, run.lastSent.references);
    }, [runFor, send]);

    const dismissError = useCallback(() => {
        const run = runFor(activeCanvasRef.current);
        run.error = null;
        run.pendingUserText = null;
        run.pendingSelectedNodeIds = [];
        rerenderIfActive(activeCanvasRef.current);
    }, [rerenderIfActive, runFor]);

    const startNewSession = useCallback(async () => {
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        if (run.streaming || run.sessionBusy) return;
        run.sessionBusy = true;
        ++run.historyRequest;
        rerenderIfActive(targetCanvas);
        try {
            const sessionId = await createAssistantSession(targetCanvas);
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
    }, [loadHistory, rerenderIfActive, runFor]);

    const activateSession = useCallback(async (sessionId: string) => {
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        if (run.streaming || run.sessionBusy) return;
        run.sessionBusy = true;
        ++run.historyRequest;
        rerenderIfActive(targetCanvas);
        try {
            const activated = await activateAssistantSession(targetCanvas, sessionId);
            if (!activated) return;
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
    }, [loadHistory, rerenderIfActive, runFor]);

    const undoTurn = useCallback(async (turnId: string) => {
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        run.turnStatus = { ...run.turnStatus, [turnId]: { undoing: true } };
        rerenderIfActive(targetCanvas);
        const result = await undoAssistantTurn(turnId, targetCanvas);
        const next = runFor(targetCanvas);
        next.turnStatus = { ...next.turnStatus, [turnId]: result.ok ? { undone: true } : { undoFailure: result.failure } };
        rerenderIfActive(targetCanvas);
        if (result.ok) onCanvasChangedRef.current?.(targetCanvas, []);
    }, [rerenderIfActive, runFor]);

    const restartHost = useCallback(async () => {
        setStatusBusy(true);
        try {
            await restartAgentHost();
            setStatus(await getAgentHostStatus());
        } catch {
            setStatus({ available: false, reason: "host_start_failed" });
        } finally {
            setStatusBusy(false);
        }
    }, []);

    const rememberProposal = useCallback((key: string) => {
        setHandledProposals((current) => {
            if (current.has(key)) return current;
            const next = new Set(current);
            next.add(key);
            const kept = [...next].slice(-PROPOSAL_MEMORY);
            scopedLocalStorage.setItem(PROPOSAL_STORAGE_KEY, JSON.stringify(kept));
            return new Set(kept);
        });
    }, []);
    const markProposalHandled = useCallback((proposalId: string) => rememberProposal(proposalId), [rememberProposal]);
    const markProposalDismissed = useCallback((proposalId: string) => rememberProposal(dismissedProposalKey(proposalId)), [rememberProposal]);

    const run = runsRef.current.get(canvasId) ?? createRun();

    return {
        open,
        setOpen,
        width,
        setWidth,
        status,
        statusBusy,
        sessions: run.sessions,
        sessionId: run.sessionId,
        turns: run.turns,
        historyLoaded: run.historyLoaded,
        historyError: run.historyError,
        sessionBusy: run.sessionBusy,
        reloadHistory: () => loadHistory(canvasId),
        pendingUserText: run.pendingUserText,
        pendingSelectedNodeIds: run.pendingSelectedNodeIds,
        streamed: run.streamed,
        streaming: run.streaming,
        lifecycleNotice: run.lifecycleNotice,
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
