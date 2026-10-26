import type { Dispatch, SetStateAction } from "react";
import { CanvasGenerationDurableAckError, CanvasGenerationMaterializationError, CanvasGenerationOutputMissingError } from "./canvas-generation-errors";
export { CanvasGenerationDurableAckError, CanvasGenerationMaterializationError, CanvasGenerationOutputMissingError, CanvasGenerationTargetSaveError } from "./canvas-generation-errors";

import { assertUserScope, captureUserScope, isUserScopeAbandonedError, UserScopeAbandonedError, userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
import { bindCanvasTaskOutput, type CanvasTaskBindReceipt } from "@/services/api/operations";
import { ApiError } from "@/services/api/request";
import { queryGenerationTask, type GenerationTask, type GenerationTaskDeliveryProgress, type GenerationTaskOutput } from "@/services/api/task-center";
import { CanvasBackendSubmitPausedError, CanvasStaleScopeError, isCanvasRevisionConflict } from "@/services/canvas-revision-conflict";
import { generationEffectApplied } from "@/services/generation-consumer-dedupe";
import { attachNodeEffectKey } from "@/services/generation-task-materializer";
import { persistCanvasDocument } from "@/services/local-workspace-repository";
import { hydrateBackendGeneratedOutputs, type ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import { publishGenerationDeliveryProgress } from "@/stores/use-generation-delivery-progress";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { captureGeneratedVideoPreview, videoPreviewFromImage, type GeneratedVideoMedia } from "@/services/generated-video-preview";
import { CANVAS_VIDEO_PREVIEW_VERSION } from "@/services/canvas-video-preview";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { UploadedImage } from "@/services/image-storage";
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

export type AdoptServerConfirmedProjection = (project: CanvasProject, scope: string, entryCapturedScope?: CapturedUserScope) => Promise<CanvasProject | undefined>;
type PersistCanvasDocumentWithScope = (id: string, patch: { nodes?: CanvasNodeData[]; connections?: CanvasConnection[]; timeline?: CanvasProject["timeline"] }, entryCapturedScope?: CapturedUserScope) => Promise<void>;

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

type RefreshGenerationTask = (taskId: string, options: { signal?: AbortSignal; expectedScope: CapturedUserScope }) => Promise<GenerationTask>;
type SleepWithSignal = (ms: number, signal?: AbortSignal) => Promise<void>;

export type BindBackendCanvasGenerationRuntime = {
    hydrateOutputs?: typeof hydrateBackendGeneratedOutputs;
    ensureNodeAsset?: typeof ensureCanvasNodeAsset;
    persistDocument?: PersistCanvasDocumentWithScope;
    bindOutput?: typeof bindCanvasTaskOutput;
    adoptConfirmedProjection?: AdoptServerConfirmedProjection;
    captureScope?: () => CapturedUserScope;
    liveScope?: () => CapturedUserScope;
    refreshTask?: RefreshGenerationTask;
    sleep?: SleepWithSignal;
    now?: () => number;
    publishDeliveryProgress?: (taskId: string, progress: GenerationTaskDeliveryProgress | undefined) => void;
    /** 生成视频的首帧写入；和用户拖入视频共用同一套取帧代码。 */
    captureVideoPreview?: (media: GeneratedVideoMedia) => Promise<UploadedImage | undefined>;
};

// Delivery downloads the remote artifact after the task is already succeeded.
// While that runs the output has no materialized asset id, so binding would be
// refused with output_not_ready. Wait for the delivered output instead of
// reporting the transient state as a canvas conflict.
const GENERATION_MATERIALIZATION_BUDGET_MS = 15 * 60 * 1000;

const PERMANENT_MATERIALIZATION_ERROR_CODES = new Set(["resource_foreign", "asset_foreign", "unsupported_result_shape"]);

function materializationPollDelay(attempt: number) {
    const schedule = [1000, 2000, 3000, 5000];
    return schedule[Math.min(attempt, schedule.length - 1)];
}

function sleepWithSignal(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function isMediaGenerationTask(task: GenerationTask) {
    return task.type !== "canvas_text" && task.type !== "text_replay";
}

function generationTaskOutput(task: GenerationTask, outputIndex: number): GenerationTaskOutput | undefined {
    return task.outputs?.find((output) => output.outputIndex === outputIndex);
}

function generationTaskOutputMaterialized(task: GenerationTask, outputIndex: number) {
    return Boolean(generationTaskOutput(task, outputIndex)?.materializedAssetId);
}

function generationTaskOutputPermanentlyFailed(task: GenerationTask, outputIndex: number) {
    if (task.resultState === "FAILED_PERMANENT") return true;
    const code = generationTaskOutput(task, outputIndex)?.materializationErrorCode;
    return Boolean(code && PERMANENT_MATERIALIZATION_ERROR_CODES.has(code));
}

function generationTaskDeliveryProgress(task: GenerationTask, outputIndex: number): GenerationTaskDeliveryProgress | undefined {
    return task.delivery?.outputs.find((output) => output.outputIndex === outputIndex);
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
        expectedScope: CapturedUserScope;
        isCurrent: () => boolean;
        liveScope: () => CapturedUserScope;
        refreshTask: RefreshGenerationTask;
        sleep: SleepWithSignal;
        now: () => number;
        startedAt: number;
        publishDeliveryProgress: (taskId: string, progress: GenerationTaskDeliveryProgress | undefined) => void;
    },
    forceRefresh = false,
): Promise<GenerationTask> {
    let task = state.task;
    try {
        return await pollMaterializedGenerationOutput(state, forceRefresh, (next) => {
            task = next;
            state.publishDeliveryProgress(task.id, generationTaskDeliveryProgress(task, state.outputIndex));
        });
    } finally {
        state.publishDeliveryProgress(task.id, undefined);
    }
}

async function pollMaterializedGenerationOutput(
    state: Parameters<typeof waitForMaterializedGenerationOutput>[0],
    forceRefresh: boolean,
    observe: (task: GenerationTask) => void,
): Promise<GenerationTask> {
    let task = state.task;
    let attempt = 0;
    let skipCheck = forceRefresh;
    observe(task);
    for (;;) {
        if (state.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        if (!state.isCurrent()) throw new DOMException("The canvas operation was abandoned", "AbortError");
        assertBindDispatchScope(state.expectedScope, state.liveScope);
        // A materialized ID can outlive its resource. Repeated bind refusals
        // share this deadline even when the task still reports that ID.
        if (state.now() - state.startedAt >= GENERATION_MATERIALIZATION_BUDGET_MS) throw new CanvasGenerationMaterializationError(new Error("生成结果取回或写入画布超时，请继续取回"));
        if (!skipCheck) {
            if (generationTaskOutputMaterialized(task, state.outputIndex)) return task;
            const deliveryCode = generationTaskOutput(task, outputIndexFromState(state))?.materializationErrorCode || task.stage;
            if (deliveryCode === "delivery_paused" || deliveryCode === "delivery_timed_out") {
                throw new CanvasGenerationMaterializationError(new Error(deliveryCode === "delivery_paused" ? "已停止取回，可继续取回原结果" : "结果取回超时，可继续取回原结果"));
            }
            if (generationTaskOutputPermanentlyFailed(task, state.outputIndex)) throw new CanvasGenerationMaterializationError(new Error(task.resultState || task.error || "生成结果下载失败"));
        }
        await state.sleep(materializationPollDelay(attempt), state.signal);
        attempt += 1;
        task = await state.refreshTask(task.id, { signal: state.signal, expectedScope: state.expectedScope });
        observe(task);
        skipCheck = false;
    }
}

function outputIndexFromState(state: { outputIndex: number }) {
    return state.outputIndex;
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
    if (task.outputs?.length && !generationTaskOutput(task, outputIndex)) throw new CanvasGenerationOutputMissingError(outputIndex);
    if (isMediaGenerationTask(task) && Boolean(task.outputs?.length) && !generationTaskOutputMaterialized(task, outputIndex)) {
        input.onPhaseChange?.("fetching");
        task = await waitForMaterialization(task);
    }
    assertBindDispatchScope(capturedScope, liveScope);
    input.onPhaseChange?.("saving");

    await hydrateOutputs(task, input.signal, {
        writeAsset: (asset) => {
            if (!userScopeMatches(capturedScope, liveScope())) return;
            useAssetStore.setState((state) => (state.assets.some((item) => item.id === asset.id) ? state : { assets: [asset, ...state.assets] }));
        },
    });
    assertBindDispatchScope(capturedScope, liveScope);

    assertNodeOwnership();
    const live = useCanvasStore.getState().projects.find((project) => project.id === capturedCanvasId);
    if (live) {
        syncInMemoryCanvasProjectMediaAssets(live);
        try {
            await persistDocument(capturedCanvasId, { nodes: live.nodes, connections: live.connections }, capturedScope);
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            if (isUserScopeAbandonedError(error)) throw error;
            if (error instanceof CanvasStaleScopeError) throw error;
            assertBindDispatchScope(capturedScope, liveScope);
            if (isCanvasMediaAssetGuardError(error)) {
                try {
                    const targetProject = useCanvasStore.getState().projects.find((project) => project.id === capturedCanvasId) ?? live;
                    const healed = await healCanvasProjectMediaAssets(targetProject, {
                        ensureNodeAsset: runtime.ensureNodeAsset,
                        signal: input.signal,
                        expectedScope: capturedScope,
                        liveScope,
                        isCurrent: input.isCurrent,
                        nodesRef: input.nodesRef,
                        setNodes: input.setNodes,
                    });
                    assertBindDispatchScope(capturedScope, liveScope);
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
                        capturedScope,
                    );
                } catch (retryError) {
                    if (retryError instanceof Error && retryError.name === "AbortError") throw retryError;
                    if (isUserScopeAbandonedError(retryError)) throw retryError;
                    if (retryError instanceof CanvasStaleScopeError) throw retryError;
                    assertBindDispatchScope(capturedScope, liveScope);
                    throw retryError instanceof CanvasBindFlushError ? retryError : new CanvasBindFlushError(retryError);
                }
            } else if (!(isCanvasRevisionConflict(error) || error instanceof CanvasBackendSubmitPausedError)) {
                // 画布 document.commit 的陈旧 revision / 已暂停提交不能当成生成失败：
                // 资源已落盘，bind 回执才是画布真相；继续绑定后由三路合并保留并发节点。
                throw error instanceof CanvasBindFlushError ? error : new CanvasBindFlushError(error);
            }
        }
    }
    assertBindDispatchScope(capturedScope, liveScope);

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
                expectedScope: capturedScope,
            });
            break;
        } catch (error) {
            const targetProject = useCanvasStore.getState().projects.find((project) => project.id === capturedCanvasId) ?? live;
            if (!healedOnBind && targetProject && isCanvasMediaAssetGuardError(error)) {
                healedOnBind = true;
                assertBindDispatchScope(capturedScope, liveScope);
                const healed = await healCanvasProjectMediaAssets(targetProject, {
                    ensureNodeAsset: runtime.ensureNodeAsset,
                    signal: input.signal,
                    expectedScope: capturedScope,
                    liveScope,
                    isCurrent: input.isCurrent,
                    nodesRef: input.nodesRef,
                    setNodes: input.setNodes,
                });
                assertBindDispatchScope(capturedScope, liveScope);
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
                        capturedScope,
                    );
                } catch (flushError) {
                    if (flushError instanceof Error && flushError.name === "AbortError") throw flushError;
                    if (isUserScopeAbandonedError(flushError)) throw flushError;
                    if (flushError instanceof CanvasStaleScopeError) throw flushError;
                    assertBindDispatchScope(capturedScope, liveScope);
                    throw flushError instanceof CanvasBindFlushError ? flushError : new CanvasBindFlushError(flushError);
                }
                assertBindDispatchScope(capturedScope, liveScope);
                continue;
            }
            // 交付仍在进行时 bind 会以 output_not_ready/resource_not_ready 拒绝；
            // 同一个 operationId 幂等，回到等待再重试，不把在途状态报成画布冲突。
            if (!isOutputNotReadyError(error)) {
                if (userScopeMatches(capturedScope, liveScope()) && !(error instanceof Error && error.name === "AbortError")) recordCanvasBindingDiagnostic({ phase: "refused", canvasId: capturedCanvasId, nodeId: input.nodeId, outputIndex, task, error, project: useCanvasStore.getState().openProject(capturedCanvasId) ?? undefined });
                throw error;
            }
            assertBindDispatchScope(capturedScope, liveScope);
            input.onPhaseChange?.("fetching");
            task = await waitForMaterialization(task, true);
            assertBindDispatchScope(capturedScope, liveScope);
            input.onPhaseChange?.("saving");
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
    // 后端绑定回执会清掉上一个视频的预览，但不会为新视频生成首帧。
    // 这里补一张，节点才会像用户拖入的视频那样显示首帧。
    if (!(receipt.bindingStatus === "deleted")) {
        await stampGeneratedVideoPreview({
            canvasId: capturedCanvasId,
            nodeId: input.nodeId,
            task,
            adopted,
            nodesRef: input.nodesRef,
            setNodes: input.setNodes,
            persistDocument,
            capturedScope,
            liveScope,
            isCurrent: input.isCurrent,
            captureVideoPreview: runtime.captureVideoPreview ?? captureGeneratedVideoPreview,
        });
    }
    recordCanvasBindingDiagnostic({ phase: "confirmed", canvasId: capturedCanvasId, nodeId: input.nodeId, outputIndex, task, project: adopted });
}

