import type { Dispatch, SetStateAction } from "react";

import { parseCanvasStorageDocument, rebaseCanvasProjects, serializeCanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, UserScopeAbandonedError, userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
import { bindCanvasTaskOutput, type CanvasTaskBindReceipt } from "@/services/api/operations";
import type { GenerationTask, GenerationTaskOutput } from "@/services/api/task-center";
import { CanvasBackendSubmitPausedError, CanvasStaleScopeError, isCanvasRevisionConflict } from "@/services/canvas-revision-conflict";
import { generationEffectApplied } from "@/services/generation-consumer-dedupe";
import { attachNodeEffectKey } from "@/services/generation-task-materializer";
import { persistCanvasDocument } from "@/services/local-workspace-repository";
import { hydrateBackendGeneratedOutputs } from "@/services/project-asset-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import {
    CANVAS_STORE_KEY,
    canvasStoreStorageRevision,
    commitPendingCanvasStorePersistenceLocked,
    flushCanvasStorePersistence,
    pendingCanvasStorePersistence,
    rebasePendingCanvasStorePersistenceAfterGenerationCommitLocked,
    reconcileCanvasGenerationFailure,
    recordCanvasStorageDocument,
    registerCanvasGenerationPersistenceAttempt,
    useCanvasStore,
    withCanvasStorePersistenceLock,
    withCanvasStorePersistenceSuppressed,
    type CanvasProject,
} from "@/stores/canvas/use-canvas-store";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData } from "@/types/canvas";

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

export class CanvasGenerationDurableAckError extends Error {
    readonly cause: unknown;

    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : "画布生成副作用持久化失败");
        this.name = "CanvasGenerationDurableAckError";
        this.cause = cause;
    }
}

export function isCanvasGenerationDurableAckError(error: unknown): error is CanvasGenerationDurableAckError {
    return error instanceof CanvasGenerationDurableAckError;
}

export class CanvasBindFlushError extends Error {
    readonly cause: unknown;

    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : "本地草稿还没保存，生成结果没有写到画布");
        this.name = "CanvasBindFlushError";
        this.cause = cause;
    }
}

export class CanvasBindProjectionAdoptionError extends Error {
    constructor() {
        super("这次生成结果没能写进画布。请再试一次。");
        this.name = "CanvasBindProjectionAdoptionError";
    }
}

export type AdoptServerConfirmedProjection = (project: CanvasProject, scope: string, entryCapturedScope?: CapturedUserScope) => Promise<CanvasProject | undefined>;
type PersistCanvasDocumentWithScope = (id: string, patch: { nodes?: CanvasNodeData[]; connections?: CanvasConnection[] }, entryCapturedScope?: CapturedUserScope) => Promise<void>;

type CanvasGenerationLiveProjectState = Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">;
type CanvasGenerationLiveProjectAdapter = {
    read: () => CanvasGenerationLiveProjectState;
    write: (state: CanvasGenerationLiveProjectState) => void;
};

export function createCanvasGenerationLiveProjectAdapter(input: {
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    chatSessionsRef: { current: CanvasAssistantSession[] };
    activeChatIdRef: { current: string | null };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setChatSessions: Dispatch<SetStateAction<CanvasAssistantSession[]>>;
    setActiveChatId: Dispatch<SetStateAction<string | null>>;
}): CanvasGenerationLiveProjectAdapter {
    return {
        read: () => ({ nodes: input.nodesRef.current, connections: input.connectionsRef.current, chatSessions: input.chatSessionsRef.current, activeChatId: input.activeChatIdRef.current }),
        write: (state) => {
            input.nodesRef.current = state.nodes;
            input.connectionsRef.current = state.connections;
            input.chatSessionsRef.current = state.chatSessions;
            input.activeChatIdRef.current = state.activeChatId;
            input.setNodes(state.nodes);
            input.setConnections(state.connections);
            input.setChatSessions(state.chatSessions);
            input.setActiveChatId(state.activeChatId);
        },
    };
}

