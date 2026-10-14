import type { Dispatch, SetStateAction } from "react";
import { CanvasGenerationDurableAckError } from "./canvas-generation-errors";
export { CanvasGenerationDurableAckError, CanvasGenerationMaterializationError, CanvasGenerationTargetSaveError } from "./canvas-generation-errors";

import { assertUserScope, captureUserScope, isUserScopeAbandonedError, UserScopeAbandonedError, userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
import { bindCanvasTaskOutput, type CanvasTaskBindReceipt } from "@/services/api/operations";
import { ApiError } from "@/services/api/request";
import { queryGenerationTask, type GenerationTask, type GenerationTaskDeliveryProgress, type GenerationTaskOutput } from "@/services/api/task-center";
import { generationTaskOutputMaterialized, sleepWithSignal, waitForMaterializedGenerationOutputs, type RefreshGenerationTask, type SleepWithSignal } from "./canvas-generation-output-delivery";
import { CanvasBackendSubmitPausedError, CanvasStaleScopeError, isCanvasRevisionConflict } from "@/services/canvas-revision-conflict";
import { generationEffectApplied } from "@/services/generation-consumer-dedupe";
import { attachNodeEffectKey } from "@/services/generation-task-materializer";
import { persistCanvasDocument } from "@/services/local-workspace-repository";
import { hydrateBackendGeneratedOutputs } from "@/services/project-asset-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import { publishGenerationDeliveryProgress } from "@/stores/use-generation-delivery-progress";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

export { persistCanvasGenerationTarget } from "./canvas-generation-target";

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
    refreshTask?: RefreshGenerationTask;
    sleep?: SleepWithSignal;
    now?: () => number;
    publishDeliveryProgress?: (taskId: string, progress: GenerationTaskDeliveryProgress | undefined) => void;
};

function isMediaGenerationTask(task: GenerationTask) {
    return task.type !== "canvas_text" && task.type !== "text_replay";
}

function isOutputNotReadyError(error: unknown) {
    const reason = error instanceof ApiError ? error.reason : error && typeof error === "object" && "reason" in error ? (error as { reason?: unknown }).reason : undefined;
    return reason === "output_not_ready" || reason === "resource_not_ready";
}

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
    const workflowOutputs = input.task.resultJson ? (JSON.parse(input.task.resultJson) as { outputs?: Array<{ id?: string; mediaType: string }> }).outputs : undefined;
    const mode = input.task.type.replace("canvas_", "");
    const workflowPrimaryIndex = workflowOutputs?.findIndex((item) => item.mediaType === mode) ?? -1;
    const node = input.nodesRef.current.find((item) => item.id === input.nodeId);
    const selectedIndex = node?.metadata?.generationOutputTaskId === input.task.id ? workflowOutputs?.findIndex((item) => item.id === node.metadata?.primaryOutputId) ?? -1 : -1;
    const outputIndex = input.outputIndex ?? (selectedIndex >= 0 ? selectedIndex : workflowOutputs?.length ? Math.max(0, workflowPrimaryIndex) : 0);
    const hydrateOutputs = runtime.hydrateOutputs ?? hydrateBackendGeneratedOutputs;
    const persistDocument = runtime.persistDocument ?? (async (id, patch, entryCapturedScope) => {
        const captured = entryCapturedScope ?? capturedScope;
        assertUserScope(captured, liveScope());
        await (persistCanvasDocument as PersistCanvasDocumentWithScope)(id, patch, captured);
    });
    const bindOutput = runtime.bindOutput ?? bindCanvasTaskOutput;
    const adoptConfirmedProjection = runtime.adoptConfirmedProjection ?? defaultAdoptConfirmedProjection;
    const refreshTask = runtime.refreshTask ?? ((taskId, options) => queryGenerationTask(taskId, options));
    const sleep = runtime.sleep ?? sleepWithSignal;
    const now = runtime.now ?? Date.now;
    const publishDeliveryProgress = runtime.publishDeliveryProgress ?? publishGenerationDeliveryProgress;
    const startedAt = now();

    const waitForMaterialization = (task: GenerationTask, forceRefresh = false) =>
        waitForMaterializedGenerationOutputs(
            {
                task,
                outputIndices: [outputIndex],
                signal: input.signal,
                expectedScope: capturedScope,
                isCurrent: input.isCurrent,
                liveScope,
                refreshTask,
                sleep,
                now,
                startedAt,
                publishDeliveryProgress,
            },
            forceRefresh,
        );

    assertBindDispatchScope(capturedScope, liveScope);
    let task = input.task;
    if (isMediaGenerationTask(task) && Boolean(task.outputs?.length) && !generationTaskOutputMaterialized(task, outputIndex)) {
        task = await waitForMaterialization(task);
    }
    assertBindDispatchScope(capturedScope, liveScope);

    await hydrateOutputs(task, input.signal, {
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

    const operationId = attachNodeEffectKey(task.id, input.nodeId, outputIndex);
    let response: Awaited<ReturnType<typeof bindCanvasTaskOutput>>;
    for (;;) {
        try {
            response = await bindOutput({
                operationId,
                canvasId: capturedCanvasId,
                taskId: task.id,
                nodeId: input.nodeId,
                outputIndex,
                signal: input.signal,
                expectedScope: capturedScope,
            });
            break;
        } catch (error) {
            // 交付仍在进行时 bind 会以 output_not_ready/resource_not_ready 拒绝；
            // 同一个 operationId 幂等，回到等待再重试，不把在途状态报成画布冲突。
            if (!isOutputNotReadyError(error)) throw error;
            assertBindDispatchScope(capturedScope, liveScope);
            task = await waitForMaterialization(task, true);
            assertBindDispatchScope(capturedScope, liveScope);
        }
    }
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
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
}) {
    throwIfAborted(input.signal);
    const capturedScope = captureUserScope();
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
    try {
        await persistCanvasDocument(input.projectId, { nodes }, capturedScope);
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (isUserScopeAbandonedError(error)) throw error;
        if (error instanceof CanvasStaleScopeError) throw error;
        // 陈旧 revision / 已暂停提交不是生成失败：live 节点已在本地更新，普通保存会收敛。
        if (!(isCanvasRevisionConflict(error) || error instanceof CanvasBackendSubmitPausedError)) {
            throw new CanvasGenerationDurableAckError(error);
        }
    }
    input.nodesRef.current = nodes;
    input.setNodes(nodes);
}