/**
 * 生成完成的视频要有一张首帧。取帧或保存失败只留诊断日志：
 * 视频已经绑定成功，不能因为首帧把结果报成失败；节点下次打开时会重新读取。
 */
async function stampGeneratedVideoPreview(input: {
    canvasId: string;
    nodeId: string;
    task: GenerationTask;
    adopted?: CanvasProject;
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    persistDocument: PersistCanvasDocumentWithScope;
    capturedScope: CapturedUserScope;
    liveScope: () => CapturedUserScope;
    isCurrent: () => boolean;
    captureVideoPreview: (media: GeneratedVideoMedia) => Promise<UploadedImage | undefined>;
}) {
    if (!isVideoGenerationTask(input.task)) return;
    const nodes = input.adopted?.nodes ?? input.nodesRef.current;
    const node = nodes.find((item) => item.id === input.nodeId);
    if (!node || node.type !== CanvasNodeType.Video) return;
    const storageKey = node.metadata?.storageKey || "";
    const content = node.metadata?.content || "";
    const sourceKey = storageKey || content;
    if (!sourceKey) return;
    const existing = node.metadata?.videoPreview;
    // 已经属于当前视频的首帧不再取一次，重复打开结果不会重复解码。
    if (existing?.content && existing.captureVersion === CANVAS_VIDEO_PREVIEW_VERSION && existing.sourceKey === sourceKey) return;

    let image: UploadedImage | undefined;
    try {
        image = await input.captureVideoPreview({ storageKey, content });
    } catch (error) {
        console.warn("生成视频的首帧没能读取，节点仍可播放", { nodeId: input.nodeId, storageKey, error });
        return;
    }
    const preview = videoPreviewFromImage(image, sourceKey);
    if (!preview || !input.isCurrent() || !userScopeMatches(input.capturedScope, input.liveScope())) return;

    // 取帧要等视频解码，期间用户可能删掉这个节点、换成别的视频，或改了别的节点。
    // 因此以取帧结束时的最新节点列表为准，只给来源没变的那个节点补首帧。
    const latest = useCanvasStore.getState().openProject(input.canvasId)?.nodes ?? input.nodesRef.current;
    const current = latest.find((item) => item.id === input.nodeId);
    if (!current || current.type !== CanvasNodeType.Video) return;
    if ((current.metadata?.storageKey || current.metadata?.content || "") !== sourceKey) return;
    const patched = latest.map((item) => (item.id === current.id ? { ...item, metadata: { ...item.metadata, videoPreview: preview } } : item));
    input.nodesRef.current = patched;
    input.setNodes(patched);
    try {
        await input.persistDocument(input.canvasId, { nodes: patched }, input.capturedScope);
    } catch (error) {
        // 内存里已经显示首帧，保存失败下次打开项目会重新读取，不回滚视频结果。
        console.warn("生成视频的首帧没能写入画布，下次打开项目会重新读取", { nodeId: input.nodeId, storageKey, error });
    }
}

// 视频任务只有 canvas_video 一种；媒体类型兜底给没带 outputs 的历史任务。
function isVideoGenerationTask(task: GenerationTask) {
    return task.type === "canvas_video" || (task.type !== "canvas_image" && task.type !== "canvas_audio" && task.type !== "canvas_text" && Boolean(task.outputs?.length) && task.outputs!.every((output) => output.mediaType === "video"));
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
