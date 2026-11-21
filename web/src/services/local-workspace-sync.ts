import { rebindInconsistentCanvasAssets, type CanvasAssetRebindResult } from "@/services/canvas-asset-repair";
import { openLocalCanvasProject, openLocalCanvasProjectFromBackend, persistCanvasDocument, restoreLocalCanvasProjectFromHistory } from "@/services/local-workspace-repository";
import { flushAssetStorePersistence, useAssetStore } from "@/stores/use-asset-store";
import {
    loadWorkspaceAssetLibraryPage,
    loadWorkspaceAssetsForUse,
    type WorkspaceAssetLibraryPageOptions,
} from "@/services/workspace-asset-read";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

const canvasRefreshListeners = new Set<(project: CanvasProject, previous: CanvasProject | undefined) => void>();

export async function loadCanvasProjectForEditing(
    id: string,
    options: { historyRestore?: { snapshotId: string; revision: number }; onLoad?: (project: CanvasProject) => void } = {},
) {
    if (options.historyRestore) {
        const restored = await restoreLocalCanvasProjectFromHistory(id, options.historyRestore);
        options.onLoad?.(restored);
        return restored;
    }
    const project = await openLocalCanvasProjectFromBackend(id);
    if (project?.summaryOnly) throw new Error("画布尚未完整加载，请重试");
    if (project) options.onLoad?.(project);
    return project || undefined;
}

// 画布内容被其他写入者（远端刷新、任务回写）替换后通知本地编辑器合并。
export function subscribeCanvasRefresh(listener: (project: CanvasProject, previous: CanvasProject | undefined) => void) {
    canvasRefreshListeners.add(listener);
    return () => { canvasRefreshListeners.delete(listener); };
}

/** 外部写入已投影到本地存储后，把这次替换交给正在编辑的页面。 */
export function notifyCanvasRefresh(project: CanvasProject, previous: CanvasProject | undefined) {
    for (const listener of [...canvasRefreshListeners]) listener(project, previous);
}

/**
 * Persist an editor snapshot to the co-packaged Go repository. Callers that
 * mutate the canvas outside the autosave flow (for example node deletion) must
 * use this bridge so the next remote refresh cannot resurrect a stale snapshot.
 */
export async function syncLocalCanvasSnapshot(id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "appearance" | "backgroundMode" | "showImageInfo" | "viewport">>) {
    const current = openLocalCanvasProject(id);
    if (!current) throw new Error("本地画布不存在");
    const { viewport, ...documentPatch } = patch;
    if (viewport) useCanvasStore.getState().updateProject(id, { viewport });
    if (Object.keys(documentPatch).length > 0) await persistCanvasDocument(id, documentPatch);
    const saved = openLocalCanvasProject(id);
    if (!saved) throw new Error("本地画布不存在");
    return saved;
}

export type LocalAssetPageOptions = WorkspaceAssetLibraryPageOptions;

export function loadAssetLibraryPage(options: LocalAssetPageOptions) {
    return loadWorkspaceAssetLibraryPage(options);
}

export function loadAssetsForUse(ids: Iterable<string>) {
    return loadWorkspaceAssetsForUse(ids);
}

export function localSavedRemotePendingMessage(localAction: string, error: unknown) {
    const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "未知错误";
    return `${localAction}失败：${detail}`;
}

/** Flush local workspace persistence stores (canvas + assets). */
export async function saveRemoteUserDataNow(_input?: string | readonly string[] | { force?: boolean }) {
    await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
}

export async function forceOverwriteRemoteCanvasSync(): Promise<CanvasAssetRebindResult> {
    const result = rebindInconsistentCanvasAssets(useAssetStore.getState().assets);
    await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
    return result;
}
