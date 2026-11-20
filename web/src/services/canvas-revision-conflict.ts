import { ApiError } from "@/services/api/request";
import { projectSyncProgress, useSyncProgressStore } from "@/stores/use-sync-progress-store";

export class CanvasBackendSubmitPausedError extends Error {
    constructor(message = "画布正在删除，未提交") {
        super(message);
        this.name = "CanvasBackendSubmitPausedError";
    }
}

/** 409 还可能表示节点/任务身份冲突，只有版本冲突才能进入重试。 */
export function isCanvasRevisionConflict(error: unknown) {
    if (!(error instanceof ApiError)) return false;
    return error.reason === "stale_revision" || error.status === 428 || (error.status === 409 && (!error.reason || error.reason === "conflict"));
}

export function isCanvasSubmitControlError(error: unknown) {
    return error instanceof CanvasBackendSubmitPausedError;
}

const SAVE_PROGRESS_MESSAGES = {
    pending: "正在保存",
    saving: "正在保存",
    done: "画布已保存",
    error: "保存没有完成，修改仍保留在本机。",
} as const;

export type CanvasBackendSaveProgressPhase = keyof typeof SAVE_PROGRESS_MESSAGES;

/** 发布画布保存的真实进度：排队、提交中、已被服务端接受、失败。 */
export function setCanvasBackendSaveProgress(id: string, scope: string, phase: CanvasBackendSaveProgressPhase) {
    const message = SAVE_PROGRESS_MESSAGES[phase];
    const current = projectSyncProgress(id, scope);
    if (current?.phase === phase && current.message === message) return;
    useSyncProgressStore.getState().setProjectProgress(id, { phase, message }, scope);
}

/** 画布已删除：不再保留它的保存进度。 */
export function clearCanvasBackendSaveProgress(id: string, scope: string) {
    useSyncProgressStore.getState().setProjectProgress(id, null, scope);
}
