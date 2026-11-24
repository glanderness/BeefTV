import { useCallback, useEffect, useState, type MutableRefObject } from "react";
import {
    activateAssistantSession,
    confirmAssistantScriptProposal,
    createAssistantSession,
    deleteAssistantSession,
    undoAssistantTurn,
    type AssistantScriptProposal,
} from "@/services/api/agent-assistant";
import type { CanvasRun } from "./canvas-assistant-recovery";

type SessionActionDeps = {
    namespace: string;
    namespaceRef: MutableRefObject<string>;
    activeCanvasRef: MutableRefObject<string>;
    onCanvasChangedRef: MutableRefObject<((canvasId: string, changedNodeIds: string[]) => void) | undefined>;
    runFor: (id: string) => CanvasRun;
    isLiveRun: (expectedNs: string, id: string, candidate: CanvasRun) => boolean;
    rerenderIfActive: (id: string) => void;
    loadHistory: (targetCanvas: string, sessionId?: string) => Promise<boolean>;
    rememberProposal: (key: string) => void;
};

/**
 * 画布助手会话管理（新建/切换/删除）、回合撤销与技能脚本确认执行。
 */
export function useAssistantSessionActions({
    namespace,
    namespaceRef,
    activeCanvasRef,
    onCanvasChangedRef,
    runFor,
    isLiveRun,
    rerenderIfActive,
    loadHistory,
    rememberProposal,
}: SessionActionDeps) {
    const [runningScriptProposalIds, setRunningScriptProposalIds] = useState<ReadonlySet<string>>(() => new Set());
    const [scriptProposalFeedback, setScriptProposalFeedback] = useState<Record<string, string>>({});

    useEffect(() => {
        setRunningScriptProposalIds(new Set());
        setScriptProposalFeedback({});
    }, [namespace]);

    const startNewSession = useCallback(async () => {
        const originNamespace = namespaceRef.current;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        if (run.streaming || run.sessionBusy) return;
        run.sessionBusy = true;
        ++run.historyRequest;
        rerenderIfActive(targetCanvas);
        try {
            const sessionId = await createAssistantSession(targetCanvas);
            if (!isLiveRun(originNamespace, targetCanvas, run)) return;
            run.sessionId = sessionId;
            run.recovery = null;
            run.turns = [];
            run.reasoning = [];
            run.reasoningOpen = {};
            run.plan = null;
            run.error = null;
            run.pendingUserText = null;
            run.pendingContinuationId = null;
            run.lastSent = null;
            run.turnStatus = {};
            run.historyLoaded = true;
            run.historyError = null;
            void loadHistory(targetCanvas);
        } catch {
            if (isLiveRun(originNamespace, targetCanvas, run)) run.error = "没能新建对话，当前对话仍然保留。请重试。";
        } finally {
            run.sessionBusy = false;
            if (isLiveRun(originNamespace, targetCanvas, run)) rerenderIfActive(targetCanvas);
        }
    }, [activeCanvasRef, isLiveRun, loadHistory, namespaceRef, rerenderIfActive, runFor]);

    const activateSession = useCallback(async (sessionId: string) => {
        const originNamespace = namespaceRef.current;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        if (run.streaming || run.sessionBusy) return;
        run.sessionBusy = true;
        ++run.historyRequest;
        rerenderIfActive(targetCanvas);
        try {
            const activated = await activateAssistantSession(targetCanvas, sessionId);
            if (!activated || !isLiveRun(originNamespace, targetCanvas, run)) return;
            // 激活成功但读取失败时阻止把旧显示当作新对话继续发送。
            run.historyLoaded = false;
            run.plan = null;
            if (await loadHistory(targetCanvas, activated) && isLiveRun(originNamespace, targetCanvas, run)) {
                run.recovery = null;
                run.turnStatus = {};
                run.reasoning = [];
                run.reasoningOpen = {};
                run.error = null;
                run.lastSent = null;
                run.pendingUserText = null;
                run.pendingContinuationId = null;
            }
        } catch {
            if (isLiveRun(originNamespace, targetCanvas, run)) run.error = "没能切换对话，当前对话仍然保留。请重试。";
        } finally {
            run.sessionBusy = false;
            if (isLiveRun(originNamespace, targetCanvas, run)) rerenderIfActive(targetCanvas);
        }
    }, [activeCanvasRef, isLiveRun, loadHistory, namespaceRef, rerenderIfActive, runFor]);

    const deleteSession = useCallback(async (sessionId: string) => {
        const originNamespace = namespaceRef.current;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        if (run.streaming || run.sessionBusy || !sessionId) return false;
        run.sessionBusy = true;
        ++run.historyRequest;
        rerenderIfActive(targetCanvas);
        try {
            const result = await deleteAssistantSession(targetCanvas, sessionId);
            if (!isLiveRun(originNamespace, targetCanvas, run)) return false;
            run.sessions = run.sessions.filter((item) => item.sessionId !== sessionId);
            if (run.sessionId === sessionId) {
                const nextSessionId = result?.currentSessionId ?? run.sessions[0]?.sessionId ?? null;
                run.sessionId = nextSessionId;
                run.recovery = null;
                run.turns = [];
                run.reasoning = [];
                run.reasoningOpen = {};
                run.plan = null;
                run.error = null;
                run.pendingUserText = null;
                run.pendingContinuationId = null;
                run.lastSent = null;
                run.turnStatus = {};
                if (nextSessionId) {
                    run.historyLoaded = false;
                    await loadHistory(targetCanvas, nextSessionId);
                } else {
                    run.historyLoaded = true;
                    run.historyError = null;
                }
            }
            return true;
        } catch {
            if (isLiveRun(originNamespace, targetCanvas, run)) run.error = "没能删除对话，当前对话仍然保留。请重试。";
            return false;
        } finally {
            run.sessionBusy = false;
            if (isLiveRun(originNamespace, targetCanvas, run)) rerenderIfActive(targetCanvas);
        }
    }, [activeCanvasRef, isLiveRun, loadHistory, namespaceRef, rerenderIfActive, runFor]);

    const undoTurn = useCallback(async (turnId: string) => {
        const originNamespace = namespaceRef.current;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        run.turnStatus = { ...run.turnStatus, [turnId]: { undoing: true } };
        rerenderIfActive(targetCanvas);
        const result = await undoAssistantTurn(turnId, targetCanvas);
        if (!isLiveRun(originNamespace, targetCanvas, run)) return;
        run.turnStatus = { ...run.turnStatus, [turnId]: result.ok ? { undone: true } : { undoFailure: result.failure } };
        rerenderIfActive(targetCanvas);
        if (result.ok) {
            const change = run.turns.find((turn) => turn.turnId === turnId)?.change;
            const canvasIds = change?.canvasChanges?.length ? [...new Set(change.canvasChanges.map((item) => item.canvasId))] : [targetCanvas];
            for (const id of canvasIds) onCanvasChangedRef.current?.(id, []);
        }
    }, [activeCanvasRef, isLiveRun, namespaceRef, onCanvasChangedRef, rerenderIfActive, runFor]);

    const runScriptProposal = useCallback(async (proposal: AssistantScriptProposal, turnId: string, alwaysAllowSession = false) => {
        const originNamespace = namespaceRef.current;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        setRunningScriptProposalIds((prev) => {
            const next = new Set(prev);
            next.add(proposal.proposalId);
            return next;
        });
        setScriptProposalFeedback((prev) => {
            if (!prev[proposal.proposalId]) return prev;
            const next = { ...prev };
            delete next[proposal.proposalId];
            return next;
        });
        try {
            const res = await confirmAssistantScriptProposal(targetCanvas, turnId, proposal.proposalId, alwaysAllowSession);
            if (!isLiveRun(originNamespace, targetCanvas, run)) return;
            rememberProposal(proposal.proposalId);
            run.turns = run.turns.map((turn) =>
                turn.turnId === turnId
                    ? {
                          ...turn,
                          scriptProposals: (turn.scriptProposals || []).map((item) =>
                              item.proposalId === proposal.proposalId ? res.proposal : item,
                          ),
                      }
                    : turn,
            );
            rerenderIfActive(targetCanvas);
            await loadHistory(targetCanvas, run.sessionId ?? undefined);
        } catch (error) {
            if (namespaceRef.current !== originNamespace) return;
            const msg = error instanceof Error ? error.message : "脚本运行失败，请稍后重试。";
            setScriptProposalFeedback((prev) => ({ ...prev, [proposal.proposalId]: msg }));
        } finally {
            if (namespaceRef.current === originNamespace) {
                setRunningScriptProposalIds((prev) => {
                    const next = new Set(prev);
                    next.delete(proposal.proposalId);
                    return next;
                });
            }
        }
    }, [activeCanvasRef, isLiveRun, loadHistory, namespaceRef, rememberProposal, rerenderIfActive, runFor]);

    return {
        startNewSession,
        activateSession,
        deleteSession,
        undoTurn,
        runScriptProposal,
        runningScriptProposalIds,
        scriptProposalFeedback,
    };
}
