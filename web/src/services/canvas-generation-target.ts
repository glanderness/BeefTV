import { bindCanvasNodeResourceAsset, canvasNodeResourceId } from "@/lib/canvas/canvas-resource-id";
import { persistCanvasDocument } from "@/services/local-workspace-repository";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";
import { CanvasGenerationTargetSaveError } from "./canvas-generation-errors";

function propagateBatchRootAssetIds(nodes: CanvasNodeData[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    let changed = false;
    const next = nodes.map((node) => {
        if (!node.metadata?.isBatchRoot || !node.metadata.primaryImageId) return node;
        const primary = byId.get(node.metadata.primaryImageId);
        if (!primary) return node;
        const rootResourceId = canvasNodeResourceId(node);
        const primaryResourceId = canvasNodeResourceId(primary);
        if (!rootResourceId || !primaryResourceId || rootResourceId !== primaryResourceId) return node;
        if (node.metadata?.assetId) return node;
        const primaryAssetId = primary.metadata?.assetId;
        if (!primaryAssetId) return node;
        changed = true;
        return { ...node, metadata: { ...node.metadata, assetId: primaryAssetId } };
    });
    return { nodes: changed ? next : nodes, changed };
}

export function syncInMemoryCanvasProjectMediaAssets(project: CanvasProject): boolean {
    const assets = useAssetStore.getState().assets;
    const firstPass = propagateBatchRootAssetIds(project.nodes);
    let changed = firstPass.changed;
    const boundNodes = firstPass.nodes.map((node) => {
        const bound = bindCanvasNodeResourceAsset(node, firstPass.nodes, assets);
        if (bound !== node) changed = true;
        return bound;
    });
    const secondPass = propagateBatchRootAssetIds(boundNodes);
    if (secondPass.changed) changed = true;
    if (changed) {
        project.nodes = secondPass.nodes;
        useCanvasStore.getState().updateProject(project.id, { nodes: secondPass.nodes });
    }
    return changed;
}

export async function persistCanvasGenerationTarget(input: {
    projectId: string;
    nodeId: string;
    clientOperationId?: string;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}, persist: typeof persistCanvasDocument = persistCanvasDocument) {
    const assertCurrent = () => {
        if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        if (input.isCurrent && !input.isCurrent()) throw new DOMException("The canvas operation was abandoned", "AbortError");
    };
    assertCurrent();
    const project = useCanvasStore.getState().openProject(input.projectId);
    if (!project?.nodes.some((node) => node.id === input.nodeId)) throw new CanvasGenerationTargetSaveError(undefined, "生成节点已不存在，未开始生成");
    if (input.clientOperationId) {
        project.nodes = project.nodes.map((node) => node.id === input.nodeId ? { ...node, metadata: { ...node.metadata, taskClientOperationId: input.clientOperationId, generationSubmissionState: "submitting" } } : node);
        useCanvasStore.getState().updateProject(project.id, { nodes: project.nodes });
    }
    syncInMemoryCanvasProjectMediaAssets(project);
    try {
        await persist(input.projectId, { nodes: project.nodes, connections: project.connections });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new CanvasGenerationTargetSaveError(error);
    }
    assertCurrent();
    const current = useCanvasStore.getState().openProject(input.projectId);
    if (!current?.nodes.some((node) => node.id === input.nodeId)) {
        // 保存期间的删除也必须提交；旧快照的回执不能让节点在下次打开时重现。
        if (current) await persist(input.projectId, { nodes: current.nodes, connections: current.connections });
        throw new CanvasGenerationTargetSaveError(undefined, "生成节点已不存在，未开始生成");
    }
}
