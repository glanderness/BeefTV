import { primaryGenerationOutput } from "@/lib/generation-outputs";
import { parseBackendGenerationResult } from "@/services/api/generation-task";
import { sleepWithSignal, waitForMaterializedGenerationOutputs } from "./canvas-generation-output-delivery";
import type { Dispatch, SetStateAction } from "react";
import { CanvasGenerationDurableAckError, CanvasGenerationMaterializationError, CanvasGenerationOutputMissingError } from "./canvas-generation-errors";
export { CanvasGenerationDurableAckError, CanvasGenerationMaterializationError, CanvasGenerationOutputMissingError, CanvasGenerationTargetSaveError } from "./canvas-generation-errors";

import { bindCanvasTaskOutput, type CanvasTaskBindReceipt } from "@/services/api/operations";
import { ApiError } from "@/services/api/request";
import { queryGenerationTask, type GenerationTask, type GenerationTaskDeliveryProgress, type GenerationTaskOutput } from "@/services/api/task-center";
import { CanvasBackendSubmitPausedError, isCanvasRevisionConflict } from "@/services/canvas-revision-conflict";
import { generationEffectApplied } from "@/services/generation-consumer-dedupe";
import { attachNodeEffectKey } from "@/services/generation-task-materializer";
import { persistCanvasDocument } from "@/services/local-workspace-repository";
import { hydrateBackendGeneratedOutputs, type ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import { publishGenerationDeliveryProgress } from "@/stores/use-generation-delivery-progress";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { recordCanvasBindingDiagnostic } from "@/services/diagnostics/canvas-binding-diagnostics";

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

import { healCanvasProjectMediaAssets, isCanvasMediaAssetGuardError, persistCanvasGenerationTarget, syncInMemoryCanvasProjectMediaAssets } from "./canvas-generation-target";
export { persistCanvasGenerationTarget };

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

export type AdoptServerConfirmedProjection = (project: CanvasProject) => Promise<CanvasProject | undefined>;
type PersistCanvasDocumentPatch = (id: string, patch: { nodes?: CanvasNodeData[]; connections?: CanvasConnection[]; timeline?: CanvasProject["timeline"] }) => Promise<void>;

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

type RefreshGenerationTask = (taskId: string, options: { signal?: AbortSignal }) => Promise<GenerationTask>;
type SleepWithSignal = (ms: number, signal?: AbortSignal) => Promise<void>;

export type BindBackendCanvasGenerationRuntime = {
    hydrateOutputs?: typeof hydrateBackendGeneratedOutputs;
    ensureNodeAsset?: typeof ensureCanvasNodeAsset;
    persistDocument?: PersistCanvasDocumentPatch;
    bindOutput?: typeof bindCanvasTaskOutput;
    adoptConfirmedProjection?: AdoptServerConfirmedProjection;
    refreshTask?: RefreshGenerationTask;
    sleep?: SleepWithSignal;
    now?: () => number;
    publishDeliveryProgress?: (taskId: string, progress: GenerationTaskDeliveryProgress | undefined) => void;
};

function isMediaGenerationTask(task: GenerationTask) {
    return task.type !== "canvas_text" && task.type !== "text_replay";
}

function generationTaskOutput(task: GenerationTask, outputIndex: number): GenerationTaskOutput | undefined {
    return task.outputs?.find((output) => output.outputIndex === outputIndex);
}

function generationTaskOutputMaterialized(task: GenerationTask, outputIndex: number) {
    return Boolean(generationTaskOutput(task, outputIndex)?.materializedAssetId);
}

function isOutputNotReadyError(error: unknown) {
    const reason = error instanceof ApiError ? error.reason : error && typeof error === "object" && "reason" in error ? (error as { reason?: unknown }).reason : undefined;
    return reason === "output_not_ready" || reason === "resource_not_ready";
}

async function waitForMaterializedGenerationOutput(
    state: {
        task: GenerationTask;
        outputIndex: number;
        signal?: AbortSignal;
        isCurrent: () => boolean;
        refreshTask: RefreshGenerationTask;
        sleep: SleepWithSignal;
        now: () => number;
        startedAt: number;
        publishDeliveryProgress: (taskId: string, progress: GenerationTaskDeliveryProgress | undefined) => void;
    },
    forceRefresh = false,
): Promise<GenerationTask> {
    return waitForMaterializedGenerationOutputs({ ...state, outputIndices: [state.outputIndex] }, forceRefresh);
}

export async function bindBackendCanvasGenerationResult(input: {
    canvasId: string;
    nodeId: string;
    task: GenerationTask;
    outputIndex?: number;
    signal?: AbortSignal;
    isCurrent: () => boolean;
    isNodeOwned?: () => boolean;
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    runtime?: BindBackendCanvasGenerationRuntime;
    onPhaseChange?: (phase: "fetching" | "saving") => void;
}) {
    if (input.task.status !== "succeeded") throw new Error("只有成功的任务才能绑定到画布");
    const runtime = input.runtime ?? {};
    const capturedCanvasId = input.canvasId;
    const node = input.nodesRef.current.find(item => item.id === input.nodeId);
    const outputs = input.outputIndex === undefined && input.task.resultJson ? parseBackendGenerationResult(input.task).outputs || [] : [];
    const chosen = outputs.find(item => item.id === node?.metadata?.primaryOutputId);
    const outputIndex = input.outputIndex ?? chosen?.outputIndex ?? primaryGenerationOutput(outputs, node?.type || input.task.type.replace(/^canvas_/, ""))?.outputIndex ?? 0;
    const hydrateOutputs = runtime.hydrateOutputs ?? hydrateBackendGeneratedOutputs;
    const persistDocument = runtime.persistDocument ?? persistCanvasDocument;
    const bindOutput = runtime.bindOutput ?? bindCanvasTaskOutput;
    const adoptConfirmedProjection = runtime.adoptConfirmedProjection ?? defaultAdoptConfirmedProjection;
    const refreshTask = runtime.refreshTask ?? ((taskId, options) => queryGenerationTask(taskId, options));
    const sleep = runtime.sleep ?? sleepWithSignal;
    const now = runtime.now ?? Date.now;
    const publishDeliveryProgress = runtime.publishDeliveryProgress ?? publishGenerationDeliveryProgress;
    const startedAt = now();
    // A mounted recovery can lose this node to a newer request while awaiting
    // hydration or persistence. Check again before dispatching a durable bind.
    const assertNodeOwnership = () => {
        if (input.isNodeOwned && !input.isNodeOwned()) throw new DOMException("The node belongs to a newer request", "AbortError");
    };

    const waitForMaterialization = (task: GenerationTask, forceRefresh = false) =>
        waitForMaterializedGenerationOutput(
            {
                task,
                outputIndex,
                signal: input.signal,
                isCurrent: input.isCurrent,
                refreshTask,
                sleep,
                now,
                startedAt,
                publishDeliveryProgress,
            },
            forceRefresh,
        );

    let task = input.task;
    if (task.outputs?.length && !generationTaskOutput(task, outputIndex)) throw new CanvasGenerationOutputMissingError(outputIndex);
    if (isMediaGenerationTask(task) && Boolean(task.outputs?.length) && !generationTaskOutputMaterialized(task, outputIndex)) {
        input.onPhaseChange?.("fetching");
        task = await waitForMaterialization(task);
    }
    input.onPhaseChange?.("saving");

    await hydrateOutputs(task, input.signal, {
        writeAsset: (asset) => {
            useAssetStore.setState((state) => (state.assets.some((item) => item.id === asset.id) ? state : { assets: [asset, ...state.assets] }));
        },
    });

    assertNodeOwnership();
    const live = useCanvasStore.getState().projects.find((project) => project.id === capturedCanvasId);
    if (live) {
        syncInMemoryCanvasProjectMediaAssets(live);
        try {
            await persistDocument(capturedCanvasId, { nodes: live.nodes, connections: live.connections });
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            if (isCanvasMediaAssetGuardError(error)) {
                try {
                    const targetProject = useCanvasStore.getState().projects.find((project) => project.id === capturedCanvasId) ?? live;
                    const healed = await healCanvasProjectMediaAssets(targetProject, {
                        ensureNodeAsset: runtime.ensureNodeAsset,
                        signal: input.signal,
                        isCurrent: input.isCurrent,
                        nodesRef: input.nodesRef,
                        setNodes: input.setNodes,
                    });
                    if (!healed.current) {
                        if (!input.isCurrent()) {
                            throw new DOMException("The canvas operation was abandoned", "AbortError");
                        }
                        throw error instanceof CanvasBindFlushError ? error : new CanvasBindFlushError(error);
                    }
                    const current = useCanvasStore.getState().openProject(capturedCanvasId);
                    if (!current) throw new DOMException("The canvas operation was abandoned", "AbortError");
                    await persistDocument(
                        capturedCanvasId,
                        {
                            nodes: current.nodes,
                            connections: current.connections,
                            ...(current.timeline ? { timeline: current.timeline } : {}),
                        },
                    );
                } catch (retryError) {
                    if (retryError instanceof Error && retryError.name === "AbortError") throw retryError;
                    throw retryError instanceof CanvasBindFlushError ? retryError : new CanvasBindFlushError(retryError);
                }
            } else if (!(isCanvasRevisionConflict(error) || error instanceof CanvasBackendSubmitPausedError)) {
                // 画布 document.commit 的陈旧 revision / 已暂停提交不能当成生成失败：
                // 资源已落盘，bind 回执才是画布真相；继续绑定后由三路合并保留并发节点。
                throw error instanceof CanvasBindFlushError ? error : new CanvasBindFlushError(error);
            }
        }
    }

    const operationId = attachNodeEffectKey(task.id, input.nodeId, outputIndex);
    let response: Awaited<ReturnType<typeof bindCanvasTaskOutput>>;
    let healedOnBind = false;
    recordCanvasBindingDiagnostic({ phase: "requested", canvasId: capturedCanvasId, nodeId: input.nodeId, outputIndex, task, project: useCanvasStore.getState().openProject(capturedCanvasId) ?? undefined });
    for (;;) {
        assertNodeOwnership();
        try {
            response = await bindOutput({
                operationId,
                canvasId: capturedCanvasId,
                taskId: task.id,
                traceId: task.traceId,
                nodeId: input.nodeId,
                outputIndex,
                signal: input.signal,
            });
            break;
        } catch (error) {
            const targetProject = useCanvasStore.getState().projects.find((project) => project.id === capturedCanvasId) ?? live;
            if (!healedOnBind && targetProject && isCanvasMediaAssetGuardError(error)) {
                healedOnBind = true;
                const healed = await healCanvasProjectMediaAssets(targetProject, {
                    ensureNodeAsset: runtime.ensureNodeAsset,
                    signal: input.signal,
                    isCurrent: input.isCurrent,
                    nodesRef: input.nodesRef,
                    setNodes: input.setNodes,
                });
                if (!healed.current) {
                    if (!input.isCurrent()) {
                        throw new DOMException("The canvas operation was abandoned", "AbortError");
                    }
                    throw error;
                }
                const current = useCanvasStore.getState().openProject(capturedCanvasId);
                if (!current) throw new DOMException("The canvas operation was abandoned", "AbortError");
                try {
                    await persistDocument(
                        capturedCanvasId,
                        {
                            nodes: current.nodes,
                            connections: current.connections,
                            ...(current.timeline ? { timeline: current.timeline } : {}),
                        },
                    );
                } catch (flushError) {
                    if (flushError instanceof Error && flushError.name === "AbortError") throw flushError;
                    throw flushError instanceof CanvasBindFlushError ? flushError : new CanvasBindFlushError(flushError);
                }
                continue;
            }
            // 交付仍在进行时 bind 会以 output_not_ready/resource_not_ready 拒绝；
            // 同一个 operationId 幂等，回到等待再重试，不把在途状态报成画布冲突。
            if (!isOutputNotReadyError(error)) {
                if (!(error instanceof Error && error.name === "AbortError")) recordCanvasBindingDiagnostic({ phase: "refused", canvasId: capturedCanvasId, nodeId: input.nodeId, outputIndex, task, error, project: useCanvasStore.getState().openProject(capturedCanvasId) ?? undefined });
                throw error;
            }
            input.onPhaseChange?.("fetching");
            task = await waitForMaterialization(task, true);
            input.onPhaseChange?.("saving");
        }
    }

    const receipt = response.result ?? {};
    if (receipt.bindingStatus === "deleted" && !receipt.canvas) return;
    const canonical = canonicalCanvasFromReceipt(capturedCanvasId, receipt);
    const adopted = await adoptConfirmedProjection(canonical);
    if (adopted && input.isCurrent()) {
        input.nodesRef.current = adopted.nodes;
        input.setNodes(adopted.nodes);
    }
    recordCanvasBindingDiagnostic({ phase: "confirmed", canvasId: capturedCanvasId, nodeId: input.nodeId, outputIndex, task, project: adopted });
}

async function defaultAdoptConfirmedProjection(project: CanvasProject) {
    const repository = await import("@/services/local-workspace-repository");
    const adopt = (repository as { adoptServerConfirmedGenerationPatch?: AdoptServerConfirmedProjection }).adoptServerConfirmedGenerationPatch;
    if (!adopt) throw new CanvasBindProjectionAdoptionError();
    return adopt(project);
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
        await persistCanvasDocument(input.projectId, { nodes });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        // 陈旧 revision / 已暂停提交不是生成失败：live 节点已在本地更新，普通保存会收敛。
        if (!(isCanvasRevisionConflict(error) || error instanceof CanvasBackendSubmitPausedError)) {
            throw new CanvasGenerationDurableAckError(error);
        }
    }
    input.nodesRef.current = nodes;
    input.setNodes(nodes);
}
