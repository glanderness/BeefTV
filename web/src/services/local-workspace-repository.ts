import { canvasDocumentBase, clearCanvasDocumentBase, flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { ApiError, http } from "@/services/api/request";
import { commitCanvasDocument, patchCanvasDocument } from "@/services/api/operations";
import { buildCanvasDocumentPatch } from "@/lib/canvas/canvas-document-patch";
import { notifyCanvasRefresh } from "@/services/local-workspace-sync";
import { CanvasBackendSubmitPausedError, clearCanvasBackendSaveProgress, isCanvasRevisionConflict, isCanvasSubmitControlError } from "@/services/canvas-revision-conflict";
import { CanvasJournalError, clearCanvasOperationJournal, loadCanvasOperationJournal, newCanvasCommitOperationId, peekCanvasOperationJournal, recordConfirmedCanvasCommit, updateCanvasOperationJournal, type CanvasCommitPayload } from "@/services/canvas-operation-journal";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { getActiveUserScope } from "@/lib/user-scope";
import { normalizeCanvasProjectGraph, sameCanvasDocument } from "@/lib/canvas/canvas-content";
import { revertUnchangedCanvasDocumentPatch, type CanvasDocumentPersistPatch } from "@/lib/canvas/canvas-unconfirmed-edits";
import { settleInFlightGenerationOverlay } from "@/lib/canvas/canvas-document-rebase";
import { traceCanvasGraph } from "@/lib/canvas/canvas-graph-trace";
import {
    hydrateLocalCanvasProjectsFromBackend,
    isNotFoundApiError,
    openLocalCanvasProjectFromBackend,
    readLocalCanvasProjectFromBackend,
    restoreLocalCanvasProjectFromHistory,
} from "./local-workspace-hydration";
import {
    alignLiveAfterConfirmedRemote,
    persistProjectedCanvas,
    reconcileRemoteCanvasUnlocked,
    replayPendingCanvasProjection,
    selectPreferredCanvasProject,
} from "./local-workspace-reconcile";
import {
    applyLiveCanvasProject,
    backendSaveTails,
    backendSaveTimers,
    canvasDeleting,
    CanvasProjectionError,
    canvasProjectionLocks,
    confirmRemoteDocument,
    flushAllPendingCanvasOverlapWrites,
    flushPendingCanvasOverlapWrite,
    getUnconfirmedCanvasDiagnostic,
    hasUnconfirmedCanvasEdits,
    incompleteCanvasProjection,
    markCanvasMergeOverlap,
    openLocalCanvasProject,
    pendingForceHistorySnapshotEpochs,
    pendingOverlapJournalWrites,
    publishCanvasSaveProgress,
    recordServerConfirmedCanvas,
    saveKey,
    serverConfirmedCanvasSnapshots,
    setCanvasProjectionStoreFlushForTest,
    throwIfCanvasNotWritable,
    withCanvasProjection,
    type CanvasSaveSummary,
    type LocalCanvasContent,
} from "./local-workspace-state";

export {
    CanvasBackendSubmitPausedError,
    CanvasProjectionError,
    getUnconfirmedCanvasDiagnostic,
    hasUnconfirmedCanvasEdits,
    hydrateLocalCanvasProjectsFromBackend,
    markCanvasMergeOverlap,
    openLocalCanvasProject,
    openLocalCanvasProjectFromBackend,
    readLocalCanvasProjectFromBackend,
    restoreLocalCanvasProjectFromHistory,
    selectPreferredCanvasProject,
    setCanvasProjectionStoreFlushForTest,
};

/**
 * Local workspace persistence boundary.
 *
 * Desktop ongoing saves commit through the operations registry. IndexedDB is
 * the offline cache, so a stopped backend never prevents opening a project.
 */
export function beginLocalCanvasProject(title: string, projectId?: string, initialContent?: LocalCanvasContent, workspaceProjectId?: string) {
    const id = useCanvasStore.getState().createProject(title, projectId, workspaceProjectId);
    if (initialContent) useCanvasStore.getState().updateProject(id, initialContent);
    // The in-memory project is already usable. Do not make navigation depend
    // on an IndexedDB/localForage flush completing successfully; the store
    // keeps its pending write queue and will retry it on the next flush.
    // Desktop restarts hydrate from the co-packaged Go repository. Creating a
    // project only in IndexedDB leaves the runtime returning 404 and allows its
    // detached-resource cleanup to delete media that the canvas still uses.
    const saved = syncLocalCanvasProject(id);
    // IndexedDB is an offline cache, not the desktop source of truth. A stuck
    // WebKit storage transaction must never block navigation after the Go
    // repository has durably accepted the project.
    void flushCanvasStorePersistence().catch((error) => {
        console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
    });
    return { id, saved };
}

export async function createLocalCanvasProject(title: string, projectId?: string, initialContent?: LocalCanvasContent, workspaceProjectId?: string) {
    const { id, saved } = beginLocalCanvasProject(title, projectId, initialContent, workspaceProjectId);
    await saved;
    return { id };
}

/** Serialize writes per canvas so optimistic revisions cannot race each other. */
function syncLocalCanvasProject(id: string): Promise<void> {
    const scope = getActiveUserScope();
    const key = saveKey(scope, id);
    const existingTimer = backendSaveTimers.get(key);
    if (existingTimer) {
        clearTimeout(existingTimer);
        backendSaveTimers.delete(key);
    }
    const previous = backendSaveTails.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
        if (canvasDeleting.has(key)) throw new CanvasBackendSubmitPausedError("画布正在删除，未提交");
        await commitLiveCanvasDocument(id);
    });
    const tail = next.finally(() => {
        if (backendSaveTails.get(key) === tail) backendSaveTails.delete(key);
    });
    backendSaveTails.set(key, tail);
    publishCanvasSaveProgress(id, scope);
    // 先于调用方的 await 注册：调用方恢复执行时进度已经是这次提交的真实结果。
    void tail.then(() => publishCanvasSaveProgress(id, scope), () => publishCanvasSaveProgress(id, scope, true));
    return tail;
}