const canvasGenerationLiveAdapters = new Map<string, CanvasGenerationLiveProjectAdapter>();

function canvasGenerationLiveAdapterKey(scope: string, projectId: string) {
    return `${scope}\0${projectId}`;
}

export function registerCanvasGenerationLiveProject(input: { scope: string; projectId: string; adapter: CanvasGenerationLiveProjectAdapter }) {
    const key = canvasGenerationLiveAdapterKey(input.scope, input.projectId);
    canvasGenerationLiveAdapters.set(key, input.adapter);
    return () => {
        if (canvasGenerationLiveAdapters.get(key) === input.adapter) canvasGenerationLiveAdapters.delete(key);
    };
}

function reconcileCanvasGenerationLiveProject(scope: string, durableDocument: ReturnType<typeof parseCanvasStorageDocument>, baseProject: CanvasProject, attemptedProject: CanvasProject) {
    const adapter = canvasGenerationLiveAdapters.get(canvasGenerationLiveAdapterKey(scope, attemptedProject.id));
    if (!adapter) return;
    const durableProject = durableDocument.state.projects.find((project) => project.id === attemptedProject.id);
    if (!durableProject) return;
    const live = adapter.read();
    const liveProject: CanvasProject = { ...attemptedProject, ...live };
    const rebased = rebaseCanvasProjects({
        document: { ...durableDocument, state: { projects: [durableProject] } },
        baseProjects: [attemptedProject],
        localProjects: [liveProject],
        baseRevision: durableDocument.storageRevision,
    });
    const reconciled = rebased.document.state.projects.find((project) => project.id === attemptedProject.id) ?? durableProject;
    adapter.write({ nodes: reconciled.nodes, connections: reconciled.connections, chatSessions: reconciled.chatSessions, activeChatId: reconciled.activeChatId });
}

export async function applyCanvasGenerationTaskNodeEffect(input: {
    projectId: string;
    nodeId: string;
    task: GenerationTask;
    output: GenerationTaskOutput;
    effectKey: string;
    signal?: AbortSignal;
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
}) {
    await bindBackendCanvasGenerationResult({
        canvasId: input.projectId,
        nodeId: input.nodeId,
        task: input.task,
        outputIndex: input.output.outputIndex,
        signal: input.signal,
        isCurrent: () => !input.signal?.aborted,
        nodesRef: input.nodesRef,
        setNodes: input.setNodes,
    });
}

export type BindBackendCanvasGenerationRuntime = {
    hydrateOutputs?: typeof hydrateBackendGeneratedOutputs;
    persistDocument?: PersistCanvasDocumentWithScope;
    bindOutput?: typeof bindCanvasTaskOutput;
    adoptConfirmedProjection?: AdoptServerConfirmedProjection;
    captureScope?: () => CapturedUserScope;
    liveScope?: () => CapturedUserScope;
};

