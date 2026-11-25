import { generationTaskMode } from "@/lib/canvas/canvas-generation-task-sync";
import type { GenerationTask } from "@/services/api/task-center";
import { ownedResourceIdFromMediaRef, resourceIdFromStorageKey, resourceStorageKey } from "@/services/api/resources";

const INSERTABLE_HISTORY_MODES = new Set(["image", "video", "audio"]);

export function generationHistoryVideoSource(task: GenerationTask) {
    // Saved outputs outlive the provider's signed delivery URL in resultJson.
    const output = task.outputs?.find((item) => item.mediaType === "video" && item.outputIndex === 0);
    if (output?.resourceId) return { storageKey: resourceStorageKey(output.resourceId), url: "" };
    const result = JSON.parse(task.resultJson || "{}");
    const media = result.video;
    const fallback = media?.dataUrl || media?.url || "";
    const id = resourceIdFromStorageKey(media?.storageKey)
        || ownedResourceIdFromMediaRef(media?.storageKey, fallback)
        || (typeof media?.resourceId === "string" ? media.resourceId : "")
        || (typeof result.resourceId === "string" ? result.resourceId : "");
    if (id) return { storageKey: resourceStorageKey(id), url: "" };
    if (!fallback && !media?.storageKey) throw new Error("缺少媒体地址");
    return { storageKey: media?.storageKey || "", url: fallback };
}

export type CanvasGenerationHistorySelectGate = {
    open: boolean;
    projectId: string;
    mounted: boolean;
    selectionEpoch: number;
};

function hasOnlyDeletedGenerationOutputs(task: GenerationTask) {
    return Boolean(task.outputs?.length) && task.outputs!.every((output) => output.materializationErrorCode === "asset_deleted");
}

/**
 * A partially deleted batch can still expose its delivered images. Keep their
 * original indexes so canvas insertion binds the right task output and asset.
 * Other tasks retain their existing insert and preview behavior.
 */
export function survivingGenerationHistoryImageOutputs(task: GenerationTask) {
    const outputs = task.outputs?.filter((output) => output.mediaType === "image");
    if (!outputs?.some((output) => output.materializationErrorCode === "asset_deleted")) return undefined;
    return outputs
        .filter((output) => output.materializationErrorCode !== "asset_deleted" && output.resourceId?.trim() && output.materializedAssetId?.trim())
        .sort((left, right) => left.outputIndex - right.outputIndex);
}

/** List filter for TaskSummary cards. Display uses previewUrl/previewKind; resultJson lives on detail. */
export function insertableCanvasGenerationHistoryTasks(
    tasks: GenerationTask[],
    options: { projectId: string; keyword?: string },
) {
    const projectId = options.projectId.trim();
    if (!projectId) return [];
    const keyword = (options.keyword || "").trim().toLocaleLowerCase();
    return tasks
        .filter((task) => task.projectId === projectId)
        .filter((task) => task.status === "succeeded")
        .filter((task) => {
            const mode = generationTaskMode(task);
            if (!INSERTABLE_HISTORY_MODES.has(mode) || hasOnlyDeletedGenerationOutputs(task)) return false;
            const surviving = mode === "image" ? survivingGenerationHistoryImageOutputs(task) : undefined;
            return surviving === undefined || surviving.length > 0;
        })
        .filter((task) => !keyword || `${task.prompt} ${task.model || ""}`.toLocaleLowerCase().includes(keyword))
        .slice(0, 60);
}

/** Close / canvas switch / unmount after await must not apply the old detail. */
export function canvasGenerationHistorySelectStillValid(
    captured: CanvasGenerationHistorySelectGate,
    live: CanvasGenerationHistorySelectGate,
) {
    if (!captured.mounted || !live.mounted) return false;
    if (!captured.open || !live.open) return false;
    if (captured.selectionEpoch !== live.selectionEpoch) return false;
    const capturedProjectId = captured.projectId.trim();
    const liveProjectId = live.projectId.trim();
    if (!capturedProjectId || capturedProjectId !== liveProjectId) return false;
    return true;
}

/** Pure detail check: strict id + non-empty project match, success, and usable media. */
export function assertCanvasGenerationHistoryTaskForInsert(
    detail: GenerationTask,
    options: { projectId: string; expectedId: string },
): GenerationTask {
    const projectId = options.projectId.trim();
    const expectedId = options.expectedId.trim();
    const detailId = detail.id?.trim() ?? "";
    const detailProjectId = detail.projectId?.trim() ?? "";
    if (!expectedId || !detailId || detailId !== expectedId) {
        throw new Error("该任务没有可插入的生成结果");
    }
    if (!projectId || !detailProjectId || detailProjectId !== projectId) {
        throw new Error("生成任务不属于当前画布");
    }
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

/** Await an already-started detail query, then apply only if the picker is still the same canvas. */
export async function awaitCanvasGenerationHistoryDetailIfValid(input: {
    detail: Promise<GenerationTask>;
    captured: CanvasGenerationHistorySelectGate;
    live: () => CanvasGenerationHistorySelectGate;
    expectedId: string;
}): Promise<GenerationTask | undefined> {
    const detail = await input.detail;
    if (!canvasGenerationHistorySelectStillValid(input.captured, input.live())) return undefined;
    return assertCanvasGenerationHistoryTaskForInsert(detail, {
        projectId: input.captured.projectId,
        expectedId: input.expectedId,
    });
}

function historyDetailHasInsertableMedia(task: GenerationTask) {
    if (hasOnlyDeletedGenerationOutputs(task)) return false;
    const mode = generationTaskMode(task);
    const surviving = mode === "image" ? survivingGenerationHistoryImageOutputs(task) : undefined;
    if (surviving !== undefined) return surviving.length > 0;
    const primaryOutput = task.outputs?.find((output) => output.outputIndex === 0 && output.mediaType === mode);
    if (primaryOutput?.materializationErrorCode === "asset_deleted") return false;
    if (primaryOutput?.resourceId) return true;
    if (!task.resultJson?.trim()) return false;
    try {
        const result = JSON.parse(task.resultJson) as {
            images?: Array<{ dataUrl?: string; url?: string; storageKey?: string }>;
            video?: { dataUrl?: string; url?: string; storageKey?: string };
            audio?: { dataUrl?: string; url?: string; storageKey?: string };
        };
        if (!result || typeof result !== "object") return false;
        const image = result.images?.[0];
        if (mode === "image") return Boolean(image?.dataUrl || image?.url || image?.storageKey);
        if (mode === "video") return Boolean(result.video?.dataUrl || result.video?.url || result.video?.storageKey);
        if (mode === "audio") return Boolean(result.audio?.dataUrl || result.audio?.url || result.audio?.storageKey);
        return false;
    } catch {
        return false;
    }
}
