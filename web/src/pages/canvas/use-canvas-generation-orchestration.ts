import { hydrateBackendGeneratedOutputs } from "@/services/project-asset-sync";
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import { nanoid } from "nanoid";
import { buildGenerationConfig } from "@/lib/canvas/canvas-project-generation";
import { findAvailableGenerationGroupPosition } from "@/lib/canvas/canvas-generation-layout";
import { runCanvasGenerationSubmissionOnce } from "@/lib/canvas/canvas-generation-submission";
import { canConvertCanvasVideoDraft, resolveCanvasVideoDraftSource } from "@/lib/canvas/canvas-video-draft";
import type { InlineVideoTrimRange } from "@/lib/canvas/canvas-video-inline-trim";
import { buildCanvasVideoRetake, canvasVideoRetakeModel } from "@/lib/canvas/canvas-video-retake";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";

import { promoteLegacyBatchTableSize } from "@/lib/canvas/canvas-batch-table";
import { persistCanvasDocument } from "@/services/local-workspace-repository";
import { cancelGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { canvasTaskConfirmation } from "./canvas-task-confirmation";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import type { Skill } from "@/services/api/skills";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";

import {
    createImageNodeFromTextSource,
    createImageLayerSplit,
    createInsertingHistoryGate,
    rebaseInsertedCanvasNode,
    reconcileImageBatchRootNodes,
    resolveVideoEditNodeDraft,
    runImageBatchChildRetry,
    runOwnedCanvasHistoryInsert,
    selectRetryableImageBatchChildren,
} from "./canvas-generation-orchestration";
import { readOwnedCanvasNodes, useCanvasOwnerLifetime } from "./canvas-owner-epoch";
import { useCanvasBatchTable } from "./use-canvas-batch-table";
import { useCanvasGeneration } from "./use-canvas-generation";
import { useCanvasGenerationBatches } from "./use-canvas-generation-batches";
import { useCanvasGenerationExecutor } from "./use-canvas-generation-executor";
import { useCanvasGenerationRetry } from "./use-canvas-generation-retry";
import { useCanvasStoryboard } from "./use-canvas-storyboard";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";

type UseCanvasGenerationOrchestrationOptions = {
    pageUi: CanvasPageUiStoreHook;
    readOnly?: boolean;
    onEditGenerationInput?: (node: CanvasNodeData) => void;
    projectId: string;
    /** 生成任务查询与 live 绑定：短剧关闭时为空。 */
    linkedProjectId?: string;
    /** 执行器 / 重试 / 历史插入的素材归属，沿用当前画布项目 id。 */
    domainProjectId?: string;
    projectLoaded: boolean;
    localOnly: boolean;
    addedSkills: Skill[];
    assets: Asset[];
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setGenerationHistoryOpen: Dispatch<SetStateAction<boolean>>;
    getCanvasCenter: () => Position;
};

export function useCanvasGenerationOrchestration({
    pageUi,
    readOnly = false,
    onEditGenerationInput,
    projectId,
    linkedProjectId,
    domainProjectId,
    projectLoaded,
    localOnly,
    addedSkills,
    assets,
    nodes,
    connections,
    nodesRef,
    connectionsRef,
    setNodes,
    setConnections,
    setGenerationHistoryOpen,
    getCanvasCenter,
}: UseCanvasGenerationOrchestrationOptions) {
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
    const effectiveConfig = useEffectiveConfig();
    const insertingHistory = useRef(createInsertingHistoryGate());
    const layerSplitSubmissions = useRef(new Map<string, Promise<unknown>>());
    const draftConversionSubmissions = useRef(new Map<string, Promise<unknown>>());
    const retakeSubmissions = useRef(new Map<string, Promise<unknown>>());
    const projectIdRef = useRef(projectId);
    projectIdRef.current = projectId;
    const { lifetime } = useCanvasOwnerLifetime(projectId);

    const {
        applyGenerationTaskResult,
        bindGenerationTask,
        cancelNodeGeneration,
        finishGenerationRequest,
        openNodeTaskDetails,
        retrieveTaskResult,
        retrievingTaskId,
        runningNodeId,
        setRunningNodeId,
        setTaskDetail,
        startGenerationRequest,
        taskDetail,
        taskDetailLoading,
        taskDetailError,
        taskDetailLogs,
    } = useCanvasGeneration({
        projectId,
        domainProjectId: linkedProjectId,
        projectLoaded,
        nodes,
        nodesRef,
        setNodes,
    });

    const getLiveProjectId = useCallback(() => projectIdRef.current, []);

    const handleGenerateNode = useCanvasGenerationExecutor({
        pageUi,
        projectId,
        ownerLifetime: lifetime,
        getLiveProjectId,
        domainProjectId,
        addedSkills,
        assets,
        nodesRef,
        connectionsRef,
        setNodes,
        setConnections,
        setRunningNodeId,
        startGenerationRequest,
        finishGenerationRequest,
        bindGenerationTask,
        applyGenerationTaskResult,
    });

    const { enqueueGenerationBatch, retryFailedBatchItems, stopRemainingBatchItems } = useCanvasGenerationBatches({
        projectId,
        projectLoaded,
        nodes,
        nodesRef,
        setNodes,
        handleGenerateNode,
    });

    const {
        addReferenceColumn: addBatchReferenceColumn,
        addRow: addBatchRow,
        fillRowsFromConnections,
        generateRows: generateBatchRows,
        moveReferenceCell: moveBatchReferenceCell,
        patchTable: patchBatchTable,
        removeReferenceColumn: removeBatchReferenceColumn,
        removeRow: removeBatchRow,
        reorderReferenceColumns: reorderBatchReferenceColumns,
        syncRowsFromConnections,
        updateRow: updateBatchRow,
    } = useCanvasBatchTable({
        pageUi,
        projectId,
        nodesRef,
        connectionsRef,
        setNodes,
        setConnections,
        enqueueGenerationBatch,
    });

    useEffect(() => {
        if (!projectLoaded) return;
        setNodes((current) => {
            let changed = false;
            const next = current.map((node) => {
                const promoted = promoteLegacyBatchTableSize(node);
                if (promoted !== node) changed = true;
                return promoted;
            });
            return changed ? next : current;
        });
        nodesRef.current.filter((node) => node.type === CanvasNodeType.BatchTable).forEach((node) => {
            syncRowsFromConnections(node.id, true);
        });
    }, [connections, nodesRef, projectLoaded, setNodes, syncRowsFromConnections]);

    const {
        addScriptRow,
        createAndGenerateScriptVideos,
        createScriptActionBoards,
        createScriptImageNodes,
        createScriptVideoNodes,
        generateScriptImages,
        generateScriptRows,
        generateScriptVideos,
        removeScriptRow,
        replaceScriptRows,
        updateScriptRow,
        updateScriptRows,
    } = useCanvasStoryboard({
        pageUi,
        projectId,
        addedSkills,
        nodesRef,
        connectionsRef,
        setNodes,
        setConnections,
        enqueueGenerationBatch,
        startGenerationRequest,
        finishGenerationRequest,
    });

    const handleRetryNode = useCanvasGenerationRetry({
        pageUi,
        readOnly,
        onEditGenerationInput,
        projectId,
        domainProjectId,
        addedSkills,
        assets,
        nodesRef,
        connectionsRef,
        setNodes,
        setRunningNodeId,
        startGenerationRequest,
        finishGenerationRequest,
        bindGenerationTask,
        applyGenerationTaskResult,
        regenerateImageBatch: async (nodeId, prompt, options) => {
            await handleGenerateNode(nodeId, "image", prompt, options);
        },
    });

    const cancelCanvasTask = useCallback(
        (task: GenerationTask) => {
            const deliveryOnly = task.status === "succeeded";
            const owner = lifetime.capture(projectId);
            const isCurrent = () => lifetime.matches(owner, projectIdRef.current);
            modal.confirm({
                ...canvasTaskConfirmation,
                title: deliveryOnly ? "停止取回结果？" : "取消生成任务？",
                content: deliveryOnly ? "已生成的结果会保留，之后可以继续取回。" : localOnly ? "任务会立即停止本地执行。" : "任务会立即停止本地执行；如果已经提交到上游，系统会继续核对取消结果和积分状态。",
                okText: deliveryOnly ? "停止取回" : "取消任务",
                cancelText: "继续等待",
                onOk: async () => {
                    if (!isCurrent()) return;
                    try {
                        const next = await cancelGenerationTask(task.id);
                        if (!isCurrent()) return;
                        const node = nodesRef.current.find((item) => item.metadata?.taskId === task.id);
                        if (node) bindGenerationTask(node.id, next);
                        setTaskDetail((current) => (current?.id === task.id ? next : current));
                        await queryClient.invalidateQueries({ queryKey: ["canvas-active-tasks", projectId] });
                        if (!isCurrent()) return;
                        message.success(deliveryOnly ? "已停止取回" : "任务已取消");
                    } catch (error) {
                        if (!isCurrent()) return;
                        message.error(error instanceof Error ? error.message : "取消任务失败");
                    }
                },
            });
        },
        [bindGenerationTask, lifetime, localOnly, message, modal, nodesRef, projectId, queryClient, setTaskDetail],
    );

    const insertGenerationHistoryTask = useCallback(
        async (task: GenerationTask) => {
            if (!insertingHistory.current.tryEnter()) return;
            const owner = lifetime.capture(projectId);
            try {
                await hydrateBackendGeneratedOutputs(task);
                await runOwnedCanvasHistoryInsert({
                    owner,
                    getLiveCanvasId: () => projectIdRef.current,
                    getLiveLifetime: () => lifetime.current(),
                    task,
                    projectId: owner.canvasId,
                    domainProjectId,
                    center: getCanvasCenter(),
                    nodes: nodesRef.current,
                    assets: useAssetStore.getState().assets,
                    readLiveNodes: () => readOwnedCanvasNodes({
                        owner,
                        liveCanvasId: projectIdRef.current,
                        liveLifetime: lifetime.current(),
                        pageNodes: nodesRef.current,
                        storedNodes: useCanvasStore.getState().openProject(owner.canvasId)?.nodes,
                    }),
                    persist: (persisted) => persistCanvasDocument(owner.canvasId, { nodes: persisted }),
                    ensureAsset: (item) => ensureCanvasNodeAsset({ canvasId: owner.canvasId, domainProjectId, node: item, source: "canvas-generation", taskId: task.id }),
                    onCommit: (node, insertedNodes) => {
                        setNodes((current) => insertedNodes.reduce((nodes, inserted) => rebaseInsertedCanvasNode(nodes, inserted), current));
                        pageUi.getState().setSelectedNodeIds(new Set([node.id]));
                        setGenerationHistoryOpen(false);
                        message.success("已从生成历史插入到画布");
                    },
                });
            } catch (error) {
                message.error(error instanceof Error ? error.message : "生成结果无法插入画布");
            } finally {
                insertingHistory.current.exit();
            }
        },
        [pageUi, domainProjectId, getCanvasCenter, lifetime, message, nodesRef, projectId, setGenerationHistoryOpen, setNodes],
    );

    const reconcileImageBatchRootNode = useCallback(
        (rootId: string) => {
            setNodes((current) => reconcileImageBatchRootNodes(rootId, current));
        },
        [setNodes],
    );

    const retryImageBatchChildren = useCallback(
        (rootId: string, children: CanvasNodeData[]) => {
            const { retryable, blocked } = selectRetryableImageBatchChildren(children);
            if (blocked) message.warning("部分图片需要先处理失败原因，请打开对应节点查看");
            if (!retryable.length) return;
            const root = nodesRef.current.find((node) => node.id === rootId);
            if (root) {
                const config = buildGenerationConfig(effectiveConfig, root, "image");
                if (modelCapabilityConfigFor(config, config.model).image?.fixedOutputs) {
                    if ((root.metadata?.batchChildIds?.length || 0) > (modelCapabilityConfigFor(config, config.model).image?.fixedOutputs || 0)) {
                        const tasks = new Set<string>();
                        void (async () => {
                            for (const child of retryable) {
                                const taskId = child.metadata?.taskId || child.id;
                                if (tasks.has(taskId)) continue;
                                tasks.add(taskId);
                                await handleRetryNode(child);
                            }
                        })();
                    } else void handleRetryNode(root);
                    return;
                }
            }
            void runImageBatchChildRetry({
                rootId,
                children: retryable,
                retry: handleRetryNode,
                setNodes,
                reconcile: reconcileImageBatchRootNode,
            });
        },
        [effectiveConfig, handleRetryNode, message, nodesRef, reconcileImageBatchRootNode, setNodes],
    );

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const created = createImageNodeFromTextSource({
                sourceId: node.id,
                prompt: node.metadata?.content || node.metadata?.prompt || "",
                nodes: nodesRef.current,
                connections: connectionsRef.current,
                config: effectiveConfig,
                connectionId: nanoid(),
            });
            if (!created.ok) {
                if (created.reason === "empty-prompt") message.warning("文本节点为空，无法生图");
                return;
            }
            nodesRef.current = created.nextNodes;
            connectionsRef.current = created.nextConnections;
            setNodes(created.nextNodes);
            setConnections(created.nextConnections);
            pageUi.getState().setSelectedNodeIds(new Set([created.imageNode.id]));
            pageUi.getState().setSelectedConnectionId(null);
            pageUi.getState().setDialogNodeId(created.imageNode.id);
        },
        [pageUi, connectionsRef, effectiveConfig, message, nodesRef, projectId, setConnections, setNodes],
    );

    const generateImageLayers = useCallback((node: CanvasNodeData) => {
        if (readOnly) return;
        return runCanvasGenerationSubmissionOnce(layerSplitSubmissions.current, JSON.stringify([projectId, node.id]), async () => {
            if (projectIdRef.current !== projectId) return;
            const source = nodesRef.current.find((item) => item.id === node.id && item.type === CanvasNodeType.Image);
            if (!source || !(source.metadata?.content || source.metadata?.storageKey)) {
                message.warning("图片节点为空，无法拆分图层");
                return;
            }
            const split = createImageLayerSplit(source, effectiveConfig, nodesRef.current, (model) => useConfigStore.getState().isAiConfigReady(effectiveConfig, model));
            if (!split) {
                message.warning("请先在模型配置中连接支持图层拆分的 Seedream 模型");
                return;
            }
            const nextNodes = [...nodesRef.current, split.node];
            const nextConnections = [...connectionsRef.current, split.connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            pageUi.getState().setSelectedNodeIds(new Set([split.node.id]));
            pageUi.getState().setSelectedConnectionId(null);
            pageUi.getState().setDialogNodeId(null);
            await handleGenerateNode(split.node.id, "image", split.prompt, {
                confirmedModelKey: split.model,
                confirmedInputs: { nodes: nextNodes, connections: nextConnections, config: effectiveConfig, assets, skills: [] },
            });
        });
    }, [assets, connectionsRef, effectiveConfig, handleGenerateNode, message, nodesRef, pageUi, projectId, readOnly, setConnections, setNodes]);

    const generateFinalVideoFromDraftNode = useCallback(
        (requestedNode: CanvasNodeData) => {
            if (readOnly) return;
            const owner = lifetime.capture(projectId);
            const isCurrent = () => lifetime.matches(owner, projectIdRef.current);
            return runCanvasGenerationSubmissionOnce(draftConversionSubmissions.current, `${projectId}:${requestedNode.id}`, async () => {
                if (!isCurrent()) return;
                const initialNode = nodesRef.current.find((item) => item.id === requestedNode.id);
                if (!initialNode || !canConvertCanvasVideoDraft(initialNode)) return;
                let source: Awaited<ReturnType<typeof resolveCanvasVideoDraftSource>>;
                try {
                    source = await resolveCanvasVideoDraftSource(initialNode, projectId);
                } catch (error) {
                    if (isCurrent()) message.error(error instanceof Error ? error.message : "读取原样片任务失败，请稍后再试");
                    return;
                }
                if (!isCurrent()) return;
                const node = nodesRef.current.find((item) => item.id === requestedNode.id);
                if (!node || !canConvertCanvasVideoDraft(node) || node.metadata?.taskId !== initialNode.metadata?.taskId) return;
                if (!source) {
                    message.warning("该样片缺少上游任务 ID，无法直接转高清成片");
                    return;
                }
                const currentProviderId = node.metadata?.taskProviderRequestId?.trim();
                if (currentProviderId && currentProviderId !== source.providerRequestId) return;
                if (!source.model) {
                    message.warning("原样片的模型信息缺失，无法直接转高清成片");
                    return;
                }
                const promptText = node.metadata?.prompt || "";
                const childNode: CanvasNodeData = {
                    id: nanoid(),
                    type: CanvasNodeType.Video,
                    title: `${node.title || "样片"} (1080P 成片)`.slice(0, 36),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: {
                        status: "idle",
                        prompt: promptText,
                        composerContent: promptText,
                        model: source.model,
                        size: node.metadata?.size,
                        seconds: node.metadata?.seconds,
                        vquality: "1080p",
                        generateAudio: node.metadata?.generateAudio ?? "true",
                        watermark: node.metadata?.watermark ?? "false",
                        draft: "false",
                        videoEditOperation: "draft_to_final",
                        videoDraftTaskId: source.providerRequestId,
                        generatedFromNodeId: node.id,
                        generationResultPlacement: "replace-node",
                    },
                };
                const nextNodes = [...nodesRef.current, childNode];
                const nextConnections = [...connectionsRef.current, { id: nanoid(), fromNodeId: node.id, toNodeId: childNode.id }];
                nodesRef.current = nextNodes;
                connectionsRef.current = nextConnections;
                setNodes(nextNodes);
                setConnections(nextConnections);
                pageUi.getState().setSelectedNodeIds(new Set([childNode.id]));
                pageUi.getState().setSelectedConnectionId(null);
                pageUi.getState().setDialogNodeId(null);
                await handleGenerateNode(childNode.id, "video", promptText, {
                    confirmedModelKey: source.model,
                    confirmedInputs: {
                        nodes: nextNodes,
                        connections: nextConnections,
                        config: effectiveConfig,
                        assets,
                        skills: [],
                    },
                    skipDuplicateConfirmation: true,
                });
            });
        },
        [assets, connectionsRef, effectiveConfig, handleGenerateNode, lifetime, message, nodesRef, pageUi, projectId, readOnly, setConnections, setNodes],
    );

    const canRetakeVideo = useCallback((node: CanvasNodeData) => Boolean(canvasVideoRetakeModel(node, effectiveConfig)), [effectiveConfig]);

    const generateVideoRetake = useCallback(
        (requestedNode: CanvasNodeData, range: InlineVideoTrimRange, durationMs: number, instruction: string) => {
            if (readOnly) return false;
            const node = nodesRef.current.find((item) => item.id === requestedNode.id);
            if (!node || node.metadata?.storageKey !== requestedNode.metadata?.storageKey ||
                node.metadata?.content !== requestedNode.metadata?.content) {
                message.warning("原视频已变化，请重新选择片段");
                return false;
            }
            const retake = buildCanvasVideoRetake(node, effectiveConfig, range, durationMs, instruction);
            if (!retake) {
                message.warning("请确认原视频支持重拍，并填写有效片段和修改要求");
                return false;
            }
            const key = `${projectId}:${node.id}`;
            if (retakeSubmissions.current.has(key)) {
                message.info("正在提交这段视频的重拍任务");
                return false;
            }
            const owner = lifetime.capture(projectId);
            void runCanvasGenerationSubmissionOnce(retakeSubmissions.current, key, async () => {
                if (!lifetime.matches(owner, projectIdRef.current) || !nodesRef.current.includes(node)) return;
                const childNode: CanvasNodeData = {
                    id: nanoid(),
                    type: CanvasNodeType.Video,
                    title: retake.title,
                    position: findAvailableGenerationGroupPosition(nodesRef.current, {
                        x: node.position.x + node.width + 96,
                        y: node.position.y,
                    }, node),
                    width: node.width,
                    height: node.height,
                    metadata: retake.metadata,
                };
                const nextNodes = [...nodesRef.current, childNode];
                const nextConnections = [...connectionsRef.current, { id: nanoid(), fromNodeId: node.id, toNodeId: childNode.id }];
                nodesRef.current = nextNodes;
                connectionsRef.current = nextConnections;
                setNodes(nextNodes);
                setConnections(nextConnections);
                pageUi.getState().setSelectedNodeIds(new Set([childNode.id]));
                pageUi.getState().setSelectedConnectionId(null);
                pageUi.getState().setDialogNodeId(null);
                await handleGenerateNode(childNode.id, "video", retake.prompt, {
                    confirmedModelKey: retake.model,
                    confirmedInputs: { nodes: nextNodes, connections: nextConnections, config: effectiveConfig, assets, skills: [] },
                });
            });
            return true;
        },
        [assets, connectionsRef, effectiveConfig, handleGenerateNode, lifetime, message, nodesRef, pageUi, projectId, readOnly, setConnections, setNodes],
    );

    const createVideoEditNodeFromVideo = useCallback(
        (node: CanvasNodeData, operation: "extend" | "inpaint") => {
            if (!node.metadata?.content && !node.metadata?.storageKey) {
                message.warning("视频节点为空，无法发起视频二创");
                return;
            }
            const label = operation === "extend" ? "视频续写" : "视频局部修改";
            const defaultPrompt = operation === "extend"
                ? `基于 @视频1 自然顺延后续动作、镜头运动与环境氛围，保持人物与画风一致`
                : `基于 @视频1 进行画面修改：保持原有构图与节奏，将主体调整为 `;
            const editDraft = resolveVideoEditNodeDraft(effectiveConfig, node, operation);
            const childNode: CanvasNodeData = {
                id: nanoid(),
                type: CanvasNodeType.Video,
                title: `${node.title || "视频"} · ${label}`.slice(0, 36),
                position: { x: node.position.x + node.width + 96, y: node.position.y },
                width: node.width,
                height: node.height,
                metadata: {
                    status: "idle",
                    prompt: defaultPrompt,
                    composerContent: defaultPrompt,
                    model: editDraft.model,
                    size: editDraft.size,
                    seconds: editDraft.seconds,
                    vquality: editDraft.vquality,
                    generateAudio: node.metadata?.generateAudio ?? "true",
                    watermark: node.metadata?.watermark ?? "false",
                    draft: "false",
                    videoEditOperation: operation,
                    generatedFromNodeId: node.id,
                },
            };
            const nextNodes = [...nodesRef.current, childNode];
            const nextConnections = [...connectionsRef.current, { id: nanoid(), fromNodeId: node.id, toNodeId: childNode.id }];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            pageUi.getState().setHoveredNodeId(null);
            pageUi.getState().setToolbarNodeId(null);
            pageUi.getState().setSelectedNodeIds(new Set([childNode.id]));
            pageUi.getState().setSelectedConnectionId(null);
            pageUi.getState().setDialogNodeId(childNode.id);
        },
        [connectionsRef, effectiveConfig, message, nodesRef, pageUi, setConnections, setNodes],
    );

    return {
        applyGenerationTaskResult,
        bindGenerationTask,
        cancelNodeGeneration,
        finishGenerationRequest,
        openNodeTaskDetails,
        retrieveTaskResult,
        retrievingTaskId,
        runningNodeId,
        setRunningNodeId,
        setTaskDetail,
        startGenerationRequest,
        taskDetail,
        taskDetailLoading,
        taskDetailError,
        taskDetailLogs,
        handleGenerateNode,
        handleRetryNode,
        cancelCanvasTask,
        insertGenerationHistoryTask,
        enqueueGenerationBatch,
        retryFailedBatchItems,
        stopRemainingBatchItems,
        addBatchReferenceColumn,
        addBatchRow,
        fillRowsFromConnections,
        generateBatchRows,
        moveBatchReferenceCell,
        patchBatchTable,
        removeBatchReferenceColumn,
        removeBatchRow,
        reorderBatchReferenceColumns,
        syncRowsFromConnections,
        updateBatchRow,
        addScriptRow,
        createAndGenerateScriptVideos,
        createScriptActionBoards,
        createScriptImageNodes,
        createScriptVideoNodes,
        generateScriptImages,
        generateScriptRows,
        generateScriptVideos,
        removeScriptRow,
        replaceScriptRows,
        updateScriptRow,
        updateScriptRows,
        reconcileImageBatchRootNode,
        retryImageBatchChildren,
        generateImageFromTextNode,
        generateImageLayers,
        generateFinalVideoFromDraftNode,
        createVideoEditNodeFromVideo,
        canRetakeVideo,
        generateVideoRetake,
    };
}