export async function bindBackendCanvasGenerationResult(input: {
    canvasId: string;
    nodeId: string;
    task: GenerationTask;
    outputIndex?: number;
    signal?: AbortSignal;
    isCurrent: () => boolean;
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    runtime?: BindBackendCanvasGenerationRuntime;
}) {
    if (input.task.status !== "succeeded") throw new Error("只有成功的任务才能绑定到画布");
    const runtime = input.runtime ?? {};
    const liveScope = runtime.liveScope ?? captureUserScope;
    const capturedScope = (runtime.captureScope ?? captureUserScope)();
    const capturedCanvasId = input.canvasId;
    const outputIndex = input.outputIndex ?? 0;
    const hydrateOutputs = runtime.hydrateOutputs ?? hydrateBackendGeneratedOutputs;
    const persistDocument = runtime.persistDocument ?? (async (id, patch, entryCapturedScope) => {
        const captured = entryCapturedScope ?? capturedScope;
        assertUserScope(captured, liveScope());
        await (persistCanvasDocument as PersistCanvasDocumentWithScope)(id, patch, captured);
    });
    const bindOutput = runtime.bindOutput ?? bindCanvasTaskOutput;
    const adoptConfirmedProjection = runtime.adoptConfirmedProjection ?? defaultAdoptConfirmedProjection;

    assertBindDispatchScope(capturedScope, liveScope);
    await hydrateOutputs(input.task, input.signal, {
        writeAsset: (asset) => {
            if (!userScopeMatches(capturedScope, liveScope())) return;
            useAssetStore.setState((state) => (state.assets.some((item) => item.id === asset.id) ? state : { assets: [asset, ...state.assets] }));
        },
    });
    assertBindDispatchScope(capturedScope, liveScope);

    const live = useCanvasStore.getState().projects.find((project) => project.id === capturedCanvasId);
    if (live) {
        try {
            await persistDocument(capturedCanvasId, { nodes: live.nodes, connections: live.connections }, capturedScope);
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            if (isUserScopeAbandonedError(error)) throw error;
            if (error instanceof CanvasStaleScopeError) throw error;
            assertBindDispatchScope(capturedScope, liveScope);
            // 画布 document.commit 的陈旧 revision / 已暂停提交不能当成生成失败：
            // 资源已落盘，bind 回执才是画布真相；继续绑定后由三路合并保留并发节点。
            if (!(isCanvasRevisionConflict(error) || error instanceof CanvasBackendSubmitPausedError)) {
                throw error instanceof CanvasBindFlushError ? error : new CanvasBindFlushError(error);
            }
        }
    }
    assertBindDispatchScope(capturedScope, liveScope);

    const response = await bindOutput({
        operationId: attachNodeEffectKey(input.task.id, input.nodeId, outputIndex),
        canvasId: capturedCanvasId,
        taskId: input.task.id,
        nodeId: input.nodeId,
        outputIndex,
        signal: input.signal,
        expectedScope: capturedScope,
    });
    assertBindDispatchScope(capturedScope, liveScope);

    const receipt = response.result ?? {};
    if (receipt.bindingStatus === "deleted" && !receipt.canvas) return;
    const canonical = canonicalCanvasFromReceipt(capturedCanvasId, receipt);
    const adopted = await adoptConfirmedProjection(canonical, capturedScope.userScope, capturedScope);
    assertBindDispatchScope(capturedScope, liveScope);
    if (adopted && input.isCurrent()) {
        input.nodesRef.current = adopted.nodes;
        input.setNodes(adopted.nodes);
    }
}

function assertBindDispatchScope(expected: CapturedUserScope, live: () => CapturedUserScope) {
    if (!userScopeMatches(expected, live())) throw new UserScopeAbandonedError();
}

async function defaultAdoptConfirmedProjection(project: CanvasProject, scope: string, entryCapturedScope?: CapturedUserScope) {
    const captured = entryCapturedScope;
    if (!captured || captured.userScope !== scope) throw new CanvasBindProjectionAdoptionError();
    const repository = await import("@/services/local-workspace-repository");
    assertUserScope(captured);
    const adopt = (repository as { adoptServerConfirmedGenerationPatch?: AdoptServerConfirmedProjection }).adoptServerConfirmedGenerationPatch;
    if (!adopt) throw new CanvasBindProjectionAdoptionError();
    return adopt(project, captured.userScope, captured);
}

function canonicalCanvasFromReceipt(canvasId: string, receipt: CanvasTaskBindReceipt): CanvasProject {
    if (receipt.bindingStatus !== "bound" && receipt.bindingStatus !== "replaced" && receipt.bindingStatus !== "deleted") {
        throw new CanvasBindProjectionAdoptionError();
    }
    if (typeof receipt.revision !== "number" || !Number.isInteger(receipt.revision) || receipt.revision < 1) {
        throw new CanvasBindProjectionAdoptionError();
    }
    const raw = receipt.canvas;
    if (!raw || typeof raw !== "object") throw new CanvasBindProjectionAdoptionError();
    const document = raw as CanvasProject;
    if (typeof document.id === "string" && document.id && document.id !== canvasId) throw new CanvasBindProjectionAdoptionError();
    if (!Array.isArray(document.nodes) || !Array.isArray(document.connections)) throw new CanvasBindProjectionAdoptionError();
    return {
        ...document,
        id: canvasId,
        revision: receipt.revision,
        nodes: document.nodes as CanvasNodeData[],
        connections: document.connections,
    };
}

