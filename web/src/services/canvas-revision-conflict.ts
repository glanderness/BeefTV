import { ApiError } from "@/services/api/request";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { projectSyncProgress, useSyncProgressStore } from "@/stores/use-sync-progress-store";
import { getActiveUserScope } from "@/lib/user-scope";
import { isUserScopeAbandonedError } from "@/lib/user-scope-guard";

export class CanvasBackendSubmitPausedError extends Error {
    constructor(message = "画布有未处理的外部改动，本次未提交") {
        super(message);
        this.name = "CanvasBackendSubmitPausedError";
    }
}

export class CanvasStaleScopeError extends Error {
    constructor(message = "账号已切换，未提交画布") {
        super(message);
        this.name = "CanvasStaleScopeError";
    }
}

/** 409 与 428 都表示本次提交的前提 revision 已过时：后端拒绝，本地内容仍是唯一副本。 */
export function isCanvasRevisionConflict(error: unknown) {
    return error instanceof ApiError && (error.status === 409 || error.status === 428 || error.reason === "stale_revision");
}

export function isCanvasSubmitControlError(error: unknown) {
    return error instanceof CanvasBackendSubmitPausedError || error instanceof CanvasStaleScopeError || isUserScopeAbandonedError(error);
}

/**
 * 后端按 revision 原子拒绝（陈旧提交）后的收尾：先把本地内容落成草稿，
 * 再把该画布标成冲突并暂停自动提交。不静默重试，也不改写本地内容。
 *
 * 草稿模块在加载期回到本模块的调用方，因此这里用动态导入打破加载环，
 * 同时保证只有真的发生陈旧拒绝时才付出这次加载成本。
 */
export async function handleRejectedCanvasBackendSave(id: string, project: CanvasProject | null | undefined, error: unknown, scope = getActiveUserScope()) {
    if (!isCanvasRevisionConflict(error)) return false;
    if (project) {
        try {
            const { preserveCanvasSyncDraft } = await import("@/services/canvas-sync-drafts");
            await preserveCanvasSyncDraft(project, scope);
        } catch (draftError) {
            console.error("画布冲突草稿保留失败", { id, error: draftError });
        }
    }
    pauseCanvasBackendSubmit(id, scope);
    return true;
}

export function pauseCanvasBackendSubmit(id: string, scope = getActiveUserScope(), message = "画布已被其他入口修改，本次改动未提交；现有内容已保留在本机") {
    useSyncProgressStore.getState().setProjectProgress(id, { phase: "conflict", message }, scope);
}

/** 冲突后暂停自动提交，避免同一份过时 revision 反复提交。 */
export function canvasBackendSubmitPaused(id: string, scope = getActiveUserScope()) {
    return projectSyncProgress(id, scope)?.phase === "conflict";
}

/** 后端已接受这次提交：解除暂停，画布恢复自动保存。 */
export function resumeCanvasBackendSubmit(id: string, scope = getActiveUserScope()) {
    if (!canvasBackendSubmitPaused(id, scope)) return;
    useSyncProgressStore.getState().setProjectProgress(id, { phase: "done", message: "画布已保存" }, scope);
}