async function applyAcceptedCanvasSave(
    id: string,
    submitted: CanvasProject,
    saved: CanvasSaveSummary,
    ackOperationId?: string,
    ackedForceHistorySnapshotEpoch?: number,
) {
    const scope = getActiveUserScope();
    const key = saveKey(scope, id);
    if (ackedForceHistorySnapshotEpoch) {
        await flushPendingCanvasOverlapWrite(id, scope);
    }
    const confirmed = saved.revision != null ? { ...submitted, revision: saved.revision, updatedAt: saved.updatedAt ?? submitted.updatedAt } : submitted;
    const journal = await recordConfirmedCanvasCommit(confirmed, scope, {
        ...(ackOperationId ? { ackOperationId } : {}),
        ...(ackedForceHistorySnapshotEpoch ? { clearForceHistorySnapshotEpoch: ackedForceHistorySnapshotEpoch } : {}),
    });
    recordServerConfirmedCanvas(journal.confirmedSnapshot ?? confirmed, scope);
    if (ackedForceHistorySnapshotEpoch) {
        const currentMemEpoch = pendingForceHistorySnapshotEpochs.get(key) ?? 0;
        const currentJournalEpoch = journal.pendingForceHistorySnapshotEpoch ?? 0;
        if (currentMemEpoch <= ackedForceHistorySnapshotEpoch && currentJournalEpoch <= ackedForceHistorySnapshotEpoch) {
            pendingForceHistorySnapshotEpochs.delete(key);
        }
    }
    useCanvasStore.setState((state) => ({
        projects: state.projects.map((current) => current.id === id
            ? {
                ...current,
                revision: saved.revision == null ? current.revision : Math.max(current.revision ?? 0, saved.revision),
                ...(current.updatedAt === submitted.updatedAt ? { updatedAt: saved.updatedAt } : {}),
            }
            : current),
    }));
    const pending = journal.pendingProjection;
    if (pending) {
        const savedRevision = saved.revision ?? confirmed.revision ?? 0;
        if (pending.revision > savedRevision) return;
        await persistProjectedCanvas(id, scope, pending.identity, { throwOnFailure: true });
        return;
    }
    void flushCanvasStorePersistence().catch((error) => {
        console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
    });
}

