import { generationTaskMode } from "@/lib/canvas/canvas-generation-task-sync";
import type { GenerationTask } from "@/services/api/task-center";

const INSERTABLE_HISTORY_MODES = new Set(["image", "video", "audio"]);

/** List filter for TaskSummary cards. Display uses previewUrl/previewKind; resultJson lives on detail. */
export function insertableCanvasGenerationHistoryTasks(
    tasks: GenerationTask[],
    options: { projectId: string; keyword?: string },
) {
    const projectId = options.projectId.trim();
    const keyword = (options.keyword || "").trim().toLocaleLowerCase();
    return tasks
        .filter((task) => task.projectId === projectId)
        .filter((task) => task.status === "succeeded")
        .filter((task) => INSERTABLE_HISTORY_MODES.has(generationTaskMode(task)))
        .filter((task) => !keyword || `${task.prompt} ${task.model || ""}`.toLocaleLowerCase().includes(keyword))
        .slice(0, 60);
}

export type ResolveCanvasGenerationHistoryTaskQuery = (id: string) => Promise<GenerationTask>;

/** One detail fetch on select. Confirms success, same canvas, and a usable media result before insert. */
export async function resolveCanvasGenerationHistoryTaskForInsert(
    task: GenerationTask,
    options: { projectId: string; queryTask?: ResolveCanvasGenerationHistoryTaskQuery },
): Promise<GenerationTask> {
    const projectId = options.projectId.trim();
    if (!task.id?.trim()) throw new Error("该任务没有可插入的生成结果");
    if (task.projectId && task.projectId !== projectId) throw new Error("生成任务不属于当前画布");
    const queryTask = options.queryTask ?? (async (id: string) => (await import("@/services/api/task-center")).queryGenerationTask(id));
    const detail = await queryTask(task.id);
    if (detail.projectId && detail.projectId !== projectId) throw new Error("生成任务不属于当前画布");
    if (detail.status === "failed" || detail.status === "cancelled") {
        throw new Error(detail.error || (detail.status === "cancelled" ? "任务已取消" : "任务失败"));
    }
    if (detail.status !== "succeeded") {
        throw new Error(detail.error || "该任务没有可插入的生成结果");
    }
    if (!INSERTABLE_HISTORY_MODES.has(generationTaskMode(detail))) {
        throw new Error("该任务没有可插入的生成结果");
    }
    if (!historyDetailHasInsertableMedia(detail)) {
        throw new Error("该任务没有可插入的生成结果");
    }
    return detail;
}

function historyDetailHasInsertableMedia(task: GenerationTask) {
    if (!task.resultJson?.trim()) return false;
    try {
        const result = JSON.parse(task.resultJson) as {
            images?: Array<{ dataUrl?: string; url?: string; storageKey?: string }>;
            video?: { dataUrl?: string; url?: string; storageKey?: string };
            audio?: { dataUrl?: string; url?: string; storageKey?: string };
        };
        if (!result || typeof result !== "object") return false;
        const mode = generationTaskMode(task);
        const image = result.images?.[0];
        if (mode === "image") return Boolean(image?.dataUrl || image?.url || image?.storageKey);
        if (mode === "video") return Boolean(result.video?.dataUrl || result.video?.url || result.video?.storageKey);
        if (mode === "audio") return Boolean(result.audio?.dataUrl || result.audio?.url || result.audio?.storageKey);
        return false;
    } catch {
        return false;
    }
}