export async function persistCanvasOperationContinuationEffect(input: {
    projectId: string;
    nodeId: string;
    continuation: NonNullable<NonNullable<CanvasNodeData["metadata"]>["agentGenerationContinuation"]>;
    effectKey: string;
    signal?: AbortSignal;
    previousNodes?: CanvasNodeData[];
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
}) {
    throwIfAborted(input.signal);
    const previousNodes = input.previousNodes ?? input.nodesRef.current;
    const currentNodes = input.nodesRef.current;
    const currentNode = currentNodes.find((node) => node.id === input.nodeId);
    if (!currentNode) throw new Error("画布中找不到 Agent continuation 节点");
    if (generationEffectApplied(currentNode.metadata || {}, input.effectKey) && currentNode.metadata?.agentGenerationContinuation?.status === "completed") return;

    const nodes = currentNodes.map((node) =>
        node.id === input.nodeId
            ? {
                  ...node,
                  metadata: {
                      ...node.metadata,
                      agentGenerationContinuation: input.continuation,
                      generationEffectKeys: Array.from(new Set([...(node.metadata?.generationEffectKeys || []), input.effectKey])),
                  },
              }
            : node,
    );
    let persistedProject: CanvasProject;
    try {
        persistedProject = await persistCanvasGenerationEffect({
            projectId: input.projectId,
            effectKey: input.effectKey,
            previousNodes,
            nodes,
            signal: input.signal,
        });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new CanvasGenerationDurableAckError(error);
    }
    input.nodesRef.current = persistedProject.nodes;
    input.setNodes(persistedProject.nodes);
}

type CinematicCanvasRollbackState = Pick<CanvasProject, "nodes" | "connections">;

type IdentifiedCanvasEntity = { id: string };

function sameCanvasEntity(left: unknown, right: unknown) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function reconcileCinematicEntities<T extends IdentifiedCanvasEntity>(previous: T[], attempted: T[], live: T[]): T[] {
    const previousById = new Map(previous.map((entity) => [entity.id, entity]));
    const attemptedById = new Map(attempted.map((entity) => [entity.id, entity]));
    const cinematicIds = new Set<string>();
    for (const id of new Set([...previousById.keys(), ...attemptedById.keys()])) {
        if (!sameCanvasEntity(previousById.get(id), attemptedById.get(id))) cinematicIds.add(id);
    }

    const reconciled: T[] = [];
    const included = new Set<string>();
    for (const liveEntity of live) {
        if (!cinematicIds.has(liveEntity.id)) {
            reconciled.push(liveEntity);
            included.add(liveEntity.id);
            continue;
        }
        const previousEntity = previousById.get(liveEntity.id);
        if (!previousEntity) continue;
        reconciled.push(previousEntity);
        included.add(previousEntity.id);
    }

    for (let previousIndex = 0; previousIndex < previous.length; previousIndex += 1) {
        const previousEntity = previous[previousIndex]!;
        if (!cinematicIds.has(previousEntity.id) || included.has(previousEntity.id)) continue;
        let insertAt = reconciled.length;
        for (let index = previousIndex - 1; index >= 0; index -= 1) {
            const predecessorIndex = reconciled.findIndex((entity) => entity.id === previous[index]!.id);
            if (predecessorIndex >= 0) {
                insertAt = predecessorIndex + 1;
                break;
            }
        }
        if (insertAt === reconciled.length) {
            for (let index = previousIndex + 1; index < previous.length; index += 1) {
                const successorIndex = reconciled.findIndex((entity) => entity.id === previous[index]!.id);
                if (successorIndex >= 0) {
                    insertAt = successorIndex;
                    break;
                }
            }
        }
        reconciled.splice(insertAt, 0, previousEntity);
        included.add(previousEntity.id);
    }
    return reconciled;
}

