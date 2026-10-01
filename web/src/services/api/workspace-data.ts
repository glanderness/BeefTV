import type { Asset } from "@/stores/use-asset-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { http, compactApiParams } from "@/services/api/request";

export type AssetFolder = {
    id: string;
    name: string;
    position: number;
    createdAt: string;
    updatedAt: string;
};

export type CanvasLibrarySummary = Pick<CanvasProject, "id" | "workspaceProjectId" | "projectId" | "folderId" | "title" | "revision" | "createdAt" | "updatedAt"> & {
    nodeCount: number;
    previewNodes: CanvasProject["nodes"];
};

export function listWorkspaceCanvasProjectsPage(options: { page: number; pageSize: number; projectId?: string; query?: string; sort?: string; signal?: AbortSignal }) {
    return http.get<{ projects: CanvasLibrarySummary[]; page: number; pageSize: number; total: number; hasMore: boolean }>("/canvas-projects", {
        signal: options.signal,
        params: compactApiParams({ page: options.page, pageSize: options.pageSize, projectId: options.projectId, q: options.query, sort: options.sort }),
    });
}

export function listAssetFolders() {
    return http.get<{ folders: AssetFolder[] }>("/asset-folders");
}

export function createAssetFolder(name: string) {
    return http.post<{ folder: AssetFolder }>("/asset-folders", { name });
}

export function updateAssetFolder(id: string, name: string) {
    return http.patch<{ folder: AssetFolder }>(`/asset-folders/${encodeURIComponent(id)}`, { name });
}

export function deleteAssetFolder(id: string) {
    return http.delete<{ id: string }>(`/asset-folders/${encodeURIComponent(id)}`);
}

export function moveAssetsToFolder(assetIds: string[], folderId = "") {
    return http.patch<{ assetIds: string[]; folderId: string }>("/assets/folder", { assetIds, folderId });
}

export function getWorkspaceAsset(id: string, signal?: AbortSignal) {
    return http.get<{ asset: Asset }>(`/assets/${encodeURIComponent(id)}`, { signal });
}

export type CanvasHistoryEntry = {
    id: string;
    canvasId: string;
    revision: number;
    title: string;
    nodeCount: number;
    connectionCount: number;
    payloadBytes: number;
    reason: "automatic" | "before_restore";
    createdAt: string;
    contentUpdatedAt: string;
};

export function listCanvasHistory(id: string, signal?: AbortSignal) {
    return http.get<{ snapshots: CanvasHistoryEntry[]; currentRevision: number }>(`/canvas-projects/${encodeURIComponent(id)}/history`, { signal });
}

export function getCanvasHistoryEntry(id: string, snapshotId: string, signal?: AbortSignal) {
    return http.get<{ snapshot: CanvasHistoryEntry; project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}/history/${encodeURIComponent(snapshotId)}`, { signal });
}
