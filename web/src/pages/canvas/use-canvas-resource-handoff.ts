import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { App } from "antd";
import type { SetURLSearchParams } from "react-router";

import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { resolveProjectCanvasStyle } from "@/components/canvas/canvas-style-picker-modal";
import { refreshCanvasCharacterReferenceNodes } from "@/lib/canvas/canvas-character-reference";
import { canvasAssetHandoffIds } from "@/lib/canvas/canvas-asset-handoff";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { createStyleProfileSnapshot, resolveStyleProfile, serializeStyleProfile } from "@/lib/canvas/style-profile";
import { getProject } from "@/services/api/projects";
import { queryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { loadAssetsForUse } from "@/services/local-workspace-sync";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { persistCanvasDocument } from "@/services/local-workspace-repository";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

import { captureCanvasOwnerEpoch, canvasOwnerEpochMatches, readOwnedCanvasNodes, runOwnedCanvasPageCommit } from "./canvas-owner-epoch";
import { applyArchivedCanvasNodeAssets, commitOwnedCanvasAssetHandoff, rebaseCreatedCanvasNodes } from "./canvas-resource-handoff-commit";
import { linkedFolderPresentation, resolveCanvasAssetHandoffPlan } from "./canvas-resource-handoff-plan";

const NODE_STATUS_SUCCESS = "success" as const;

type UseCanvasResourceHandoffOptions = {
    projectId: string;
    linkedProjectId: string;
    projectLoaded: boolean;
    assets: Asset[];
    assetsHydrated: boolean;
    nodesRef: { current: CanvasNodeData[] };
    searchParams: URLSearchParams;
    setSearchParams: SetURLSearchParams;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    getCanvasCenter: () => Position;
    handleProjectAssetsInsert: (payloads: InsertAssetPayload[]) => Promise<CanvasNodeData[]>;
    applyGenerationTaskResult: (nodeId: string, task: GenerationTask) => Promise<void>;
};

export function useCanvasResourceHandoff({
    projectId,
    linkedProjectId,
    projectLoaded,
    assets,
    assetsHydrated,
    nodesRef,
    searchParams,
    setSearchParams,
    setNodes,
    getCanvasCenter,
    handleProjectAssetsInsert,
    applyGenerationTaskResult,
}: UseCanvasResourceHandoffOptions) {
    const { message } = App.useApp();
    const assetHandoffRef = useRef("");
    const projectIdRef = useRef(projectId);
    projectIdRef.current = projectId;
    const mountedRef = useRef(true);
    useEffect(() => () => {
        mountedRef.current = false;
    }, []);
    const linkedProjectQuery = useQuery({ queryKey: ["project", linkedProjectId], queryFn: () => getProject(linkedProjectId), enabled: Boolean(linkedProjectId) });
    const refetchLinkedProject = linkedProjectQuery.refetch;

    const archiveNodesToLinkedFolder = useCallback(
        (folder: CanvasNodeData, droppedNodes: CanvasNodeData[]) => {
            const folderId = folder.metadata?.folder?.assetFolderId;
            const domainProjectId = folder.metadata?.folder?.projectId || linkedProjectId;
            if (!folderId || !domainProjectId || !droppedNodes.length) return;
            const owner = captureCanvasOwnerEpoch(projectId);
            const folderTitle = folder.title;
            void runOwnedCanvasPageCommit({
                owner,
                getLiveCanvasId: () => projectIdRef.current,
                work: () => Promise.all(droppedNodes.map((node) => ensureCanvasNodeAsset({ canvasId: owner.canvasId, domainProjectId, folderId, node, source: "canvas-manual" }))),
                onCommit: (results) => {
                    const archivedByNodeId = new Map(droppedNodes.map((node, index) => [node.id, { assetId: results[index].assetId, content: node.metadata?.content, previousAssetId: node.metadata?.assetId }]));
                    setNodes((current) => applyArchivedCanvasNodeAssets(current, archivedByNodeId));
                    void refetchLinkedProject();
                    message.success(`已归档到“${folderTitle}”`);
                },
            }).catch((error) => {
                if (!canvasOwnerEpochMatches(owner, projectIdRef.current)) return;
                message.error(error instanceof Error ? error.message : "素材归档失败");
            });
        },
        [linkedProjectId, message, projectId, refetchLinkedProject, setNodes],
    );

    useEffect(() => {
        if (!projectLoaded || !linkedProjectQuery.data) return;
        setNodes((current) => refreshCanvasCharacterReferenceNodes(current, linkedProjectQuery.data.assets));
    }, [linkedProjectQuery.data, projectLoaded, setNodes]);

    useEffect(() => {
        const project = linkedProjectQuery.data?.project;
        const preset = resolveProjectCanvasStyle(project?.stylePresetId, project?.styleProfileJson);
        if (!projectLoaded || !preset) return;
        const profile = resolveStyleProfile(project?.stylePresetId, project?.styleProfileJson, preset.profile || createStyleProfileSnapshot(preset));
        if (!profile) return;
        const current = nodesRef.current.find((node) => node.type === CanvasNodeType.Text && node.metadata?.workflowKind === "styleboard");
        const nextMetadata = {
            content: profile.prompt,
            prompt: profile.prompt,
            status: NODE_STATUS_SUCCESS,
            workflowKind: "styleboard" as const,
            workflowTitle: "项目画风",
            workflowDescription: profile.description,
            stylePresetId: profile.presetId,
            styleProfileJson: serializeStyleProfile(profile),
            fontSize: 14,
            locked: true,
        };
        if (current) {
            if (current.metadata?.stylePresetId === profile.presetId && current.metadata?.content === profile.prompt && current.metadata?.styleProfileJson === nextMetadata.styleProfileJson && current.metadata?.locked) return;
            setNodes((currentNodes) => currentNodes.map((node) => (node.id === current.id ? { ...node, title: `项目画风 · ${profile.title}`, metadata: { ...node.metadata, ...nextMetadata } } : node)));
            return;
        }
        const node = createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), nextMetadata);
        node.title = `项目画风 · ${profile.title}`;
        node.width = 420;
        node.height = 240;
        setNodes((currentNodes) => [...currentNodes, node]);
    }, [getCanvasCenter, linkedProjectQuery.data?.project, nodesRef, projectLoaded, setNodes]);

    useEffect(() => {
        const folders = linkedProjectQuery.data?.assetFolders;
        if (!folders?.length) return;
        const byId = new Map(folders.map((folder) => [folder.id, folder]));
        setNodes((current) => {
            let changed = false;
            const next = current.map((node) => {
                const folderId = node.metadata?.folder?.assetFolderId;
                const folder = folderId ? byId.get(folderId) : undefined;
                if (!folder) return node;
                const { style, theme } = linkedFolderPresentation(folder);
                if (node.title === folder.name && node.metadata?.folder?.style === style && node.metadata?.folder?.theme === theme) return node;
                changed = true;
                return { ...node, title: folder.name, metadata: { ...node.metadata, folder: { ...node.metadata!.folder!, style, theme, themeCover: undefined } } };
            });
            return changed ? next : current;
        });
    }, [linkedProjectQuery.data?.assetFolders, setNodes]);

    useEffect(() => {
        if (!projectLoaded || searchParams.get("mode") !== "handoff") return;
        void loadAssetsForUse(canvasAssetHandoffIds(searchParams)).catch((error) => message.error(error instanceof Error ? error.message : "转入素材读取失败"));
    }, [projectLoaded, searchParams, message]);

    useEffect(() => {
        const plan = resolveCanvasAssetHandoffPlan({
            projectLoaded,
            assetsHydrated,
            mode: searchParams.get("mode"),
            projectId,
            assets,
            searchParams,
            currentKey: assetHandoffRef.current,
            nodes: nodesRef.current,
        });
        if (plan.kind === "idle") return;
        assetHandoffRef.current = plan.key;
        if (plan.kind === "wait") return;
        const owner = captureCanvasOwnerEpoch(projectId);
        const persistHandoff = async (createdNodes: CanvasNodeData[]) => {
            await commitOwnedCanvasAssetHandoff({
                owner,
                getLiveCanvasId: () => projectIdRef.current,
                stillOwnsPage: () => mountedRef.current && canvasOwnerEpochMatches(owner, projectIdRef.current),
                searchParams,
                createdNodes,
                readLiveNodes: () => readOwnedCanvasNodes({
                    owner,
                    liveCanvasId: projectIdRef.current,
                    pageNodes: nodesRef.current,
                    storedNodes: useCanvasStore.getState().openProject(owner.canvasId)?.nodes,
                }),
                persist: async (nextNodes) => {
                    await persistCanvasDocument(owner.canvasId, { nodes: nextNodes });
                },
                applyCreated: (created) => {
                    setNodes((current) => rebaseCreatedCanvasNodes(current, created));
                },
                consumeUrl: (nextSearchParams) => {
                    setSearchParams(nextSearchParams, { replace: true });
                },
                resetAttempt: () => {
                    assetHandoffRef.current = "";
                },
            });
        };
        const insertion = plan.payloads.length ? handleProjectAssetsInsert(plan.payloads) : Promise.resolve([] as CanvasNodeData[]);
        void insertion.then(persistHandoff).catch(() => {
            assetHandoffRef.current = "";
        });
    }, [assets, assetsHydrated, handleProjectAssetsInsert, nodesRef, projectId, projectLoaded, searchParams, setNodes, setSearchParams]);

    const reloadCanvasNodeResource = useCallback(
        async (node: CanvasNodeData) => {
            const taskId = node.metadata?.taskId;
            if (!taskId || !node.metadata?.resourceReloadAvailable) return;
            if (isLocalWorkspaceMode() || import.meta.env.VITE_CANVAS_LOCAL_MODE !== "false") {
                message.info("本地工作区不会从云端重新加载任务资源，请直接在画布中重新生成");
                return;
            }
            const owner = captureCanvasOwnerEpoch(projectId);
            const targetNodeId = node.id;
            setNodes((current) => current.map((item) => (item.id === targetNodeId ? { ...item, metadata: { ...item.metadata, status: "loading", taskStage: "正在重新加载资源", errorDetails: undefined } } : item)));
            try {
                const task = await queryGenerationTask(taskId);
                if (!canvasOwnerEpochMatches(owner, projectIdRef.current)) return;
                if (task.status !== "succeeded") throw new Error("原生成任务尚未成功，无法重新加载资源");
                await applyGenerationTaskResult(targetNodeId, task);
            } catch (error) {
                if (!canvasOwnerEpochMatches(owner, projectIdRef.current)) return;
                setNodes((current) =>
                    current.map((item) => (item.id === targetNodeId ? { ...item, metadata: { ...item.metadata, status: "error", errorDetails: error instanceof Error ? error.message : "资源重新加载失败", resourceReloadAvailable: true } } : item)),
                );
            }
        },
        [applyGenerationTaskResult, message, projectId, setNodes],
    );

    return {
        linkedProjectQuery,
        refetchLinkedProject,
        archiveNodesToLinkedFolder,
        reloadCanvasNodeResource,
    };
}