function reconcileCinematicAckFailureCanvas(input: {
    previousNodes: CanvasNodeData[];
    attemptedNodes: CanvasNodeData[];
    liveNodes: CanvasNodeData[];
    previousConnections: CanvasConnection[];
    attemptedConnections: CanvasConnection[];
    liveConnections: CanvasConnection[];
}): CinematicCanvasRollbackState {
    return {
        nodes: reconcileCinematicEntities(input.previousNodes, input.attemptedNodes, input.liveNodes),
        connections: reconcileCinematicEntities(input.previousConnections, input.attemptedConnections, input.liveConnections),
    };
}

function reconcileCinematicActiveChatId(previous: string | null, attempted: string | null, live: string | null) {
    return live === attempted ? previous : live;
}

function reconcileCinematicAckFailureSessions(input: { previous: CanvasAssistantSession[]; attempted: CanvasAssistantSession[]; live: CanvasAssistantSession[]; effectKey: string }) {
    const previousById = new Map(input.previous.map((session) => [session.id, session]));
    const attemptedById = new Map(input.attempted.map((session) => [session.id, session]));
    return input.live.map((liveSession) => {
        const previousSession = previousById.get(liveSession.id);
        const attemptedSession = attemptedById.get(liveSession.id);
        if (!previousSession || !attemptedSession || !generationEffectApplied(attemptedSession, input.effectKey) || generationEffectApplied(previousSession, input.effectKey)) return liveSession;

        const pendingMessageId = previousSession.pendingBackendSession?.messageId;
        let messages = liveSession.messages;
        if (pendingMessageId) {
            const pendingMessage = previousSession.messages.find((message) => message.id === pendingMessageId);
            if (pendingMessage) {
                let replaced = false;
                messages = liveSession.messages.map((message) => {
                    if (message.id !== pendingMessageId) return message;
                    replaced = true;
                    return pendingMessage;
                });
                if (!replaced) {
                    const previousIndex = Math.max(
                        0,
                        previousSession.messages.findIndex((message) => message.id === pendingMessageId),
                    );
                    const insertAt = Math.min(previousIndex, messages.length);
                    messages = [...messages.slice(0, insertAt), pendingMessage, ...messages.slice(insertAt)];
                }
            }
        }

        const generationEffectKeys = Array.from(new Set([...(previousSession.generationEffectKeys || []), ...(liveSession.generationEffectKeys || []).filter((key) => key !== input.effectKey)]));
        const restored: CanvasAssistantSession = {
            ...liveSession,
            pendingBackendSession: previousSession.pendingBackendSession,
            messages,
            updatedAt: liveSession.updatedAt === attemptedSession.updatedAt ? previousSession.updatedAt : liveSession.updatedAt,
        };
        if (generationEffectKeys.length) restored.generationEffectKeys = generationEffectKeys;
        else delete restored.generationEffectKeys;
        return restored;
    });
}

