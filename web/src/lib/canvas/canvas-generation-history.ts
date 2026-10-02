import { generationTaskMode } from "@/lib/canvas/canvas-generation-task-sync";
import { listGenerationTasks, type GenerationTask } from "@/services/api/task-center";

export type CanvasGenerationHistoryListFn = (projectId: string, signal?: AbortSignal) => Promise<GenerationTask[]>;

/** Desktop and browser both read persisted Go tasks. Canvas nodes are not a history store. */
export async function loadCanvasGenerationHistory(
    projectId: string,
    options: { signal?: AbortSignal; list?: CanvasGenerationHistoryListFn } = {},
) {
    const id = projectId.trim();
    if (!id) throw new Error("缺少画布");
    const list = options.list ?? ((canvasId, signal) => listGenerationTasks(100, { projectId: canvasId, activeOnly: false }, undefined, signal));
    return list(id, options.signal);
}

export function insertableCanvasGenerationHistoryTasks(
    tasks: GenerationTask[],
    options: { projectId: string; keyword?: string },
) {
    const projectId = options.projectId.trim();
    const keyword = (options.keyword || "").trim().toLocaleLowerCase();
    return tasks
        .filter((task) => task.projectId === projectId)
        .filter((task) => task.status === "succeeded")
        .filter((task) => ["image", "video", "audio"].includes(generationTaskMode(task)))
        .filter((task) => Boolean(task.resultJson?.trim()))
        .filter((task) => !keyword || `${task.prompt} ${task.model || ""}`.toLocaleLowerCase().includes(keyword))
        .slice(0, 60);
}
