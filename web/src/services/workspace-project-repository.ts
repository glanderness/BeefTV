import { listCanvasWorkspaceProjectCanvases } from "@/lib/canvas/canvas-workspace-project";
import { beginLocalCanvasProject, createLocalCanvasProject, deleteLocalCanvasProjects, syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";
import { loadCanvasProjectForEditing } from "@/services/local-workspace-sync";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

type InitialCanvasContent = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">>;

/** Single project-storage boundary for workspace UI code. */
export async function createWorkspaceCanvasProject(title: string, projectId?: string, initialContent?: InitialCanvasContent, workspaceProjectId?: string) {
    return createLocalCanvasProject(title, projectId, initialContent, workspaceProjectId);
}

export async function deleteWorkspaceCanvasProjects(ids: readonly string[]) {
    return deleteLocalCanvasProjects(ids);
}

export async function duplicateWorkspaceCanvasProject(
    localProjects: readonly CanvasProject[],
    project: Pick<CanvasProject, "id" | "title">,
): Promise<{ workspaceProjectId: string; count: number }> {
    const persistedIds: string[] = [];
    const unpersistedIds: string[] = [];
    try {
        const sourceCanvases = listCanvasWorkspaceProjectCanvases(localProjects, project.id);
        if (!sourceCanvases.length) throw new Error("项目不存在");
        // 先预加载整个项目下的全部画布，避免读到一半失败留下残缺副本。
        const loadedSources = await Promise.all(sourceCanvases.map(async (summaryOrFull) => {
            const source = summaryOrFull.summaryOnly
                ? await loadCanvasProjectForEditing(summaryOrFull.id)
                : summaryOrFull;
            if (!source || source.summaryOnly) throw new Error("项目不存在或读取未完成");
            return source;
        }));
        let copiedWorkspaceProjectId: string | undefined;
        for (const [index, source] of loadedSources.entries()) {
            const { id, saved } = beginLocalCanvasProject(
                index === 0 ? `${project.title || "未命名项目"} 副本` : source.title,
                source.projectId,
                {
                    nodes: source.nodes,
                    connections: source.connections,
                    chatSessions: source.chatSessions,
                    activeChatId: source.activeChatId,
                },
                copiedWorkspaceProjectId,
            );
            unpersistedIds.push(id);
            copiedWorkspaceProjectId ||= id;
            await saved;
            unpersistedIds.pop();
            persistedIds.push(id);
        }
        if (!copiedWorkspaceProjectId) throw new Error("项目不存在");
        return { workspaceProjectId: copiedWorkspaceProjectId, count: loadedSources.length };
    } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (unpersistedIds.length > 0) {
            try {
                await deleteLocalCanvasProjects(unpersistedIds, { recordHistory: false });
            } catch (rollbackError) {
                rollbackErrors.push(rollbackError);
            }
        }
        if (persistedIds.length > 0) {
            try {
                await deleteLocalCanvasProjects(persistedIds, { recordHistory: false });
            } catch (rollbackError) {
                rollbackErrors.push(rollbackError);
            }
        }
        if (rollbackErrors.length > 0) {
            const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "复制失败";
            const firstRollback = rollbackErrors[0];
            const rollbackDetail = firstRollback instanceof Error && firstRollback.message.trim()
                ? firstRollback.message.trim()
                : "后端不可用";
            throw new Error(`${detail}（副本回滚清理未确认：${rollbackDetail}）`);
        }
        throw error;
    }
}

export function prepareRestoredDeletedCanvas(project: CanvasProject): CanvasProject {
    const {
        summaryOnly: _summaryOnly,
        summaryNodeCount: _summaryNodeCount,
        summaryMediaKeys: _summaryMediaKeys,
        remoteContentHash: _remoteContentHash,
        ...rest
    } = project;
    return {
        ...rest,
        revision: 0,
        updatedAt: new Date().toISOString(),
    };
}

export async function restoreDeletedCanvasProjects(
    ids: readonly string[],
): Promise<{ restoredIds: string[]; failedIds: string[]; firstError?: unknown }> {
    const historyState = useCanvasHistoryStore.getState();
    const canvasState = useCanvasStore.getState();
    const candidates: CanvasProject[] = [];
    const skippedSummaryIds: string[] = [];
    for (const id of ids) {
        const item = historyState.deletedProjects.find((entry) => entry.id === id);
        if (!item) continue;
        if (!item.project || item.project.summaryOnly) {
            skippedSummaryIds.push(item.id);
            continue;
        }
        const restored = prepareRestoredDeletedCanvas(item.project);
        canvasState.restoreProject(restored);
        candidates.push(restored);
    }
    const summaryError = skippedSummaryIds.length > 0
        ? new Error("部分历史记录仅包含摘要，无法直接恢复")
        : undefined;
    if (candidates.length === 0) {
        return { restoredIds: [], failedIds: skippedSummaryIds, firstError: summaryError };
    }
    try {
        await flushCanvasStorePersistence();
    } catch (error) {
        useCanvasStore.getState().deleteProjects(candidates.map((item) => item.id));
        return {
            restoredIds: [],
            failedIds: [...candidates.map((item) => item.id), ...skippedSummaryIds],
            firstError: error,
        };
    }
    const restoredIds: string[] = [];
    const failedIds: string[] = [];
    let firstError: unknown;
    if (isLocalWorkspaceMode()) {
        for (const restored of candidates) {
            try {
                await syncLocalCanvasProjectToBackend(restored.id);
                restoredIds.push(restored.id);
            } catch (error) {
                failedIds.push(restored.id);
                if (firstError === undefined) firstError = error;
            }
        }
        if (failedIds.length > 0) {
            await deleteLocalCanvasProjects(failedIds, { recordHistory: false }).catch(() => {
                useCanvasStore.getState().deleteProjects(failedIds);
            });
        }
    } else {
        restoredIds.push(...candidates.map((item) => item.id));
    }
    const removeDeletedItem = useCanvasHistoryStore.getState().removeDeletedHistoryItem;
    for (const id of restoredIds) removeDeletedItem(id);
    if (skippedSummaryIds.length > 0) {
        failedIds.push(...skippedSummaryIds);
        if (firstError === undefined) firstError = summaryError;
    }
    return { restoredIds, failedIds, firstError };
}
