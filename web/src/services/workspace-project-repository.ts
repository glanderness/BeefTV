import { listCanvasWorkspaceProjectCanvases } from "@/lib/canvas/canvas-workspace-project";
import { beginLocalCanvasProject, createLocalCanvasProject, deleteLocalCanvasProjects } from "@/services/local-workspace-repository";
import { loadCanvasProjectForEditing } from "@/services/local-workspace-sync";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

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
        if (unpersistedIds.length > 0) {
            await deleteLocalCanvasProjects(unpersistedIds, { recordHistory: false }).catch(() => undefined);
        }
        if (persistedIds.length > 0) {
            try {
                await deleteLocalCanvasProjects(persistedIds, { recordHistory: false });
            } catch (rollbackError) {
                const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "复制失败";
                const rollbackDetail = rollbackError instanceof Error && rollbackError.message.trim()
                    ? rollbackError.message.trim()
                    : "后端不可用";
                throw new Error(`${detail}（已创建的 ${persistedIds.length} 张副本回滚失败：${rollbackDetail}）`);
            }
        }
        throw error;
    }
}