export async function persistCanvasCinematicSessionContinuationEffect(input: {
    projectId: string;
    effectKey: string;
    previousNodes: CanvasNodeData[];
    nodes: CanvasNodeData[];
    previousConnections: CanvasConnection[];
    connections: CanvasConnection[];
    previousChatSessions: CanvasAssistantSession[];
    chatSessions: CanvasAssistantSession[];
    previousActiveChatId: string | null;
    activeChatId: string | null;
    signal?: AbortSignal;
    readLiveSessionState: () => { sessions: CanvasAssistantSession[]; activeChatId: string | null };
    restoreLiveSessions: (sessions: CanvasAssistantSession[], activeChatId: string | null) => void;
    restoreLiveSnapshot?: (state: CinematicCanvasRollbackState) => void;
}) {
    const scope = getActiveUserScope();
    const liveAdapter = canvasGenerationLiveAdapters.get(canvasGenerationLiveAdapterKey(scope, input.projectId));
    const initialLive = liveAdapter?.read();
    const safeOrdinaryState = reconcileCinematicAckFailureCanvas({
        previousNodes: input.previousNodes,
        attemptedNodes: input.nodes,
        liveNodes: initialLive?.nodes ?? input.nodes,
        previousConnections: input.previousConnections,
        attemptedConnections: input.connections,
        liveConnections: initialLive?.connections ?? input.connections,
    });
    const safeOrdinaryActiveChatId = reconcileCinematicActiveChatId(input.previousActiveChatId, input.activeChatId, initialLive?.activeChatId ?? input.activeChatId);
    if (getActiveUserScope() === scope) {
        useCanvasStore.getState().updateProject(input.projectId, { ...safeOrdinaryState, activeChatId: safeOrdinaryActiveChatId });
    }

    try {
        return await persistCanvasGenerationEffect({
            projectId: input.projectId,
            effectKey: input.effectKey,
            previousNodes: input.previousNodes,
            nodes: input.nodes,
            previousConnections: input.previousConnections,
            connections: input.connections,
            previousChatSessions: input.previousChatSessions,
            chatSessions: input.chatSessions,
            previousActiveChatId: input.previousActiveChatId,
            activeChatId: input.activeChatId,
            signal: input.signal,
        });
    } catch (error) {
        const latestLive = liveAdapter?.read();
        const liveSessionState = input.readLiveSessionState();
        const reconciledSessions = reconcileCinematicAckFailureSessions({
            previous: input.previousChatSessions,
            attempted: input.chatSessions,
            live: liveSessionState.sessions,
            effectKey: input.effectKey,
        });
        const reconciledActiveChatId = reconcileCinematicActiveChatId(input.previousActiveChatId, input.activeChatId, liveSessionState.activeChatId);
        const reconciledCanvas = reconcileCinematicAckFailureCanvas({
            previousNodes: input.previousNodes,
            attemptedNodes: input.nodes,
            liveNodes: latestLive?.nodes ?? input.nodes,
            previousConnections: input.previousConnections,
            attemptedConnections: input.connections,
            liveConnections: latestLive?.connections ?? input.connections,
        });
        if (liveAdapter && latestLive) {
            liveAdapter.write({ ...latestLive, nodes: reconciledCanvas.nodes, connections: reconciledCanvas.connections, chatSessions: reconciledSessions, activeChatId: reconciledActiveChatId });
        }
        input.restoreLiveSnapshot?.(reconciledCanvas);
        if (getActiveUserScope() === scope) {
            useCanvasStore.getState().updateProject(input.projectId, { ...reconciledCanvas, chatSessions: reconciledSessions, activeChatId: reconciledActiveChatId });
            try {
                await flushCanvasStorePersistence();
            } catch {
                // 保留 latest safe snapshot 给后续普通 persistence retry；原始 generation ack 错误仍是本次退出语义。
            }
        }
        input.restoreLiveSessions(reconciledSessions, reconciledActiveChatId);
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new CanvasGenerationDurableAckError(error);
    }
}

export type CanvasGenerationEffectInput = {
    projectId: string;
    effectKey: string;
    previousNodes?: CanvasNodeData[];
    nodes?: CanvasNodeData[];
    previousConnections?: CanvasConnection[];
    connections?: CanvasConnection[];
    previousChatSessions?: CanvasAssistantSession[];
    chatSessions?: CanvasAssistantSession[];
    previousActiveChatId?: string | null;
    activeChatId?: string | null;
    signal?: AbortSignal;
};