const MAX_COMMIT_REBASE_ATTEMPTS = 4;

async function putCanvasProjectToBackend(id: string, endpoint: string, projectForSave: CanvasProject) {
    const response = await http.put<{ project: CanvasSaveSummary }>(
        endpoint,
        { project: projectForSave },
        {},
    );
    if (!response.project || response.project.id !== id) throw new Error("画布保存回执无效，修改仍保留在本地，请重试");
    return response.project;
}

function isInitialCanvasCreate(project: CanvasProject, scope: string) {
    const journal = peekCanvasOperationJournal(project.id, scope);
    if (journal?.confirmedSnapshot || journal?.inFlight) return false;
    return (project.revision ?? 0) === 0;
}

async function commitLiveCanvasDocument(id: string) {
    return withCanvasProjection(getActiveUserScope(), id, () => commitLiveCanvasDocumentUnlocked(id));
}

async function commitLiveCanvasDocumentUnlocked(id: string) {
    const scope = getActiveUserScope();
    await replayPendingCanvasProjection(id, scope, { throwOnFailure: true });
    const journal = await loadCanvasOperationJournal(id, scope);
    let retriesLeft = MAX_COMMIT_REBASE_ATTEMPTS;
    let sent = false;
    if (journal.inFlight) {
        const outcome = await sendCanvasDocumentCommit(id, journal.inFlight.operationId, journal.inFlight.payload, retriesLeft > 0);
        if (outcome === "rebased") retriesLeft -= 1;
        sent = true;
    }
    if (canvasDeleting.has(saveKey(scope, id))) {
        const live = openLocalCanvasProject(id);
        const current = peekCanvasOperationJournal(id, scope);
        if (sent && live && current?.confirmedSnapshot && sameCanvasDocument(current.confirmedSnapshot, live) && !current.inFlight) return;
        throw new CanvasBackendSubmitPausedError("画布正在删除，未提交");
    }
    for (;;) {
        const confirmed = peekCanvasOperationJournal(id, scope)?.confirmedSnapshot ?? null;
        const outcome = await queueAndSendLiveCanvasDocument(id, confirmed, retriesLeft > 0);
        if (outcome !== "rebased") return;
        retriesLeft -= 1;
    }
}

