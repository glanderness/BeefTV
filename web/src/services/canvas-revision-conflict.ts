import { ApiError } from "@/services/api/request";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useSyncProgressStore } from "@/stores/use-sync-progress-store";

/** 409 与 428 都表示本次提交的前提 revision 已过时：后端拒绝，本地内容仍是唯一副本。 */
export function isCanvasRevisionConflict(error: unknown) {
    return error instanceof ApiError && (error.status === 409 || error.status === 428);
}

/**
 * 后端按 revision 原子拒绝（陈旧提交）后的收尾：先把本地内容落成草稿，
 * 再把该画布标成冲突并暂停自动提交。不静默重试，也不改写本地内容。
 *
 * 草稿模块在加载期回到本模块的调用方，因此这里用动态导入打破加载环，
 * 同时保证只有真的发生陈旧拒绝时才付出这次加载成本。
 */
export async function handleRejectedCanvasBackendSave(id: string, project: CanvasProject | null | undefined, error: unknown) {
    if (!isCanvasRevisionConflict(error)) return false;
    if (project) {
        try {
            const { preserveCanvasSyncDraft } = await import("@/services/canvas-sync-drafts");
            await preserveCanvasSyncDraft(project);
        } catch (draftError) {
            console.error("画布冲突草稿保留失败", { id, error: draftError });
        }
    }
    useSyncProgressStore.getState().setProjectProgress(id, {
        phase: "conflict",
        message: "画布已被其他入口修改，本次改动未提交；现有内容已保留在本机",
    });
    return true;
}

/** 冲突后暂停自动提交，避免同一份过时 revision 反复提交。 */
export function canvasBackendSubmitPaused(id: string) {
    return useSyncProgressStore.getState().syncingProjects[id]?.phase === "conflict";
}

/** 后端已接受这次提交：解除暂停，画布恢复自动保存。 */
export function resumeCanvasBackendSubmit(id: string) {
    if (!canvasBackendSubmitPaused(id)) return;
    useSyncProgressStore.getState().setProjectProgress(id, { phase: "done", message: "画布已保存" });
}