function generationProjectDelta(input: CanvasGenerationEffectInput, memoryProject: CanvasProject) {
    const stampedNodes = (input.nodes || []).filter((node) => generationEffectApplied(node.metadata || {}, input.effectKey));
    const stampedSessions = (input.chatSessions || []).filter((session) => generationEffectApplied(session, input.effectKey));

    if (input.connections && !input.previousConnections) throw new Error("生成副作用缺少连接前置快照");

    const baseProject: CanvasProject = {
        ...memoryProject,
        nodes: input.previousNodes ?? [],
        connections: input.previousConnections ?? [],
        chatSessions: input.previousChatSessions ?? [],
        activeChatId: input.previousActiveChatId !== undefined ? input.previousActiveChatId : memoryProject.activeChatId,
    };
    const localProject: CanvasProject = {
        ...baseProject,
        nodes: input.nodes ? (input.previousNodes ? input.nodes : stampedNodes) : baseProject.nodes,
        connections: input.connections ?? baseProject.connections,
        chatSessions: input.chatSessions ? (input.previousChatSessions ? input.chatSessions : stampedSessions) : baseProject.chatSessions,
        activeChatId: input.activeChatId !== undefined ? input.activeChatId : baseProject.activeChatId,
        updatedAt: new Date().toISOString(),
    };
    return { baseProject, localProject, stamped: stampedNodes.length > 0 || stampedSessions.length > 0 };
}

function rebaseCommittedCanvasGenerationOntoLiveProject(scope: string, projectId: string, committedDocument: ReturnType<typeof parseCanvasStorageDocument>, liveBaseProject: CanvasProject, baseRevision: number) {
    const committedProject = committedDocument.state.projects.find((project) => project.id === projectId);
    if (!committedProject) return undefined;
    const storeProject = getActiveUserScope() === scope ? useCanvasStore.getState().projects.find((project) => project.id === projectId) : undefined;
    const liveAdapter = canvasGenerationLiveAdapters.get(canvasGenerationLiveAdapterKey(scope, projectId));
    const liveState = liveAdapter?.read();
    const liveProject: CanvasProject = {
        ...(storeProject ?? committedProject),
        ...(liveState ?? {}),
    };
    const liveDocument = {
        ...committedDocument,
        state: {
            projects: committedDocument.state.projects.map((project) => (project.id === projectId ? liveProject : project)),
        },
    };
    return rebaseCanvasProjects({
        document: liveDocument,
        baseProjects: [liveBaseProject],
        localProjects: [committedProject],
        baseRevision,
    }).document.state.projects.find((project) => project.id === projectId);
}

