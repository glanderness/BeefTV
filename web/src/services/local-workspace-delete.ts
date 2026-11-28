import { clearCanvasDocumentBase, flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { http } from "@/services/api/request";
import { clearCanvasBackendSaveProgress } from "@/services/canvas-revision-conflict";
import { clearCanvasOperationJournal, loadCanvasOperationJournal, peekCanvasOperationJournal } from "@/services/canvas-operation-journal";
import { getActiveUserScope } from "@/lib/user-scope";
import { normalizeCanvasProjectGraph } from "@/lib/canvas/canvas-content";
import { isNotFoundApiError, readLocalCanvasProjectFromBackend } from "./local-workspace-hydration";
import {
    backendSaveControllers,
    backendSaveTails,
    backendSaveTimers,
    canvasDeleting,
    flushPendingCanvasOverlapWrite,
    pendingForceHistorySnapshotEpochs,
    publishCanvasSaveProgress,
    saveKey,
    serverConfirmedCanvasSnapshots,
} from "./local-workspace-state";

const DEFAULT_DELETE_IDLE_SETTLE_TIMEOUT_MS = 1_500;
const DEFAULT_DELETE_SNAPSHOT_TIMEOUT_MS = 1_500;

function abortBackendSaves(key: string) {
    const set = backendSaveControllers.get(key);
    if (!set) return;
    for (const controller of [...set]) {
        controller.abort();
    }
}

async function awaitWithBoundedTimeout(promise: Promise<unknown>, timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            promise.catch(() => undefined),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function waitForCanvasBackendIdle(id: string, scope: string, settleTimeoutMs = DEFAULT_DELETE_IDLE_SETTLE_TIMEOUT_MS) {
    const key = saveKey(scope, id);
    const timer = backendSaveTimers.get(key);
    if (timer) {
        clearTimeout(timer);
        backendSaveTimers.delete(key);
    }
    abortBackendSaves(key);
    const tail = backendSaveTails.get(key);
    if (tail) await awaitWithBoundedTimeout(tail, settleTimeoutMs);
    // 被取消的排队提交不会再发出：删除失败时如实显示为未保存。
    if (timer) publishCanvasSaveProgress(id, scope, true);
}

/**
 * 尽力获取删除撤销快照（限时 1500ms）。
 * 读取失败或超时时跳过回收站记录，绝不阻塞画布 DELETE。
 */
async function loadBestEffortDeleteSnapshot(
    id: string,
    scope: string,
    current: CanvasProject,
    recordHistory: boolean,
    timeoutMs: number,
): Promise<CanvasProject | undefined> {
    if (!current.summaryOnly || !recordHistory) return current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve(undefined);
        }, timeoutMs);
    });
    const fetchSnapshot = (async (): Promise<CanvasProject | undefined> => {
        try {
            const journal = await loadCanvasOperationJournal(id, scope);
            const candidate = journal.inFlight?.payload?.document;
            if (candidate && !candidate.summaryOnly) {
                return normalizeCanvasProjectGraph(candidate);
            }
        } catch {
            // 日记读取失败时回退到后端完整读取。
        }
        if (controller.signal.aborted) return undefined;
        try {
            return await readLocalCanvasProjectFromBackend(id, controller.signal);
        } catch (error) {
            if (!isNotFoundApiError(error)) {
                console.warn("删除画布前读取撤销快照失败，跳过回收站记录并继续删除", { id, error });
            }
            return undefined;
        }
    })();
    try {
        return await Promise.race([fetchSnapshot, timeoutPromise]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        // 避免超时的后台 Promise 在后续抛出未捕获异常。
        void fetchSnapshot.catch(() => undefined);
    }
}