async function queueAndSendLiveCanvasDocument(id: string, confirmed: CanvasProject | null, rebaseAllowed: boolean): Promise<CanvasCommitOutcome | undefined> {
    const scope = getActiveUserScope();
    const project = openLocalCanvasProject(id);
    if (!project) return undefined;
    if (project.summaryOnly) {
        throw new Error("画布尚未完整加载，请先打开画布后再保存");
    }
    const settled = confirmed
        ? settleInFlightGenerationOverlay({ base: confirmed, local: project, remote: confirmed })
        : project;
    if (settled !== project) applyLiveCanvasProject(id, settled, false);
    if (isInitialCanvasCreate(settled, scope)) {
        try {
            const saved = await putCanvasProjectToBackend(id, `/canvas-projects/${encodeURIComponent(id)}`, settled);
            if (!saved) return undefined;
            await applyAcceptedCanvasSave(id, settled, saved);
            return "accepted";
        } catch (error) {
            if (rebaseAllowed && isCanvasRevisionConflict(error) && await rebaseAfterRejectedCanvasCommit(id, 0)) {
                return "rebased";
            }
            throw error;
        }
    }
    await flushPendingCanvasOverlapWrite(id, scope);
    const queued = await updateCanvasOperationJournal(id, scope, (current) => {
        if (current.inFlight) return;
        if (current.confirmedSnapshot && sameCanvasDocument(current.confirmedSnapshot, settled) && !current.inFlight) return;
        const expectedRevision = current.confirmedRevision || settled.revision || 0;
        const forceEpoch = Math.max(
            current.pendingForceHistorySnapshotEpoch ?? 0,
            pendingForceHistorySnapshotEpochs.get(saveKey(scope, id)) ?? 0,
        );
        const patch = current.confirmedSnapshot ? buildCanvasDocumentPatch(current.confirmedSnapshot, settled, { forceHistorySnapshot: forceEpoch > 0 }) : null;
        if (current.confirmedSnapshot && !patch) return;
        const operationId = newCanvasCommitOperationId();
        return {
            ...current,
            ...(forceEpoch > 0 ? { pendingForceHistorySnapshotEpoch: forceEpoch } : {}),
            inFlight: {
                operationId,
                expectedRevision,
                payload: {
                    canvasId: id,
                    expectedRevision,
                    document: structuredClone(settled),
                    ...(patch ? { patch: structuredClone(patch) } : {}),
                    ...(forceEpoch > 0 ? { forceHistorySnapshotEpoch: forceEpoch } : {}),
                },
            },
        };
    });
    if (!queued.inFlight) return undefined;
    throwIfCanvasNotWritable(id, scope);
    return sendCanvasDocumentCommit(id, queued.inFlight.operationId, queued.inFlight.payload, rebaseAllowed);
}

type CanvasCommitOutcome = "accepted" | "rebased";

/**
 * 遇到极少数并发 revision 过时拒绝时读一次服务端最新文档并做确定性合并，
 * 随后带着推进后的 revision 重试。
 */
async function rebaseAfterRejectedCanvasCommit(id: string, rejectedRevision: number) {
    let remote: CanvasProject;
    try {
        remote = await readLocalCanvasProjectFromBackend(id);
    } catch {
        return false;
    }
    if (remote.id !== id || typeof remote.revision !== "number" || remote.revision <= rejectedRevision) return false;
    const outcome = await reconcileRemoteCanvasUnlocked({
        id,
        remote,
        hadLive: true,
        onApplied: notifyCanvasRefresh,
    });
    return outcome.kind === "applied";
}

