import { clearCanvasDocumentBase, flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { ApiError, http } from "@/services/api/request";
import { beginCanvasHydration, finishCanvasHydration } from "./canvas-hydration-health";
import { restoreCanvasHistory } from "@/services/api/workspace-data";
import { CanvasBackendSubmitPausedError, isCanvasRevisionConflict } from "@/services/canvas-revision-conflict";
import { CanvasJournalError, loadCanvasOperationJournal, peekCanvasOperationJournal, updateCanvasOperationJournal } from "@/services/canvas-operation-journal";
import { getActiveUserScope } from "@/lib/user-scope";
import { normalizeCanvasProjectGraph } from "@/lib/canvas/canvas-content";
import { applyBackendCanvasRead, replayPendingCanvasProjection } from "./local-workspace-reconcile";
import {
    applyLiveCanvasProject,
    canvasBackendSubmitPending,
    CanvasProjectionError,
    canvasDeleting,
    hasUnconfirmedCanvasEdits,
    openLocalCanvasProject,
    recordServerConfirmedCanvas,
    runProjectionStoreFlush,
    saveKey,
    serverConfirmedCanvasSnapshots,
    withCanvasProjection,
} from "./local-workspace-state";

function isNotFoundApiError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { name?: unknown; status?: unknown };
    return (error instanceof ApiError || candidate.name === "ApiError") && candidate.status === 404;
}

function isCanvasOpenInEditor(id: string): boolean {
    if (typeof window === "undefined") return false;
    const path = window.location?.pathname || "";
    return path === `/canvas/${encodeURIComponent(id)}` || path === `/canvas/${id}`;
}

/**
 * Authoritative deletion eviction: only called after a per-ID 404 from
 * `GET /canvas-projects/:id`. Never evicts canvases with unconfirmed edits,
 * active/pending journal operations, or (during background hydration) the
 * canvas currently mounted in the editor.
 */
async function evictDeletedCanvasIfClean(id: string, scope: string, options: { allowOpenEditor: boolean }): Promise<boolean> {
    if (canvasDeleting.has(saveKey(scope, id))) return false;
    if (!options.allowOpenEditor && isCanvasOpenInEditor(id)) return false;
    return withCanvasProjection(scope, id, async () => {
        const local = openLocalCanvasProject(id);
        if (!local) return false;
        if (!options.allowOpenEditor && isCanvasOpenInEditor(id)) return false;
        let journal = peekCanvasOperationJournal(id, scope);
        if (!journal) {
            try {
                journal = await loadCanvasOperationJournal(id, scope);
            } catch {
                return false;
            }
        }
        if (
            canvasBackendSubmitPending(id, scope)
            || journal.inFlight
            || journal.pendingProjection
            || hasUnconfirmedCanvasEdits(id)
        ) {
            return false;
        }
        clearCanvasDocumentBase(id, scope);
        serverConfirmedCanvasSnapshots.delete(saveKey(scope, id));
        useCanvasStore.setState((state) => ({
            projects: state.projects.filter((item) => item.id !== id),
        }));
        return true;
    });
}

/**
 * Desktop local canvas documents come from SQLite (`GET /canvas-projects`).
 * IndexedDB persists UI state (selected node, inspector tab, viewport) as an offline
 * fallback so a stopped backend never prevents the UI from opening.
 */
