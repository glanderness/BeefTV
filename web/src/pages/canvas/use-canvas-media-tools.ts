import { isAIUpscaleTask, isDefinitePreAdmissionClientReject, isVideoSubtitleEraseTask, unknownSubmissionMetadata, upscaleObservationFailureMetadata, UPSCALE_OBSERVATION_TIMEOUT_MS } from "@/lib/canvas/canvas-ai-upscale-task";
import { recoverUpscaleTask } from "@/services/api/media-upscale";
import { createVideoSubtitleEraseTask, recoverVideoSubtitleEraseTask } from "@/services/api/video-subtitle-erase";
import { bindBackendCanvasGenerationResult } from "@/services/canvas-generation-consumer";
import { findGenerationTaskByOperation, queryGenerationTask, waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { getImageBlob, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { ownedResourceIdFromMediaRef, uploadResourceFile } from "@/services/api/resources";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { nanoid } from "nanoid";

import type { PanoramaGenerateConfig } from "@/components/canvas/canvas-panorama-config-modal";
import type { VideoSubtitleEraseSubmitOptions } from "@/components/canvas/video-subtitle-erase-dialog";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { imageMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { fitNodeSize, VIDEO_NODE_MAX_SIZE } from "@/lib/canvas/canvas-node-size";
import { mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { persistOwnedCanvasMediaNodes } from "@/lib/canvas/canvas-media-persist";
import { generationErrorMessage } from "@/lib/generation-error";
import { getMediaBlob, resolveMediaUrl } from "@/services/file-storage";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { syncLocalCanvasSnapshot } from "@/services/local-workspace-sync";
import { openLocalCanvasProjectFromBackend } from "@/services/local-workspace-repository";
import { http } from "@/services/api/request";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { isLocalExecutorSessionStop } from "@/lib/plugins/builtin/editor/local-executor-session";
import { useCanvasOwnerLifetime } from "./canvas-owner-epoch";
import { createCanvasMediaOperation } from "./canvas-media-operation";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { StartCanvasUploadStatus } from "./use-canvas-upload";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";
import { useCanvasVideoTools, type UseCanvasVideoToolsOptions } from "./use-canvas-video-tools";
import { useCanvasImageTools, type UseCanvasImageToolsOptions } from "./use-canvas-image-tools";

export { useCanvasVideoTools, type UseCanvasVideoToolsOptions };
export { useCanvasImageTools, type UseCanvasImageToolsOptions };

export type UseCanvasMediaToolsOptions = {
    pageUi: CanvasPageUiStoreHook;
    projectId: string;
    domainProjectId?: string;
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    selectedNodeIdsRef: { current: Set<string> };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setRunningNodeId: Dispatch<SetStateAction<string | null>>;
    startUploadStatus: StartCanvasUploadStatus;
    startGenerationRequest: (targetNodeId: string, originNodeId: string, runningId?: string, controller?: AbortController) => AbortController;
    finishGenerationRequest: (targetNodeId: string, controller: AbortController) => void;
    bindGenerationTask: (targetNodeId: string, task: GenerationTask) => void;
};

export function useCanvasMediaTools({
    pageUi,
    projectId,
    domainProjectId,
    nodesRef,
    connectionsRef,
    selectedNodeIdsRef,
    setNodes,
    setConnections,
    setRunningNodeId,
    startUploadStatus,
    startGenerationRequest,
    finishGenerationRequest,
    bindGenerationTask,
}: UseCanvasMediaToolsOptions) {
    const { message, modal } = App.useApp();
    const [panoramaConfigNodeId, setPanoramaConfigNodeId] = useState<string | null>(null);
    const [subtitleEraseNodeId, setSubtitleEraseNodeId] = useState<string | null>(null);
    const projectIdRef = useRef(projectId);
    const depthObserversRef = useRef(new Set<AbortController>());
    projectIdRef.current = projectId;
    const { lifetime, mountedRef } = useCanvasOwnerLifetime(projectId);
    const beginMediaOperation = useCallback(() => createCanvasMediaOperation(lifetime, projectId, () => projectIdRef.current, () => mountedRef.current), [lifetime, mountedRef, projectId]);

    useEffect(() => {
        setPanoramaConfigNodeId(null);
        setSubtitleEraseNodeId(null);
    }, [projectId]);

    useEffect(() => () => {
        for (const observer of depthObserversRef.current) observer.abort();
        depthObserversRef.current.clear();
    }, [projectId]);

    const persistMediaNodes = useCallback(async (
        mediaNodes: CanvasNodeData[],
        mediaConnections: CanvasConnection[] = [],
        options?: { signal?: AbortSignal },
    ) => {
        try {
            return await persistOwnedCanvasMediaNodes({
                canvasId: projectId,
                domainProjectId,
                mediaNodes,
                mediaConnections,
                signal: options?.signal,
            }, {
                ensureCanvasNodeAsset,
                getStoredProject: (canvasId) => {
                    const project = useCanvasStore.getState().projects.find((item) => item.id === canvasId);
                    return project ? { nodes: project.nodes, connections: project.connections } : undefined;
                },
                hasProject: (canvasId) => useCanvasStore.getState().projects.some((item) => item.id === canvasId),
                openProject: (id) => openLocalCanvasProjectFromBackend(id),
                updateProject: (canvasId, patch) => useCanvasStore.getState().updateProject(canvasId, patch),
                flushPersistence: async () => {
                    await flushCanvasStorePersistence();
                },
                syncSnapshot: (id, patch) => syncLocalCanvasSnapshot(id, patch),
                readSavedProject: async (canvasId) => {
                    const { project } = await http.get<{ project: { nodes: CanvasNodeData[] } }>(
                        `/canvas-projects/${encodeURIComponent(canvasId)}`,
                        { signal: options?.signal },
                    );
                    return project;
                },
                setNodes,
                getLiveProjectId: () => projectIdRef.current,
                getLiveNodes: () => nodesRef.current,
                getLiveConnections: () => connectionsRef.current,
                isLocalWorkspace: isLocalWorkspaceMode,
                warn: (text) => { message.warning(text); },
                error: (text) => { message.error(text); },
            });
        } catch (error) {
            if (isLocalExecutorSessionStop(error)) return new Map<string, string>();
            throw error;
        }
    }, [connectionsRef, domainProjectId, message, nodesRef, projectId, setNodes]);

    const prepareUpscaleResource = useCallback(async (node: CanvasNodeData) => {
        const existing = ownedResourceIdFromMediaRef(node.metadata?.storageKey, node.metadata?.content);
        if (existing) return existing;
        const key = node.metadata?.storageKey || "";
        const video = node.type === CanvasNodeType.Video;
        let blob = key ? await (video ? getMediaBlob(key) : getImageBlob(key)) : null;
        if (!blob) {
            const url = video ? await resolveMediaUrl(key, node.metadata?.content) : await resolveImageUrl(key, node.metadata?.content);
            if (!url) throw new Error("无法读取原素材");
            const response = await fetch(url);
            if (!response.ok) throw new Error("读取原素材失败");
            blob = await response.blob();
        }
        const resource = await uploadResourceFile(blob, video ? "video" : "image", { width: node.metadata?.naturalWidth, height: node.metadata?.naturalHeight });
        return resource.id;
    }, []);

    const observeAIUpscale = useCallback((task: GenerationTask, targetNodeId: string) => {
        const observer = new AbortController();
        depthObserversRef.current.add(observer);
        let observedTask = task;
        void waitForGenerationTask(task.id, { initialTask: task, signal: observer.signal, timeoutMs: UPSCALE_OBSERVATION_TIMEOUT_MS, onTaskUpdate: update => { observedTask = update; if (projectIdRef.current === projectId) bindGenerationTask(targetNodeId, update); } }).then(async completed => {
            if (projectIdRef.current !== projectId) return;
            const currentNode = nodesRef.current.find(item => item.id === targetNodeId);
            if (!currentNode) return;
            // Backend delivery may have already bound the output. Adopt its idempotent
            // receipt instead of racing it with a full canvas snapshot write.
            await bindBackendCanvasGenerationResult({
                canvasId: projectId,
                nodeId: targetNodeId,
                task: completed,
                outputIndex: currentNode.metadata?.taskOutputIndex ?? 0,
                signal: observer.signal,
                isCurrent: () => !observer.signal.aborted && projectIdRef.current === projectId,
                nodesRef,
                setNodes,
            });
        }).catch(cause => {
            if (observer.signal.aborted || projectIdRef.current !== projectId) return;
            setNodes(current => current.map(item => item.id === targetNodeId ? { ...item, metadata: { ...item.metadata, ...upscaleObservationFailureMetadata(observedTask, generationErrorMessage(cause)) } } : item));
        }).finally(() => depthObserversRef.current.delete(observer));
    }, [bindGenerationTask, nodesRef, projectId, setNodes]);

    const recoverAIUpscale = useCallback(async (node: CanvasNodeData) => {
        let original = node.metadata?.taskId
            ? await queryGenerationTask(node.metadata.taskId, {})
            : undefined;
        if (!original && node.metadata?.taskClientOperationId) {
            original = await findGenerationTaskByOperation(node.metadata.taskClientOperationId, projectId);
        }
        if (!original) throw new Error("找不到原超分任务");
        if (!isAIUpscaleTask(original)) throw new Error("该任务不是超分任务");
        const task = original.status === "failed" ? await recoverUpscaleTask(original.id) : original;
        if (projectIdRef.current !== projectId) return;
        bindGenerationTask(node.id, task);
        setNodes(current => current.map(item => item.id === node.id ? { ...item, metadata: { ...item.metadata, taskId: task.id, generationSubmissionState: "accepted", status: "loading", errorDetails: undefined, processingLabel: "取回原超分任务结果" } } : item));
        observeAIUpscale(task, node.id);
    }, [bindGenerationTask, observeAIUpscale, projectId, setNodes]);

    const openVideoSubtitleErase = useCallback((node: CanvasNodeData) => {
        setSubtitleEraseNodeId(node.id);
    }, []);

    const submitVideoSubtitleErase = useCallback(async (node: CanvasNodeData, options: VideoSubtitleEraseSubmitOptions) => {
        if (!mountedRef.current || projectIdRef.current !== projectId) return;
        const childId = nanoid();
        const clientOperationId = nanoid();
        const size = fitNodeSize(
            node.metadata?.naturalWidth || node.width,
            node.metadata?.naturalHeight || node.height,
            VIDEO_NODE_MAX_SIZE.width,
            VIDEO_NODE_MAX_SIZE.height,
        );
        const outputCount = connectionsRef.current.filter(connection => connection.fromNodeId === node.id).length;
        const pendingChild: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Video,
            title: `${node.title || "视频"} · 去字幕`,
            position: { x: node.position.x + node.width + 96, y: node.position.y + (outputCount % 4) * (size.height + 32) },
            width: size.width,
            height: size.height,
            metadata: mediaResultMetadata("derived", {
                status: "loading",
                taskType: "canvas_video",
                generationSubmissionState: "submitting",
                processingLabel: "正在消除视频字幕",
                prompt: `从「${node.title || "视频"}」消除画面字幕`,
                generatedFromNodeId: node.id,
                videoSubtitleEraseSourceNodeId: node.id,
                taskClientOperationId: clientOperationId,
            }),
        };
        const connection: CanvasConnection = { id: nanoid(), fromNodeId: node.id, toNodeId: childId };
        nodesRef.current = [...nodesRef.current, pendingChild];
        connectionsRef.current = [...connectionsRef.current, connection];
        setNodes(nodesRef.current);
        setConnections(connectionsRef.current);
        pageUi.getState().setSelectedNodeIds(new Set([childId]));
        pageUi.getState().setSelectedConnectionId(null);
        pageUi.getState().setDialogNodeId(null);
        useCanvasStore.getState().updateProject(projectId, { nodes: nodesRef.current, connections: connectionsRef.current });
        await flushCanvasStorePersistence();
        await syncLocalCanvasSnapshot(projectId, { nodes: nodesRef.current, connections: connectionsRef.current });
        if (!mountedRef.current || projectIdRef.current !== projectId || !nodesRef.current.some(item => item.id === childId)) return;

        try {
            const task = await createVideoSubtitleEraseTask({
                resourceId: options.resourceId,
                channelId: "beeftv",
                eraseMethod: options.eraseMethod,
                subtitleModel: options.subtitleModel,
                ...(options.region ? { region: options.region } : {}),
                clientOperationId,
                projectId,
                nodeId: childId,
            });
            if (!mountedRef.current || projectIdRef.current !== projectId) return;
            nodesRef.current = nodesRef.current.map(item => item.id === childId ? {
                ...item,
                metadata: {
                    ...item.metadata,
                    taskId: task.id,
                    taskStatus: task.status,
                    taskOutcome: task.outcome,
                    generationSubmissionState: "accepted",
                },
            } : item);
            setNodes(nodesRef.current);
            useCanvasStore.getState().updateProject(projectId, { nodes: nodesRef.current, connections: connectionsRef.current });
            bindGenerationTask(childId, task);
            observeAIUpscale(task, childId);
            await flushCanvasStorePersistence();
        } catch (error) {
            if (!mountedRef.current || projectIdRef.current !== projectId) return;
            if (isDefinitePreAdmissionClientReject(error)) {
                nodesRef.current = nodesRef.current.filter(item => item.id !== childId);
                connectionsRef.current = connectionsRef.current.filter(item => item.id !== connection.id);
                setNodes(nodesRef.current);
                setConnections(connectionsRef.current);
                pageUi.getState().setSelectedNodeIds(new Set([node.id]));
                useCanvasStore.getState().updateProject(projectId, { nodes: nodesRef.current, connections: connectionsRef.current });
                await flushCanvasStorePersistence();
                await syncLocalCanvasSnapshot(projectId, { nodes: nodesRef.current, connections: connectionsRef.current }).catch(() => undefined);
                throw error;
            }
            const existing = await findGenerationTaskByOperation(clientOperationId, projectId).catch(() => undefined);
            if (!mountedRef.current || projectIdRef.current !== projectId) return;
            if (existing) {
                nodesRef.current = nodesRef.current.map(item => item.id === childId ? {
                    ...item,
                    metadata: {
                        ...item.metadata,
                        taskId: existing.id,
                        taskStatus: existing.status,
                        taskOutcome: existing.outcome,
                        generationSubmissionState: "accepted",
                    },
                } : item);
                setNodes(nodesRef.current);
                useCanvasStore.getState().updateProject(projectId, { nodes: nodesRef.current, connections: connectionsRef.current });
                bindGenerationTask(childId, existing);
                observeAIUpscale(existing, childId);
                await flushCanvasStorePersistence();
                return;
            }
            nodesRef.current = nodesRef.current.map(item => item.id === childId ? {
                ...item,
                metadata: {
                    ...item.metadata,
                    ...unknownSubmissionMetadata(generationErrorMessage(error)),
                },
            } : item);
            setNodes(nodesRef.current);
            useCanvasStore.getState().updateProject(projectId, { nodes: nodesRef.current, connections: connectionsRef.current });
            await flushCanvasStorePersistence();
            await syncLocalCanvasSnapshot(projectId, { nodes: nodesRef.current, connections: connectionsRef.current }).catch(() => undefined);
            message.warning("提交状态待确认，已在画布保留结果节点以便查询原任务");
        }
    }, [bindGenerationTask, connectionsRef, message, mountedRef, nodesRef, observeAIUpscale, pageUi, projectId, setConnections, setNodes]);

    const recoverVideoSubtitleErase = useCallback(async (node: CanvasNodeData) => {
        let original = node.metadata?.taskId
            ? await queryGenerationTask(node.metadata.taskId, {})
            : undefined;
        if (!original && node.metadata?.taskClientOperationId) {
            original = await findGenerationTaskByOperation(node.metadata.taskClientOperationId, projectId);
        }
        if (!original) throw new Error("未查询到已提交的去字幕任务；确认未扣费后可删除此节点重新发起");
        if (!isVideoSubtitleEraseTask(original)) throw new Error("该任务不是视频去字幕任务");
        const task = original.status === "failed" ? await recoverVideoSubtitleEraseTask(original.id) : original;
        if (projectIdRef.current !== projectId) return;
        bindGenerationTask(node.id, task);
        setNodes(current => current.map(item => item.id === node.id ? { ...item, metadata: { ...item.metadata, taskId: task.id, generationSubmissionState: "accepted", status: "loading", errorDetails: undefined, processingLabel: "取回原去字幕视频结果" } } : item));
        observeAIUpscale(task, node.id);
    }, [bindGenerationTask, observeAIUpscale, projectId, setNodes]);

    const openPanoramaConfig = useCallback((node: CanvasNodeData) => {
        setPanoramaConfigNodeId(node.id);
    }, []);

    const createPanoramaViewerWithConfig = useCallback((node: CanvasNodeData, composedPrompt: string, config: PanoramaGenerateConfig) => {
        const panoramaSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Panorama];
        const childId = nanoid();
        const childNode: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Panorama,
            title: `${node.title || "图片"} · 全景`,
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: panoramaSpec.width,
            height: panoramaSpec.height,
            metadata: {
                prompt: composedPrompt || node.metadata?.prompt,
                panoramaConfig: {
                    projection: config.projection,
                    sourceMode: config.sourceMode,
                    smartBase: config.smartBase,
                    directImageUrl: config.directImageUrl ?? null,
                },
            },
        };
        setNodes((current) => [...current, childNode]);
        setConnections((current) => {
            const linkTargets = new Set<string>([node.id]);
            config.referenceImages.forEach((reference) => linkTargets.add(reference.id));
            const extraConnections = config.referenceImages
                .filter((reference) => reference.id !== node.id)
                .map((reference) => ({ id: nanoid(), fromNodeId: reference.id, toNodeId: childId }));
            return [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }, ...extraConnections];
        });
        pageUi.getState().setSelectedNodeIds(new Set([childId]));
        pageUi.getState().setSelectedConnectionId(null);
        // 全景节点是纯查看器，创建后不弹提示词面板。
        pageUi.getState().setDialogNodeId(null);
        setPanoramaConfigNodeId(null);
        message.success(config.sourceMode === "image" ? "已创建全景查看节点" : "已创建全景生成节点");
    }, [pageUi, projectId, message, setConnections, setNodes]);

    const addPanoramaCaptureNode = useCallback(async (node: CanvasNodeData, dataUrl: string, title: string) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        try {
            const image = await operation.wait(uploadImage(dataUrl));
            const size = fitNodeSize(image.width || 720, image.height || 405);
            // 已有导出时按列错开，避免多张截图叠在同一位置。
            const outputCount = connectionsRef.current.filter((connection) => connection.fromNodeId === node.id).length;
            const childNode: CanvasNodeData = {
                id: nanoid(),
                type: CanvasNodeType.Image,
                title,
                position: { x: node.position.x + node.width + 96, y: node.position.y + (outputCount % 5) * (size.height + 32) },
                width: size.width,
                height: size.height,
                metadata: mediaResultMetadata("derived", { ...imageMetadata(image), prompt: node.metadata?.prompt, generatedFromNodeId: node.id }),
            };
            setNodes((current) => [...current, childNode]);
            setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: childNode.id }]);
            await operation.wait(persistMediaNodes([childNode], [], {}));
            message.success(`已导出「${title}」`);
        } catch (error) {
            if (operation.isCurrent()) throw error;
        }
    }, [beginMediaOperation, connectionsRef, message, persistMediaNodes, setConnections, setNodes]);

    const { clearDeletedVideoNodes, ...videoTools } = useCanvasVideoTools({
        pageUi,
        projectId,
        projectIdRef,
        depthObserversRef,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        setNodes,
        setConnections,
        startUploadStatus,
        beginMediaOperation,
        persistMediaNodes,
        message,
        modal,
    });

    const { clearDeletedImageNodes, ...imageTools } = useCanvasImageTools({
        pageUi,
        projectId,
        nodesRef,
        setNodes,
        setConnections,
        setRunningNodeId,
        startGenerationRequest,
        finishGenerationRequest,
        bindGenerationTask,
        beginMediaOperation,
        persistMediaNodes,
        message,
    });

    // 删除节点后，这些工具若还指向被删节点就一起关闭；状态归本 hook 所有，页面只调一次。
    const clearDeletedNodes = useCallback((removedIds: Set<string>) => {
        const clear = (current: string | null) => (current && removedIds.has(current) ? null : current);
        clearDeletedImageNodes(removedIds);
        clearDeletedVideoNodes(removedIds);
        setPanoramaConfigNodeId(clear);
        setSubtitleEraseNodeId(clear);
    }, [clearDeletedImageNodes, clearDeletedVideoNodes]);

    return {
        clearDeletedNodes,
        prepareUpscaleResource,
        recoverAIUpscale,
        observeAIUpscale,
        openVideoSubtitleErase,
        submitVideoSubtitleErase,
        recoverVideoSubtitleErase,
        subtitleEraseNodeId,
        setSubtitleEraseNodeId,
        openPanoramaConfig,
        createPanoramaViewerWithConfig,
        addPanoramaCaptureNode,
        panoramaConfigNodeId,
        setPanoramaConfigNodeId,
        ...imageTools,
        ...videoTools,
    };
}