async function sendCanvasDocumentCommit(
    id: string,
    operationId: string,
    payload: CanvasCommitPayload,
    rebaseAllowed = false,
): Promise<CanvasCommitOutcome> {
    traceCanvasGraph("repository.submit", { document: payload.document, confirmed: canvasDocumentBase(id, getActiveUserScope())?.snapshot });
    const scope = getActiveUserScope();
    try {
        if (payload.patch) {
            const result = await patchCanvasDocument({
                operationId,
                ...payload.patch,
            });
            const revision = result.revision || result.result?.revision;
            const mergedDoc = result.result?.document
                ? normalizeCanvasProjectGraph({
                    ...(result.result.document as unknown as CanvasProject),
                    id,
                    revision: revision ?? payload.document.revision,
                })
                : undefined;
            const acceptedDoc = mergedDoc ?? payload.document;
            const saved: CanvasSaveSummary = {
                id,
                title: result.result?.title ?? acceptedDoc.title,
                createdAt: acceptedDoc.createdAt,
                updatedAt: result.result?.updatedAt ?? acceptedDoc.updatedAt,
                revision,
            };
            const ackedForceEpoch = payload.patch.forceHistorySnapshot
                ? (payload.forceHistorySnapshotEpoch ?? 1)
                : undefined;
            await applyAcceptedCanvasSave(id, acceptedDoc, saved, operationId, ackedForceEpoch);
            if (mergedDoc) {
                const liveNow = openLocalCanvasProject(id);
                const aligned = alignLiveAfterConfirmedRemote({
                    id,
                    scope,
                    remote: mergedDoc,
                    base: payload.document,
                    hadLive: Boolean(liveNow),
                    onApplied: notifyCanvasRefresh,
                });
                await flushPendingCanvasOverlapWrite(id, scope);
                if (aligned && liveNow && !sameCanvasDocument(aligned, mergedDoc)) {
                    scheduleLocalCanvasBackendSync(id);
                }
            }
            return "accepted";
        }
        const result = await commitCanvasDocument({
            operationId,
            canvasId: payload.canvasId,
            expectedRevision: payload.expectedRevision,
            document: payload.document as unknown as Record<string, unknown>,
        });
        const saved: CanvasSaveSummary = {
            id,
            title: result.result?.title ?? payload.document.title,
            createdAt: payload.document.createdAt,
            updatedAt: result.result?.updatedAt ?? payload.document.updatedAt,
            revision: result.revision || result.result?.revision,
        };
        await applyAcceptedCanvasSave(id, payload.document, saved, operationId);
        return "accepted";
    } catch (error) {
        if (isCanvasRevisionConflict(error)) {
            await updateCanvasOperationJournal(id, scope, (current) => {
                if (!current.inFlight) return;
                return { ...current, inFlight: null };
            });
            if (rebaseAllowed && await rebaseAfterRejectedCanvasCommit(id, payload.expectedRevision)) return "rebased";
            throw error;
        }
        if (!shouldKeepCanvasCommitIdentity(error)) {
            await updateCanvasOperationJournal(id, scope, (current) => {
                if (!current.inFlight) return;
                return { ...current, inFlight: null };
            });
        }
        throw error;
    }
}

function shouldKeepCanvasCommitIdentity(error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") return true;
    if (!(error instanceof ApiError)) return true;
    if (error.retryable) return true;
    return error.status === undefined && error.code === undefined;
}

export function syncLocalCanvasProjectToBackend(id: string): Promise<void> {
    return syncLocalCanvasProject(id);
}

/**
 * Persist a canvas document patch before the caller reports success.
 * Local desktop hydrates from SQLite, so ongoing saves commit through the
 * operations registry without waiting on IndexedDB. Hosted keeps update plus an awaited flush.
 * Network-unknown keeps the live patch and the same operationId. Stale revision
 * keeps the local draft. Other failures revert patch fields that nobody else changed.
 */
export async function persistCanvasDocument(id: string, patch: CanvasDocumentPersistPatch) {
    const scope = getActiveUserScope();
    const localMode = isLocalWorkspaceMode();
    const previous = useCanvasStore.getState().openProject(id);
    if (previous?.summaryOnly) {
        throw new Error("画布尚未完整加载，请先打开画布后再保存");
    }
    useCanvasStore.getState().updateProject(id, patch);
    const attempted = useCanvasStore.getState().openProject(id);
    try {
        if (localMode) {
            await syncLocalCanvasProject(id);
            return;
        }
        await flushCanvasStorePersistence();
    } catch (error) {
        if (isCanvasSubmitControlError(error)) throw error;
        if (localMode && (shouldKeepCanvasCommitIdentity(error) || isCanvasRevisionConflict(error))) throw error;
        if (previous) {
            await updateCanvasOperationJournal(id, scope, (current) => {
                if (!current.inFlight) return;
                return { ...current, inFlight: null };
            });
            useCanvasStore.setState((state) => ({
                projects: state.projects.map((item) => {
                    if (item.id !== id) return item;
                    const reverted = revertUnchangedCanvasDocumentPatch(item, previous, patch);
                    if (attempted && item.updatedAt === attempted.updatedAt) reverted.updatedAt = previous.updatedAt;
                    return reverted;
                }),
            }));
        }
        throw error;
    }
}

/** Timeline edits live on the canvas document. */
export async function persistCanvasTimeline(id: string, timeline: NonNullable<CanvasProject["timeline"]>) {
    await persistCanvasDocument(id, { timeline });
}