export async function deleteLocalCanvasProjects(
    ids: readonly string[],
    options: { recordHistory?: boolean; snapshotTimeoutMs?: number; idleSettleTimeoutMs?: number } = {},
) {
    const scope = getActiveUserScope();
    const recordHistory = options.recordHistory !== false;
    const snapshotTimeoutMs = options.snapshotTimeoutMs ?? DEFAULT_DELETE_SNAPSHOT_TIMEOUT_MS;
    const idleSettleTimeoutMs = options.idleSettleTimeoutMs ?? DEFAULT_DELETE_IDLE_SETTLE_TIMEOUT_MS;
    const selected = [...new Set(ids)];
    for (const id of selected) canvasDeleting.add(saveKey(scope, id));
    try {
        await Promise.all(selected.map((id) => waitForCanvasBackendIdle(id, scope, idleSettleTimeoutMs)));
        const liveById = new Map<string, CanvasProject>();
        for (const id of selected) {
            const current = useCanvasStore.getState().openProject(id);
            if (current) liveById.set(id, current);
        }
        const loadedSnapshots = await Promise.all(
            selected.map((id) => {
                const current = liveById.get(id);
                return current
                    ? loadBestEffortDeleteSnapshot(id, scope, current, recordHistory, snapshotTimeoutMs)
                    : Promise.resolve(undefined);
            }),
        );
        const snapshots = loadedSnapshots.filter((item): item is CanvasProject => Boolean(item));
        const deleted: string[] = [];
        const failures: unknown[] = [];
        for (const id of selected) {
            const snapshot = snapshots.find((item) => item.id === id);
            const current = liveById.get(id);
            const revision = snapshot?.revision ?? current?.revision ?? 0;
            const localOnlyRollback = !recordHistory
                && revision === 0
                && !(peekCanvasOperationJournal(id, scope)?.confirmedRevision);
            let backendConfirmedDeleted = false;
            let backendDeleteWarning: unknown;
            try {
                try {
                    await http.delete(`/canvas-projects/${encodeURIComponent(id)}`);
                    backendConfirmedDeleted = true;
                } catch (error) {
                    if (isNotFoundApiError(error)) {
                        // 后端明确返回 404，视为后端已不存在，无条件清理本地状态。
                        backendConfirmedDeleted = true;
                    } else if (localOnlyRollback) {
                        // 未曾确认落库的 revision=0 回滚草稿，即使后端 DELETE 返回 5xx 也必须清掉本地残留，
                        // 同时保留该后端错误上报给调用方，避免静默吞掉响应丢失导致的潜在远端残留。
                        backendConfirmedDeleted = true;
                        backendDeleteWarning = error;
                    } else {
                        throw error;
                    }
                }
                if (backendConfirmedDeleted) {
                    try {
                        await flushPendingCanvasOverlapWrite(id, scope).catch((cleanupError) => {
                            console.error("画布删除后刷新合并记录失败，继续清理本地条目", { id, error: cleanupError });
                        });
                        await clearCanvasOperationJournal(id, scope).catch((cleanupError) => {
                            console.error("画布删除后清理操作日志失败，继续清理本地条目", { id, error: cleanupError });
                        });
                    } finally {
                        clearCanvasDocumentBase(id, scope);
                        pendingForceHistorySnapshotEpochs.delete(saveKey(scope, id));
                        serverConfirmedCanvasSnapshots.delete(saveKey(scope, id));
                        clearCanvasBackendSaveProgress(id, scope);
                        deleted.push(id);
                    }
                }
                if (backendDeleteWarning !== undefined) {
                    failures.push(backendDeleteWarning);
                }
            } catch (error) {
                console.error("画布后端删除失败", { id, error });
                failures.push(error);
                if (!backendConfirmedDeleted && !useCanvasStore.getState().openProject(id) && (snapshot || current)) {
                    useCanvasStore.getState().restoreProject(snapshot || current!);
                }
            }
        }
        if (deleted.length) {
            useCanvasStore.getState().deleteProjects(deleted);
            if (recordHistory) {
                const removed = snapshots.filter((item) => deleted.includes(item.id) && !item.summaryOnly);
                if (removed.length) useCanvasHistoryStore.getState().recordDeletedProjects(removed);
            }
            await flushCanvasStorePersistence().catch((error) => {
                console.error("画布本地缓存写入失败，已从桌面数据库删除", { ids: deleted, error });
            });
        }
        if (failures.length) throw failures[0];
        return snapshots.filter((item) => deleted.includes(item.id));
    } finally {
        for (const id of selected) canvasDeleting.delete(saveKey(scope, id));
    }
}