export async function hydrateLocalCanvasProjectsFromBackend() {
    const scope = getActiveUserScope();
    const attempt = beginCanvasHydration();
    const previouslyLoadedIds = new Set(useCanvasStore.getState().projects.map((project) => project.id));
    let failure = "";
    try {
        const summaries: Array<Pick<CanvasProject, "id">> = [];
        let page = 1;
        let hasMore = true;
        while (hasMore) {
            const response = await http.get<{ projects: Array<Pick<CanvasProject, "id">>; hasMore?: boolean }>("/canvas-projects", {
                params: { page, pageSize: 50, sort: "updated" },
            });
            const batch = Array.isArray(response.projects) ? response.projects : [];
            hasMore = response.hasMore === true;
            if (hasMore && batch.length === 0) throw new Error("项目分页未返回内容，请重试");
            summaries.push(...batch);
            page += 1;
        }
        if (summaries.length === 0) return false;
        const backendIds = new Set(summaries.map((summary) => summary.id));
        const projects = (await Promise.all(summaries.map(async (summary) => {
            try {
                const detail = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(summary.id)}`);
                if (!detail.project) throw new Error("项目内容未返回");
                return normalizeCanvasProjectGraph(detail.project);
            } catch (error) {
                if (isNotFoundApiError(error)) {
                    await evictDeletedCanvasIfClean(summary.id, scope, { allowOpenEditor: false });
                    return null;
                }
                throw error;
            }
        }))).filter((project): project is CanvasProject => Boolean(project));
        for (const [index, project] of projects.entries()) {
            // Warm journals can resolve entirely in microtasks. Give React a
            // render turn between batches so large libraries cannot exhaust
            // its nested-update limit while applying individual projections.
            if (index > 0 && index % 16 === 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
            try {
                await loadCanvasOperationJournal(project.id, scope);
                await replayPendingCanvasProjection(project.id, scope);
            } catch (error) {
                if (!(error instanceof CanvasJournalError) && !(error instanceof CanvasProjectionError)) throw error;
            }
            const local = openLocalCanvasProject(project.id);
            if ((!local && previouslyLoadedIds.has(project.id)) || canvasDeleting.has(saveKey(scope, project.id))) continue;
            // Each read reconciles against the live canvas under its projection lock.
            // Replaying those snapshots at the end of the list would discard edits
            // made while later canvases were loading, even at the same revision.
            const applied = await applyBackendCanvasRead(local, project);
            if (!local && !openLocalCanvasProject(project.id) && !canvasDeleting.has(saveKey(scope, project.id))) {
                // A failed journal write can return the readable document without
                // publishing it. Keep the library entry available for first open.
                applyLiveCanvasProject(project.id, applied, true);
            }
        }
        // Never prune solely from a paginated list: verify each missing server-backed
        // candidate via an authoritative per-ID read so pagination shifts keep the
        // canvas and only an explicit 404 evicts a clean cached entry.
        const missingCandidates = useCanvasStore.getState().projects
            .filter((project) => previouslyLoadedIds.has(project.id)
                && (project.revision ?? 0) > 0
                && !backendIds.has(project.id)
                && !canvasDeleting.has(saveKey(scope, project.id))
                && !isCanvasOpenInEditor(project.id)
                && !canvasBackendSubmitPending(project.id, scope))
            .map((project) => project.id);
        for (const candidateId of missingCandidates) {
            if (hasUnconfirmedCanvasEdits(candidateId)) continue;
            try {
                const remote = await readLocalCanvasProjectFromBackend(candidateId);
                const local = openLocalCanvasProject(candidateId);
                if (local && !canvasDeleting.has(saveKey(scope, candidateId))) {
                    await applyBackendCanvasRead(local, remote);
                }
            } catch (error) {
                if (isNotFoundApiError(error)) {
                    await evictDeletedCanvasIfClean(candidateId, scope, { allowOpenEditor: false });
                }
            }
        }
        await flushCanvasStorePersistence();
        return projects.length > 0;
    } catch (error) {
        console.error("项目列表同步失败", error);
        failure = "项目暂时无法读取，现有数据已保留。请重试或在设置中导出问题记录。";
        return false;
    } finally {
        finishCanvasHydration(attempt, failure);
    }
}

/** Read the durable document without adopting it or hiding errors behind local state. */
export async function readLocalCanvasProjectFromBackend(id: string): Promise<CanvasProject> {
    const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
    if (!response.project) throw new Error("画布读取失败，请重试");
    return normalizeCanvasProjectGraph(response.project);
}

export async function openLocalCanvasProjectFromBackend(id: string) {
    const scope = getActiveUserScope();
    const existed = Boolean(openLocalCanvasProject(id));
    try {
        try {
            await loadCanvasOperationJournal(id, scope);
            await replayPendingCanvasProjection(id, scope);
        } catch (error) {
            if (!(error instanceof CanvasJournalError) && !(error instanceof CanvasProjectionError)) throw error;
        }
        const backendProject = await readLocalCanvasProjectFromBackend(id);
        if (!backendProject) return openLocalCanvasProject(id);
        const project = await applyBackendCanvasRead(openLocalCanvasProject(id), backendProject, existed);
        if (existed && !openLocalCanvasProject(id)) return openLocalCanvasProject(id);
        // 读取结果已在投影锁内落到本地，这里只补上缺失的画布，不再整份覆盖：
        // 等待期间编辑器可能已经把新的编辑并进本地文档，整份覆盖会把它们冲掉。
        if (!openLocalCanvasProject(id)) {
            useCanvasStore.setState((state) => state.projects.some((item) => item.id === id) ? state : { projects: [...state.projects, project] });
        }
        await flushCanvasStorePersistence();
        return openLocalCanvasProject(id) ?? project;
    } catch (error) {
        if (isNotFoundApiError(error)) {
            const evicted = await evictDeletedCanvasIfClean(id, scope, { allowOpenEditor: true });
            if (evicted) {
                await flushCanvasStorePersistence();
                return null;
            }
        }
        return openLocalCanvasProject(id);
    }
}

function restoreHistoryRequestError(snapshotId: unknown, revision: unknown) {
    const identity = typeof snapshotId === "string" ? snapshotId.trim() : "";
    if (!identity) throw new Error("历史版本不存在或已过期，请刷新历史列表");
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
        throw new Error("请先刷新画布版本再恢复");
    }
    return { snapshotId: identity, revision };
}

function restoreDidNotApply() {
    return new Error("恢复没有完成，画布内容没有被替换。");
}

/**
 * 用户显式恢复历史版本。走服务端 RestoreCanvasHistory CAS；失败必须抛出，
 * 不能退回 openLocalCanvasProjectFromBackend（它会吞错并打开当前稿）。
 */
export async function restoreLocalCanvasProjectFromHistory(
    id: string,
    historyRestore: { snapshotId: string; revision: number },
): Promise<CanvasProject> {
    const canvasId = id.trim();
    if (!canvasId) throw new Error("画布不存在或无权访问");
    const { snapshotId, revision } = restoreHistoryRequestError(historyRestore.snapshotId, historyRestore.revision);
    return withCanvasProjection(getActiveUserScope(), canvasId, () => restoreLocalCanvasProjectFromHistoryUnlocked(canvasId, snapshotId, revision));
}

async function restoreLocalCanvasProjectFromHistoryUnlocked(
    id: string,
    snapshotId: string,
    revision: number,
): Promise<CanvasProject> {
    const scope = getActiveUserScope();
    if (canvasDeleting.has(saveKey(scope, id))) {
        throw new CanvasBackendSubmitPausedError("画布正在删除，未提交");
    }
    let receipt;
    try {
        const response = await restoreCanvasHistory(id, snapshotId, revision);
        receipt = response?.project;
    } catch (error) {
        if (isCanvasRevisionConflict(error)) {
            throw new Error("当前画布已有更新，这次没有恢复。请重新打开版本记录后再试。");
        }
        throw error;
    }
    if (!receipt || receipt.id !== id) throw restoreDidNotApply();
    const restoredRevision = receipt.revision;
    if (typeof restoredRevision !== "number" || !Number.isInteger(restoredRevision) || restoredRevision <= revision) {
        throw restoreDidNotApply();
    }
    const backendProject = await readLocalCanvasProjectFromBackend(id);
    if (backendProject.id !== id || (backendProject.revision ?? 0) !== restoredRevision) {
        throw new Error("恢复后没有读到新版本，请重试。");
    }
    await updateCanvasOperationJournal(id, scope, (current) => ({
        ...current,
        confirmedRevision: restoredRevision,
        confirmedSnapshot: structuredClone(backendProject),
        inFlight: null,
        pendingProjection: null,
    }));
    recordServerConfirmedCanvas(backendProject, scope);
    applyLiveCanvasProject(id, backendProject, true);
    await runProjectionStoreFlush();
    const live = openLocalCanvasProject(id);
    if (!live || (live.revision ?? 0) !== restoredRevision) throw restoreDidNotApply();
    return live;
}