/**
 * 采纳服务端已确认的生成结果。无基线时不静默并集。有已确认快照时按字段三路合并到
 * 当前 live：本地删除与未冲突编辑保留，未改动的服务端字段（含生成媒体）采纳。
 * 这里只更新 store/journal；编辑器节点由 bind 调用方在 isCurrent 时 setNodes(adopted.nodes)，不 notifyCanvasRefresh。
 */
export async function adoptServerConfirmedGenerationPatch(rawProject: CanvasProject): Promise<CanvasProject | undefined> {
    const project = normalizeCanvasProjectGraph(rawProject), journalScope = getActiveUserScope();
    return withCanvasProjection(journalScope, project.id, async () => {
        const incomingRevision = typeof project.revision === "number" && Number.isInteger(project.revision) && project.revision >= 0
            ? project.revision
            : -1;
        const journal = await loadCanvasOperationJournal(project.id, journalScope);
        if (canvasDeleting.has(saveKey(journalScope, project.id))) return undefined;
        if (incomingRevision < 0 || incomingRevision < journal.confirmedRevision) {
            return openLocalCanvasProject(project.id) ?? undefined;
        }
        if (incomingRevision === journal.confirmedRevision && journal.confirmedSnapshot && sameCanvasDocument(journal.confirmedSnapshot, project)) {
            if (journal.pendingProjection) {
                return replayPendingCanvasProjection(project.id, journalScope, { throwOnFailure: true });
            }
            const live = openLocalCanvasProject(project.id);
            if (!live) return undefined;
            if (live.summaryOnly) {
                applyLiveCanvasProject(project.id, project, false);
                void flushCanvasStorePersistence().catch((error) => {
                    console.error("画布本地缓存写入失败，生成结果已保存到桌面数据库", { id: project.id, error });
                });
                return project;
            }
            // 同一份绑定回执也可能晚于编辑器的 loading/error 状态：
            // 版本没变仍须结算同任务结果，不解除已有冲突或覆盖用户编辑。
            const settled = settleInFlightGenerationOverlay({ base: journal.confirmedSnapshot, local: live, remote: project });
            if (settled !== live) {
                applyLiveCanvasProject(project.id, settled, false);
                void flushCanvasStorePersistence().catch((error) => {
                    console.error("画布本地缓存写入失败，生成结果已保存到桌面数据库", { id: project.id, error });
                });
            }
            return settled;
        }
        const liveAtStart = openLocalCanvasProject(project.id);
        const existed = Boolean(liveAtStart);
        const base = journal.pendingProjection?.base ?? journal.confirmedSnapshot ?? canvasDocumentBase(project.id, journalScope)?.snapshot ?? null;
        let confirmed;
        try {
            confirmed = await confirmRemoteDocument(project, journalScope);
        } catch (error) {
            throw incompleteCanvasProjection(project.id, journalScope, journal.pendingProjection?.identity, error);
        }
        if (canvasDeleting.has(saveKey(journalScope, project.id))) return undefined;
        if (incomingRevision < confirmed.confirmedRevision) {
            return openLocalCanvasProject(project.id) ?? undefined;
        }
        const aligned = alignLiveAfterConfirmedRemote({
            id: project.id,
            scope: journalScope,
            remote: project,
            base,
            hadLive: existed,
            onApplied: notifyCanvasRefresh,
        });
        if (!openLocalCanvasProject(project.id)) return undefined;
        await persistProjectedCanvas(project.id, journalScope, confirmed.pendingProjection?.identity, { throwOnFailure: true });
        return aligned ?? openLocalCanvasProject(project.id) ?? undefined;
    });
}