export async function persistCanvasGenerationEffect(input: CanvasGenerationEffectInput) {
    throwIfAborted(input.signal);
    const scope = getActiveUserScope();
    if (!useCanvasStore.getState().projects.some((project) => project.id === input.projectId)) {
        const { loadCanvasProjectForEditing } = await import("@/services/local-workspace-sync");
        await loadCanvasProjectForEditing(input.projectId);
        throwIfAborted(input.signal);
        if (scope !== getActiveUserScope()) throw new Error("账号已切换，无法写入生成结果");
    }
    const baseRevision = canvasStoreStorageRevision(scope);
    const memoryProjects = useCanvasStore.getState().projects;
    const memoryProject = memoryProjects.find((candidate) => candidate.id === input.projectId);
    if (!memoryProject) throw new Error("画布项目不存在，无法持久化生成副作用");

    const delta = generationProjectDelta(input, memoryProject);
    if (!delta.stamped) throw new Error("生成副作用缺少持久幂等标记");

    const unregisterAttempt = registerCanvasGenerationPersistenceAttempt(scope, input.projectId, input.effectKey, {
        previousNodes: input.previousNodes,
        nodes: input.nodes,
        previousConnections: input.previousConnections,
        connections: input.connections,
        previousChatSessions: input.previousChatSessions,
        chatSessions: input.chatSessions,
    });

    try {
        const persisted = await withCanvasStorePersistenceLock(
            scope,
            async () => {
            let latestDurable: ReturnType<typeof parseCanvasStorageDocument> | undefined;
            let generationCommittedProject: CanvasProject | undefined;
            let reconcileLiveOnFailure = false;
            try {
                throwIfAborted(input.signal);
                const storage = localForageStorageForScope(scope);
                await commitPendingCanvasStorePersistenceLocked(scope);
                throwIfAborted(input.signal);

                const durable = parseCanvasStorageDocument(await storage.getItem(CANVAS_STORE_KEY), memoryProjects);
                latestDurable = durable;
                throwIfAborted(input.signal);
                const rebased = rebaseCanvasProjects({
                    document: durable,
                    baseProjects: [delta.baseProject],
                    localProjects: [delta.localProject],
                    baseRevision,
                });
                if (rebased.conflicts.some((conflict) => conflict.reason === "concurrent-update")) {
                    reconcileLiveOnFailure = true;
                    throw new Error("画布生成副作用与并发修改冲突");
                }
                if (rebased.conflicts.length) {
                    reconcileLiveOnFailure = true;
                    throw new Error("画布生成副作用与已删除内容冲突");
                }

                throwIfAborted(input.signal);
                await storage.setItem(CANVAS_STORE_KEY, serializeCanvasStorageDocument(rebased.document));
                // Dedicated generation setItem resolving is the commit point. From here, abort or ordinary persistence failures cannot negate the committed effect.
                latestDurable = rebased.document;
                generationCommittedProject = rebased.document.state.projects.find((candidate) => candidate.id === input.projectId);
                recordCanvasStorageDocument(scope, rebased.document);
                rebasePendingCanvasStorePersistenceAfterGenerationCommitLocked(scope, rebased.document);

                while (pendingCanvasStorePersistence(scope)) {
                    const ordinaryDocument = await commitPendingCanvasStorePersistenceLocked(scope);
                    if (ordinaryDocument) {
                        latestDurable = ordinaryDocument;
                        recordCanvasStorageDocument(scope, ordinaryDocument);
                    }
                }

                const finalDocument = parseCanvasStorageDocument(await storage.getItem(CANVAS_STORE_KEY), rebased.document.state.projects);
                latestDurable = finalDocument;
                recordCanvasStorageDocument(scope, finalDocument);
                const persistedProject = rebaseCommittedCanvasGenerationOntoLiveProject(scope, input.projectId, finalDocument, memoryProject, baseRevision) ?? generationCommittedProject;
                if (!persistedProject) throw new Error("画布项目不存在，无法确认生成副作用");
                if (getActiveUserScope() === scope) {
                    withCanvasStorePersistenceSuppressed(() => {
                        useCanvasStore.setState((state) => ({
                            projects: state.projects.map((project) => (project.id === input.projectId ? persistedProject : project)),
                        }));
                    });
                }
                return persistedProject;
            } catch (error) {
                if (generationCommittedProject) {
                    if (latestDurable) {
                        recordCanvasStorageDocument(scope, latestDurable);
                        return rebaseCommittedCanvasGenerationOntoLiveProject(scope, input.projectId, latestDurable, memoryProject, baseRevision) ?? generationCommittedProject;
                    }
                    return generationCommittedProject;
                }
                if (latestDurable) {
                    recordCanvasStorageDocument(scope, latestDurable);
                    reconcileCanvasGenerationFailure(scope, latestDurable.state.projects);
                    if (reconcileLiveOnFailure) reconcileCanvasGenerationLiveProject(scope, latestDurable, delta.baseProject, delta.localProject);
                }
                throw error;
            }
            },
            { requireCrossRealmLock: true },
        );
        // IndexedDB is only a desktop cache. A generation is not durably
        // acknowledged until the completed node snapshot is also stored in
        // the Go repository that will hydrate the next app launch.
        if (getActiveUserScope() === scope) {
            const { syncLocalCanvasGenerationProjectToBackend } = await import("@/services/local-workspace-repository");
            await syncLocalCanvasGenerationProjectToBackend(input.projectId);
        }
        return persisted;
    } finally {
        unregisterAttempt();
    }
}
