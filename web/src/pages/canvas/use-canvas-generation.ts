import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { App } from "antd";

import { generationTaskCanReloadResource, generationTaskNodeId } from "@/lib/canvas/canvas-generation-task-sync";
import { bindBackendCanvasGenerationResult, CanvasGenerationDurableAckError, isCanvasGenerationDurableAckError } from "@/services/canvas-generation-consumer";
import { captureUserScope, isUserScopeAbandonedError, userScopeMatches } from "@/lib/user-scope-guard";
import { ensureCanvasNodeAsset, retryCanvasAssetSyncAfterRateLimit } from "@/services/project-asset-sync";
import { listGenerationTasks, queryFailedVideoProviderTask, subscribeGenerationTasks, type GenerationTask } from "@/services/api/task-center";
import { useTaskDetails } from "@/hooks/use-task-details";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import { generationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { generationFailureMetadata } from "@/lib/generation-error";
import { canvasTaskFailureMetadata } from "./canvas-generation-failure";
import { runGenerationConsumer } from "@/services/generation-consumer-lifecycle";
import { consumeCanvasGenerationContinuation } from "./use-canvas-operation-history";

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

type UseCanvasGenerationOptions = {
    projectId: string;
    domainProjectId?: string;
    projectLoaded: boolean;
    nodes: CanvasNodeData[];
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
};

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

export function subscribeCanvasGenerationRecoveryTasks(ids: readonly string[], listener: (task: GenerationTask) => void, subscribe: (ids: readonly string[], listener: (task: GenerationTask) => void) => () => void = subscribeGenerationTasks) {
    return subscribe(Array.from(new Set(ids)), listener);
}

export type CanvasGenerationRecoveryContext = {
    projectId: string;
    controller: AbortController;
    signal: AbortSignal;
    isCurrentProject: () => boolean;
};

export function createCanvasGenerationRecoveryCoordinator() {
    let active:
        | {
              token: symbol;
              controller: AbortController;
          }
        | undefined;
    let transitionTail = Promise.resolve();

    return {
        switchProject(projectId: string, operation: (context: CanvasGenerationRecoveryContext) => Promise<void>) {
            active?.controller.abort();
            const token = Symbol(projectId);
            const controller = new AbortController();
            const previousTail = transitionTail;
            const settled = previousTail.then(async () => {
                if (controller.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
                await operation({
                    projectId,
                    controller,
                    signal: controller.signal,
                    isCurrentProject: () => active?.token === token && !controller.signal.aborted,
                });
            });
            active = { token, controller };
            transitionTail = settled.then(
                () => undefined,
                () => undefined,
            );
            return settled;
        },
        async abortAndDrain() {
            active?.controller.abort();
            active = undefined;
            await transitionTail;
        },
    };
}

export async function recoverCanvasGenerationTaskNode(input: {
    projectId: string;
    node: CanvasNodeData;
    completed: GenerationTask;
    continuationOnly: boolean;
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    applyGenerationTaskResult: (nodeId: string, task: GenerationTask) => Promise<void>;
    signal: AbortSignal;
    isCurrentProject?: () => boolean;
    consumeContinuation?: typeof consumeCanvasGenerationContinuation;
}) {
    const isCurrentProject = () => !input.signal.aborted && (input.isCurrentProject?.() ?? true);
    if (!isCurrentProject()) return;
    const consumeContinuation = input.consumeContinuation ?? consumeCanvasGenerationContinuation;
    const recoveryBaseNodes = useCanvasStore.getState().projects.find((project) => project.id === input.projectId)?.nodes ?? input.nodesRef.current;
    try {
        if (input.completed.projectId && input.completed.projectId !== input.projectId) throw new Error("生成任务不属于当前画布");
        if (!isCurrentProject()) return;
        if (input.completed.status === "failed" || input.completed.status === "cancelled") {
            throw new Error(input.completed.error || (input.completed.status === "cancelled" ? "任务已取消" : "任务失败"));
        }
        if (!input.continuationOnly) {
            if (!isCurrentProject()) return;
            await input.applyGenerationTaskResult(input.node.id, input.completed);
        }
        if (!isCurrentProject()) return;
        const continuation = input.nodesRef.current.find((item) => item.id === input.node.id)?.metadata?.agentGenerationContinuation ?? input.node.metadata?.agentGenerationContinuation;
        if (continuation?.status === "pending" && continuation.taskId === input.completed.id) {
            await consumeContinuation(
                input.completed,
                continuation,
                (nextContinuation) => {
                    if (!isCurrentProject()) return;
                    input.setNodes((current) =>
                        current.map((item) =>
                            item.id === input.node.id
                                ? {
                                      ...item,
                                      metadata: {
                                          ...item.metadata,
                                          agentGenerationContinuation: nextContinuation,
                                          ...(nextContinuation.effectKey
                                              ? {
                                                    generationEffectKeys: Array.from(new Set([...(item.metadata?.generationEffectKeys || []), nextContinuation.effectKey])),
                                                }
                                              : {}),
                                      },
                                  }
                                : item,
                        ),
                    );
                },
                { projectId: input.projectId, nodeId: input.node.id, previousNodes: recoveryBaseNodes, nodesRef: input.nodesRef, setNodes: input.setNodes },
                input.signal,
            );
        }
    } catch (error) {
        if (!isCurrentProject() || (error instanceof Error && error.name === "AbortError")) return;
        if (isCanvasGenerationDurableAckError(error)) return;
        const failure = canvasTaskFailureMetadata(input.completed, input.nodesRef.current.find((item) => item.id === input.node.id)?.metadata || input.node.metadata, error);
        input.setNodes((current) =>
            current.map((item) =>
                item.id === input.node.id
                    ? {
                          ...item,
                          metadata: {
                              ...item.metadata,
                              status: input.continuationOnly ? item.metadata?.status : NODE_STATUS_ERROR,
                              ...(input.continuationOnly ? {} : failure),
                              ...(item.metadata?.agentGenerationContinuation?.status === "pending"
                                  ? {
                                        agentGenerationContinuation: { ...item.metadata.agentGenerationContinuation, status: "failed" as const },
                                    }
                                  : {}),
                          },
                      }
                    : item,
            ),
        );
    }
}

export function useCanvasGeneration({ projectId, domainProjectId, projectLoaded, nodes, nodesRef, setNodes }: UseCanvasGenerationOptions) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const recoveringTaskIdsRef = useRef(new Set<string>());
    const autoSavedTaskIdsRef = useRef(new Set<string>());
    const consumerControllerRef = useRef(new AbortController());
    const recoveryCoordinatorRef = useRef<ReturnType<typeof createCanvasGenerationRecoveryCoordinator> | null>(null);
    if (!recoveryCoordinatorRef.current) recoveryCoordinatorRef.current = createCanvasGenerationRecoveryCoordinator();
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [taskDetail, setTaskDetail] = useState<GenerationTask | null>(null);
    const [retrievingTaskId, setRetrievingTaskId] = useState<string | null>(null);
    const retrievalRef = useRef<object | null>(null);
    const taskDetailQuery = useTaskDetails(taskDetail?.id, projectId);
    const localMode = isLocalWorkspaceMode();

    useEffect(() => setTaskDetail(null), [projectId]);

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) generationRequestsRef.current.delete(targetNodeId);
    }, []);

    const openNodeTaskDetails = useCallback(
        async (node: CanvasNodeData) => {
            const taskId = node.metadata?.taskId;
            if (!taskId) return;
            setTaskDetail({
                id: taskId,
                type: "",
                status: (node.metadata?.taskStatus as GenerationTask["status"]) || "running",
                stage: node.metadata?.taskStage,
                progress: node.metadata?.taskProgress,
                prompt: node.metadata?.prompt || "",
                attempts: 1,
                createdAt: node.metadata?.taskCreatedAt || new Date().toISOString(),
                updatedAt: node.metadata?.taskUpdatedAt || new Date().toISOString(),
            });
        },
        [],
    );

    const bindGenerationTask = useCallback(
        (targetNodeId: string, task: GenerationTask) => {
            setNodes((current) =>
                current.map((node) => {
                    if (node.id !== targetNodeId) return node;
                    const failed = task.status === "failed" || task.status === "cancelled";
                    const hasCompletedContent = task.status === "succeeded" && Boolean(node.metadata?.content);
                    const failure = failed ? canvasTaskFailureMetadata(task, node.metadata) : undefined;
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            ...generationTaskMetadata(task),
                            status: failed ? NODE_STATUS_ERROR : hasCompletedContent ? NODE_STATUS_SUCCESS : NODE_STATUS_LOADING,
                            ...(failure || { errorDetails: undefined, generationErrorCode: undefined, resourceReloadAvailable: undefined, failedPromptFingerprint: undefined, failedInputFingerprint: undefined }),
                        },
                    };
                }),
            );
        },
        [setNodes],
    );

    const saveGeneratedAsset = useCallback(
        async (node: CanvasNodeData, taskId: string, signal?: AbortSignal) => {
            const result = await retryCanvasAssetSyncAfterRateLimit(() => ensureCanvasNodeAsset({ canvasId: projectId, domainProjectId, node, source: "canvas-generation", taskId, signal }), { signal });
            setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, assetId: result.assetId } } : item)));
            if (domainProjectId) await queryClient.invalidateQueries({ queryKey: ["project", domainProjectId] });
        },
        [domainProjectId, projectId, queryClient, setNodes],
    );

    const applyGenerationTaskResult = useCallback(
        async (nodeId: string, task: GenerationTask) => {
            const capturedScope = captureUserScope();
            const capturedCanvasId = projectId;
            const controller = consumerControllerRef.current;
            const isCurrentCanvas = () => !controller.signal.aborted && userScopeMatches(capturedScope);
            if (task.status !== "succeeded") {
                if (generationTaskCanReloadResource(task) && isCurrentCanvas()) {
                    setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, resourceReloadAvailable: true } } : node)));
                }
                throw new Error(task.error || (task.status === "cancelled" ? "任务已取消" : "任务失败"));
            }
            try {
                await bindBackendCanvasGenerationResult({
                    canvasId: capturedCanvasId,
                    nodeId,
                    task,
                    outputIndex: 0,
                    signal: controller.signal,
                    isCurrent: isCurrentCanvas,
                    nodesRef,
                    setNodes,
                });
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") throw error;
                if (isUserScopeAbandonedError(error)) return;
                throw error instanceof CanvasGenerationDurableAckError ? error : new CanvasGenerationDurableAckError(error);
            }
        },
        [nodesRef, projectId, setNodes],
    );

    const retrieveTaskResult = useCallback(async (task: GenerationTask) => {
        if (retrievalRef.current) return;
        const retrieval = {};
        retrievalRef.current = retrieval;
        const signal = consumerControllerRef.current.signal;
        setRetrievingTaskId(task.id);
        try {
            const result = await queryFailedVideoProviderTask(task.id);
            if (signal.aborted) return;
            await queryClient.cancelQueries({ queryKey: ["task-details", projectId, task.id] });
            if (signal.aborted) return;
            queryClient.setQueryData(["task-details", projectId, task.id], (current: { task: GenerationTask; logs: unknown[] } | undefined) => ({ task: result.task, logs: current?.logs ?? [] }));
            if (result.recovered) {
                const node = nodesRef.current.find((item) => item.metadata?.taskId === task.id);
                if (!node) throw new Error("视频已取回，请在生成历史中查看");
                await applyGenerationTaskResult(node.id, result.task);
                if (signal.aborted) return;
                message.success("视频已取回并放回画布，未重新生成");
            } else {
                message.info("原任务仍在处理中，请稍后再取回结果");
            }
            void queryClient.invalidateQueries({ queryKey: ["task-details", projectId, task.id] });
        } catch (error) {
            if (!signal.aborted) message.error(error instanceof Error ? error.message : "暂时无法取回结果，请稍后再试");
        } finally {
            if (retrievalRef.current === retrieval) {
                retrievalRef.current = null;
                setRetrievingTaskId(null);
            }
        }
    }, [applyGenerationTaskResult, message, nodesRef, projectId, queryClient]);

    const observeSubscribedGenerationTask = useCallback(
        (taskId: string, signal: AbortSignal, onUpdate?: (task: GenerationTask) => void) =>
            new Promise<GenerationTask>((resolve, reject) => {
                let unsubscribe: (() => void) | undefined;
                let settled = false;
                const cleanup = () => {
                    signal.removeEventListener("abort", onAbort);
                    unsubscribe?.();
                };
                const onAbort = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(new DOMException("Aborted", "AbortError"));
                };
                const onTask = (task: GenerationTask) => {
                    if (settled) return;
                    onUpdate?.(task);
                    if (task.status !== "succeeded" && task.status !== "failed" && task.status !== "cancelled") return;
                    settled = true;
                    cleanup();
                    resolve(task);
                };
                if (signal.aborted) return onAbort();
                signal.addEventListener("abort", onAbort, { once: true });
                unsubscribe = subscribeCanvasGenerationRecoveryTasks([taskId], onTask);
                if (settled) unsubscribe();
            }),
        [],
    );

    const recoverInterruptedGenerationTasks = useCallback(
        async (startedProjectId: string, signal: AbortSignal, isCurrentProject: () => boolean) => {
            if (!isCurrentProject()) return;
            const recoveryNodes = nodesRef.current.filter((node) => {
                if (isDepthCaptureResultNode(node)) return false;
                const pendingAgentContinuation = node.metadata?.agentGenerationContinuation?.status === "pending";
                const aggregateBatchRoot = node.metadata?.isBatchRoot && node.metadata.batchChildIds?.length && !node.metadata.taskId;
                if (aggregateBatchRoot && !pendingAgentContinuation) return false;
                return pendingAgentContinuation || node.metadata?.status === NODE_STATUS_LOADING || node.metadata?.errorDetails === "页面刷新后生成已中断，请重新生成。" || Boolean(node.metadata?.taskId && node.metadata.status !== NODE_STATUS_SUCCESS);
            });
            const needsDiscovery = recoveryNodes.some((node) => !node.metadata?.taskId && !node.metadata?.agentGenerationContinuation?.taskId);
            const projectTasks = needsDiscovery && !localMode
                ? (
                      await listGenerationTasks(100, { projectId: startedProjectId }, undefined, signal).catch((error) => {
                          if (!isCurrentProject()) throw error;
                          return [];
                      })
                  ).filter((task) => task.projectId === startedProjectId && task.type.startsWith("canvas_"))
                : [];
            if (!isCurrentProject()) return;
            await Promise.all(
                recoveryNodes.map(async (node) => {
                    const discoveredTask = projectTasks.find((task) => generationTaskNodeId(task) === node.id);
                    const taskId = node.metadata?.taskId || node.metadata?.agentGenerationContinuation?.taskId || discoveredTask?.id;
                    if (!taskId) {
                        if (!isCurrentProject()) return;
                        setNodes((current) =>
                            isCurrentProject() ? current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: "页面刷新后找不到对应任务，请重新生成。" } } : item)) : current,
                        );
                        return;
                    }
                    if (recoveringTaskIdsRef.current.has(taskId)) return;
                    recoveringTaskIdsRef.current.add(taskId);
                    const continuationOnly = !node.metadata?.taskId && node.metadata?.agentGenerationContinuation?.taskId === taskId && !discoveredTask;
                    try {
                        const completed = await observeSubscribedGenerationTask(taskId, signal, (task) => {
                            if (isCurrentProject() && !continuationOnly) bindGenerationTask(node.id, task);
                        });
                        if (!isCurrentProject()) return;
                        await recoverCanvasGenerationTaskNode({
                            projectId: startedProjectId,
                            node,
                            completed,
                            continuationOnly,
                            nodesRef,
                            setNodes,
                            applyGenerationTaskResult,
                            signal,
                            isCurrentProject,
                        });
                    } catch (error) {
                        if (!isCurrentProject() || (error instanceof Error && error.name === "AbortError")) return;
                        const currentMetadata = nodesRef.current.find((item) => item.id === node.id)?.metadata || node.metadata;
                        const failure = generationFailureMetadata(error, currentMetadata?.prompt || "", currentMetadata?.references || []);
                        if (failure.failedInputFingerprint && currentMetadata?.failedInputFingerprint) {
                            failure.failedInputFingerprint = currentMetadata.failedInputFingerprint;
                            failure.failedPromptFingerprint = currentMetadata.failedPromptFingerprint;
                        }
                        setNodes((current) =>
                            isCurrentProject()
                                ? current.map((item) =>
                                      item.id === node.id
                                          ? {
                                                ...item,
                                                metadata: {
                                                    ...item.metadata,
                                                    status: continuationOnly ? item.metadata?.status : NODE_STATUS_ERROR,
                                                    ...(continuationOnly ? {} : failure),
                                                    ...(item.metadata?.agentGenerationContinuation?.status === "pending"
                                                        ? {
                                                              agentGenerationContinuation: { ...item.metadata.agentGenerationContinuation, status: "failed" as const },
                                                          }
                                                        : {}),
                                                },
                                            }
                                          : item,
                                  )
                                : current,
                        );
                    } finally {
                        recoveringTaskIdsRef.current.delete(taskId);
                    }
                }),
            );
            if (!isCurrentProject()) return;
            setNodes((current) =>
                isCurrentProject()
                    ? current.map((node) => {
                          if (!node.metadata?.isBatchRoot || !node.metadata.batchChildIds?.length || node.metadata.taskId) return node;
                          const children = node.metadata.batchChildIds.map((id) => current.find((item) => item.id === id)).filter(Boolean) as CanvasNodeData[];
                          const primary = children.find((item) => item.id === node.metadata?.primaryImageId && item.metadata?.content) || children.find((item) => item.metadata?.content);
                          const loading = children.some((item) => item.metadata?.status === NODE_STATUS_LOADING);
                          const failed = children.find((item) => item.metadata?.status === NODE_STATUS_ERROR);
                          return {
                              ...node,
                              metadata: {
                                  ...node.metadata,
                                  ...(primary
                                      ? {
                                            content: primary.metadata?.content,
                                            storageKey: primary.metadata?.storageKey,
                                            mimeType: primary.metadata?.mimeType,
                                            bytes: primary.metadata?.bytes,
                                            naturalWidth: primary.metadata?.naturalWidth,
                                            naturalHeight: primary.metadata?.naturalHeight,
                                            primaryImageId: primary.id,
                                        }
                                      : {}),
                                  status: primary ? NODE_STATUS_SUCCESS : loading ? NODE_STATUS_LOADING : NODE_STATUS_ERROR,
                                  errorDetails: primary ? undefined : failed?.metadata?.errorDetails || "全部图片生成失败",
                              },
                          };
                      })
                    : current,
            );
        },
        [applyGenerationTaskResult, bindGenerationTask, localMode, nodesRef, observeSubscribedGenerationTask, setNodes],
    );

    useEffect(() => {
        const coordinator = recoveryCoordinatorRef.current!;
        if (!projectLoaded) {
            void coordinator.abortAndDrain();
            return;
        }
        void coordinator
            .switchProject(projectId, async (context) => {
                recoveringTaskIdsRef.current.clear();
                consumerControllerRef.current = context.controller;
                await runGenerationConsumer(context.signal, async (signal) => recoverInterruptedGenerationTasks(context.projectId, signal, () => !signal.aborted && context.isCurrentProject()));
            })
            .catch((error) => {
                if (!(error instanceof Error && error.name === "AbortError")) throw error;
            });
        return () => {
            void coordinator.abortAndDrain();
        };
    }, [projectId, projectLoaded, recoverInterruptedGenerationTasks]);

    // 本地任务同样持久化在任务表中，优先由上面的任务恢复流程按 taskId 对账。
    // 这里只把没有持久任务身份的孤立 loading 快照标记为中断，避免覆盖已完成任务。
    useEffect(() => {
        if (!projectLoaded || !localMode) return;
        setNodes((current) => {
            let changed = false;
            const next = current.map((node) => {
                const metadata = node.metadata;
                if (!metadata || metadata.status !== NODE_STATUS_LOADING || metadata.content || metadata.taskId || metadata.agentGenerationContinuation?.status === "pending" || generationRequestsRef.current.has(node.id)) return node;
                changed = true;
                return {
                    ...node,
                    metadata: {
                        ...metadata,
                        status: NODE_STATUS_ERROR,
                        taskStatus: "failed" as const,
                        taskStage: undefined,
                        taskUpdatedAt: new Date().toISOString(),
                        errorDetails: "页面刷新后本地生成已中断，请重新生成。",
                    },
                };
            });
            return changed ? next : current;
        });
    }, [localMode, projectLoaded, setNodes]);

    useEffect(
        () => () => {
            void recoveryCoordinatorRef.current?.abortAndDrain();
            consumerControllerRef.current.abort();
            generationRequestsRef.current.forEach((request) => request.controller.abort());
            generationRequestsRef.current.clear();
        },
        [],
    );

    useEffect(() => {
        if (!projectLoaded || localMode) return;
        nodes.forEach((node) => {
            const taskId = node.metadata?.taskId;
            if (!taskId || !node.metadata?.content || node.metadata.status !== NODE_STATUS_SUCCESS || (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio)) return;
            const saveKey = `${taskId}:${node.id}:${domainProjectId || "personal"}`;
            if (autoSavedTaskIdsRef.current.has(saveKey)) return;
            autoSavedTaskIdsRef.current.add(saveKey);
            void runGenerationConsumer(consumerControllerRef.current.signal, async (signal) => {
                await saveGeneratedAsset(node, taskId, signal);
            }).catch((error) => {
                autoSavedTaskIdsRef.current.delete(saveKey);
                if (error instanceof Error && error.name === "AbortError") return;
                message.warning({
                    key: `canvas-asset-sync:${projectId}`,
                    content: error instanceof Error ? `生成结果已保留，但项目资产同步失败：${error.message}` : "生成结果已保留，但项目资产同步失败",
                    duration: 4,
                });
            });
        });
    }, [domainProjectId, localMode, message, nodes, projectId, projectLoaded, saveGeneratedAsset]);

    return {
        applyGenerationTaskResult,
        bindGenerationTask,
        finishGenerationRequest,
        openNodeTaskDetails,
        retrieveTaskResult,
        retrievingTaskId,
        runningNodeId,
        setRunningNodeId,
        setTaskDetail,
        startGenerationRequest,
        taskDetail: taskDetail ? taskDetailQuery.data?.task ?? taskDetail : null,
        taskDetailLoading: taskDetailQuery.isLoading,
        taskDetailError: taskDetailQuery.isError,
        taskDetailLogs: taskDetailQuery.data?.logs ?? [],
    };
}