export function scheduleLocalCanvasBackendSync(id: string) {
    const scope = getActiveUserScope();
    const key = saveKey(scope, id);
    if (canvasDeleting.has(key)) return;
    const existing = backendSaveTimers.get(key);
    if (existing) clearTimeout(existing);
    backendSaveTimers.set(key, setTimeout(() => {
        backendSaveTimers.delete(key);
        if (canvasDeleting.has(key)) {
            publishCanvasSaveProgress(id, scope, true);
            return;
        }
        void syncLocalCanvasProject(id).catch((error) => {
            if (isCanvasSubmitControlError(error)) return;
            console.error("画布后端持久化失败，等待下次编辑重试", { id, error });
        });
    }, 500));
    publishCanvasSaveProgress(id, scope);
}

export function resetLocalCanvasBackendSaveState() {
    for (const timer of backendSaveTimers.values()) clearTimeout(timer);
    backendSaveTimers.clear();
    backendSaveTails.clear();
    canvasProjectionLocks.clear();
    canvasDeleting.clear();
    pendingForceHistorySnapshotEpochs.clear();
    pendingOverlapJournalWrites.clear();
    serverConfirmedCanvasSnapshots.clear();
    setCanvasProjectionStoreFlushForTest(null);
}

/**
 * 外部写入（内置助手回合、CLI/MCP 操作）后把服务端内容投影到本地编辑器。
 *
 * 与 `openLocalCanvasProjectFromBackend` 的区别：这里不假设本地一定服从服务端。
 * 有服务端尚未确认的编辑时，按已确认基线三路合并：改的是不同字段就两边都保留，
 * 并排一次提交把本地改动带着新 revision 写回；同一字段两边都改过才保留本地内容、
 * 把远端留作候选并暂停自动提交。
 *
 * 合并判断在 GET 返回之后、投影锁之内进行：等待网络期间用户仍可能继续编辑，
 * 用请求发出时的判断会漏掉这些新编辑。
 */
export async function refreshLocalCanvasProjectIfChanged(id: string) {
    const scope = getActiveUserScope();
    const existed = Boolean(openLocalCanvasProject(id));
    try {
        try {
            await loadCanvasOperationJournal(id, scope);
            await replayPendingCanvasProjection(id, scope);
        } catch (error) {
            if (!(error instanceof CanvasJournalError)) throw error;
            return undefined;
        }
        const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
        if (!response.project) return undefined;
        const remote = normalizeCanvasProjectGraph(response.project);
        if (existed && !openLocalCanvasProject(id)) return undefined;
        return withCanvasProjection(scope, id, async () => {
            if (existed && !openLocalCanvasProject(id)) return undefined;
            // 读取可能早于本机提交回执：在同一投影锁内对照已确认版本，相同或更旧的快照直接忽略。
            const outcome = await reconcileRemoteCanvasUnlocked({
                id,
                remote,
                hadLive: Boolean(openLocalCanvasProject(id)) || existed,
                onApplied: notifyCanvasRefresh,
            });
            // 合并后仍有本地改动，或在途提交等待重放：排一次提交，不必等用户下一次编辑。
            if (outcome.kind === "deferred" || (outcome.kind === "applied" && outcome.unconfirmed)) scheduleLocalCanvasBackendSync(id);
            return outcome.kind === "applied" ? outcome.project : undefined;
        });
    } catch {
        return undefined;
    }
}

export async function flushLocalWorkspace() {
    await Promise.all([flushCanvasStorePersistence(), flushAllPendingCanvasOverlapWrites()]);
}

export async function flushLocalCanvasBackendSaves(): Promise<void> {
    const scope = getActiveUserScope();
    await flushAllPendingCanvasOverlapWrites(scope);
    const prefix = `${scope}\0`;
    for (const [key, timer] of [...backendSaveTimers.entries()]) {
        if (!key.startsWith(prefix)) continue;
        clearTimeout(timer);
        backendSaveTimers.delete(key);
        const id = key.slice(prefix.length);
        if (canvasDeleting.has(key)) {
            publishCanvasSaveProgress(id, scope, true);
            continue;
        }
        void syncLocalCanvasProject(id).catch(() => undefined);
    }
    const tails = [...backendSaveTails.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, tail]) => tail);
    if (tails.length > 0) {
        const results = await Promise.allSettled(tails);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected" && !isCanvasSubmitControlError(failed.reason)) {
            throw failed.reason;
        }
    }
}

