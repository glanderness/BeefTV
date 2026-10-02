import { getCanvasHistoryEntry, listCanvasHistory, type CanvasHistoryEntry } from "@/services/api/workspace-data";
import type { CanvasSyncDraft } from "@/services/canvas-sync-drafts";

export const CANVAS_SAVED_VERSION_TAB_LABEL = "已保存版本";
export const CANVAS_LOCAL_DRAFT_TAB_LABEL = "本机草稿";

export type PersistedCanvasVersionHistory = {
    snapshots: CanvasHistoryEntry[];
    currentRevision: number;
};

/** Local workspace Go snapshots are canonical. Conflict drafts stay on a separate list. */
export async function loadPersistedCanvasVersionHistory(
    projectId: string,
    options: {
        signal?: AbortSignal;
        list?: (id: string, signal?: AbortSignal) => Promise<PersistedCanvasVersionHistory>;
    } = {},
) {
    const id = projectId.trim();
    if (!id) throw new Error("缺少画布");
    const list = options.list ?? listCanvasHistory;
    return list(id, options.signal);
}

export function partitionCanvasVersionHistory(input: {
    snapshots: CanvasHistoryEntry[];
    drafts: CanvasSyncDraft[];
}) {
    const savedIds = new Set(input.snapshots.map((entry) => entry.id));
    return {
        saved: input.snapshots,
        drafts: input.drafts,
        mixed: input.drafts.some((draft) => savedIds.has(draft.id)),
    };
}

export function loadPersistedCanvasVersionEntry(
    projectId: string,
    snapshotId: string,
    signal?: AbortSignal,
) {
    return getCanvasHistoryEntry(projectId, snapshotId, signal);
}
