import { createLocalCanvasProject, deleteLocalCanvasProjects } from "@/services/local-workspace-repository";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

type InitialCanvasContent = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">>;

/** Single project-storage boundary for workspace UI code. */
export async function createWorkspaceCanvasProject(title: string, projectId?: string, initialContent?: InitialCanvasContent, workspaceProjectId?: string) {
    const local = await createLocalCanvasProject(title, projectId, initialContent, workspaceProjectId);
    return { ...local, syncError: undefined as undefined };
}

export async function deleteWorkspaceCanvasProjects(ids: readonly string[]) {
    return deleteLocalCanvasProjects(ids);
}