async function waitForCanvasBackendIdle(id: string, scope: string) {
    const key = saveKey(scope, id);
    const timer = backendSaveTimers.get(key);
    if (timer) {
        clearTimeout(timer);
        backendSaveTimers.delete(key);
    }
    const tail = backendSaveTails.get(key);
    if (tail) await tail.catch(() => undefined);
    // 被取消的排队提交不会再发出：删除失败时如实显示为未保存。
    if (timer) publishCanvasSaveProgress(id, scope, true);
}

export async function deleteLocalCanvasProjects(ids: readonly string[], options: { recordHistory?: boolean } = {}) {
    const scope = getActiveUserScope();
    const recordHistory = options.recordHistory !== false;
    const selected = [...new Set(ids)];
    for (const id of selected) canvasDeleting.add(saveKey(scope, id));
    try {
        await Promise.all(selected.map((id) => waitForCanvasBackendIdle(id, scope)));
        const snapshots: CanvasProject[] = [];
        for (const id of selected) {
            const current = useCanvasStore.getState().openProject(id);
            if (!current) continue;
            if (current.summaryOnly && recordHistory) {
                let journalInFlight: CanvasProject | undefined;
                try {
                    const journal = await loadCanvasOperationJournal(id, scope);
                    const candidate = journal.inFlight?.payload?.document;
                    if (candidate && !candidate.summaryOnly) {
                        journalInFlight = normalizeCanvasProjectGraph(candidate);
                    }
                } catch {
                    // 日记读取失败时回退到后端完整读取。
                }
                if (journalInFlight) {
                    snapshots.push(journalInFlight);
                    continue;
                }
                try {
                    snapshots.push(await readLocalCanvasProjectFromBackend(id));
                } catch (error) {
                    if (!isNotFoundApiError(error)) {
                        throw error;
                    }
                }
            } else {
                snapshots.push(current);
            }
        }
        const deleted: string[] = [];
        const failures: unknown[] = [];
        for (const id of selected) {
            const snapshot = snapshots.find((item) => item.id === id);
            const localOnlyRollback = !recordHistory
                && (snapshot?.revision ?? 0) === 0
                && !(peekCanvasOperationJournal(id, scope)?.confirmedRevision);
            let backendDeleteWarning: unknown;
            try {
                try {
                    await http.delete(`/canvas-projects/${encodeURIComponent(id)}`);
                } catch (error) {
                    if (isNotFoundApiError(error) && (!recordHistory || (snapshot?.revision ?? 0) === 0)) {
                        // 回滚或 revision=0 草稿后端明确返回 404，视为后端已不存在。
                    } else if (localOnlyRollback) {
                        // 未曾确认落库的 revision=0 回滚草稿，即使后端 DELETE 返回 5xx 也必须清掉本地残留，
                        // 同时保留该后端错误上报给调用方，避免静默吞掉响应丢失导致的潜在远端残留。
                        backendDeleteWarning = error;
                    } else {
                        throw error;
                    }
                }
                await flushPendingCanvasOverlapWrite(id, scope);
                await clearCanvasOperationJournal(id, scope);
                clearCanvasDocumentBase(id, scope);
                pendingForceHistorySnapshotEpochs.delete(saveKey(scope, id));
                serverConfirmedCanvasSnapshots.delete(saveKey(scope, id));
                clearCanvasBackendSaveProgress(id, scope);
                deleted.push(id);
                if (backendDeleteWarning !== undefined) {
                    failures.push(backendDeleteWarning);
                }
            } catch (error) {
                console.error("画布后端删除失败", { id, error });
                failures.push(error);
                if (!useCanvasStore.getState().openProject(id) && snapshot) {
                    useCanvasStore.getState().restoreProject(snapshot);
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
