import { canvasDocumentBase, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { clearCanvasPendingProjection, loadCanvasOperationJournal, peekCanvasOperationJournal } from "@/services/canvas-operation-journal";
import { getActiveUserScope } from "@/lib/user-scope";
import { normalizeCanvasProjectGraph, sameCanvasDocument } from "@/lib/canvas/canvas-content";
import { rebaseCanvasDocumentThreeWay, settleInFlightGenerationOverlay } from "@/lib/canvas/canvas-document-rebase";
import { traceCanvasGraph } from "@/lib/canvas/canvas-graph-trace";
import {
    applyLiveCanvasProject,
    CanvasProjectionError,
    canvasDeleting,
    confirmRemoteDocument,
    flushPendingCanvasOverlapWrite,
    incompleteCanvasProjection,
    invokeProjectionListener,
    markCanvasMergeOverlap,
    openLocalCanvasProject,
    runProjectionStoreFlush,
    saveKey,
    withCanvasProjection,
} from "./local-workspace-state";

export function alignLiveAfterConfirmedRemote(input: {
    id: string;
    scope: string;
    remote: CanvasProject;
    base: CanvasProject | null;
    hadLive: boolean;
    onApplied?: (project: CanvasProject, previous: CanvasProject | undefined) => void;
}): CanvasProject | undefined {
    if (canvasDeleting.has(saveKey(input.scope, input.id))) return undefined;
    const live = openLocalCanvasProject(input.id);
    if (!live) {
        if (input.hadLive) return undefined;
        applyLiveCanvasProject(input.id, input.remote, true);
        invokeProjectionListener(input.onApplied, input.remote, undefined);
        return input.remote;
    }
    if (live.summaryOnly || sameCanvasDocument(live, input.remote) || (input.base && sameCanvasDocument(live, input.base))) {
        const applied: CanvasProject = {
            ...input.remote,
            viewport: live.summaryOnly ? input.remote.viewport : (live.viewport || input.remote.viewport),
            appearance: live.summaryOnly ? input.remote.appearance : (live.appearance || input.remote.appearance),
            backgroundMode: live.summaryOnly ? input.remote.backgroundMode : (live.backgroundMode || input.remote.backgroundMode),
            showImageInfo: live.summaryOnly ? input.remote.showImageInfo : (live.showImageInfo ?? input.remote.showImageInfo),
        };
        applyLiveCanvasProject(input.id, applied, true);
        invokeProjectionListener(input.onApplied, applied, live);
        return applied;
    }
    const mergeBase: CanvasProject = input.base ?? { ...input.remote, nodes: [], connections: [], chatSessions: [] };
    const settled = settleInFlightGenerationOverlay({ base: mergeBase, local: live, remote: input.remote });
    const rebased = rebaseCanvasDocumentThreeWay({ base: mergeBase, local: settled, remote: input.remote });
    if (rebased.conflict) markCanvasMergeOverlap(input.id, input.scope);
    applyLiveCanvasProject(input.id, rebased.project, false);
    invokeProjectionListener(input.onApplied, rebased.project, live);
    return rebased.project;
}

export async function persistProjectedCanvas(id: string, scope: string, identity: string | undefined, options: { throwOnFailure: boolean }) {
    await flushPendingCanvasOverlapWrite(id, scope);
    if (!identity || !openLocalCanvasProject(id)) return;
    try {
        await runProjectionStoreFlush();
        await clearCanvasPendingProjection(id, scope, identity);
    } catch (error) {
        if (error instanceof CanvasProjectionError) throw error;
        if (!options.throwOnFailure) return;
        throw incompleteCanvasProjection(id, scope, identity, error);
    }
}

export async function replayPendingCanvasProjection(id: string, scope: string, options: { throwOnFailure: boolean } = { throwOnFailure: false }) {
    const journal = peekCanvasOperationJournal(id, scope) ?? await loadCanvasOperationJournal(id, scope);
    const pending = journal.pendingProjection;
    if (!pending) return openLocalCanvasProject(id) ?? undefined;
    if (canvasDeleting.has(saveKey(scope, id))) return undefined;
    const live = openLocalCanvasProject(id);
    if (!live) return undefined;
    alignLiveAfterConfirmedRemote({
        id,
        scope,
        remote: pending.remote,
        base: pending.base,
        hadLive: true,
    });
    await persistProjectedCanvas(id, scope, pending.identity, options);
    return openLocalCanvasProject(id) ?? undefined;
}

/**
 * 桌面本地：已提交真相是服务端 revision；仅当本地 revision 高于已记录基线（或无基线时高于后端且内容不同）才保留本地草稿。
 */
export function selectPreferredCanvasProject(local: CanvasProject | null | undefined, backend: CanvasProject, scope = getActiveUserScope()) {
    if (!local || local.summaryOnly) return backend;
    const recorded = canvasDocumentBase(local.id, scope);
    if (recorded) {
        if ((local.revision ?? 0) <= recorded.revision || sameCanvasDocument(local, recorded.snapshot) || sameCanvasDocument(local, backend)) return backend;
        return local;
    }
    if ((local.revision ?? 0) < (backend.revision ?? 0) || sameCanvasDocument(local, backend)) return backend;
    return local;
}

type RemoteReconcileOutcome =
    | { kind: "stale" | "deferred" | "skipped" }
    | { kind: "applied"; project: CanvasProject | undefined; unconfirmed: boolean };

/**
 * 在投影锁内把一份更新的服务端文档并进本地。调用方必须已持有该画布的投影锁。
 *
 * - 不比已确认版本新：忽略（读取可能早于本机提交回执）。
 * - 日记里有结果未知的在途提交：先不合并，必须用原 operationId 重放拿到真实回执。
 * - 其余情况一律按已确认基线确定性三路合并：不同字段两边都保留，同字段重叠时保留本地并记
 *   merge overlap 标记，由下一次增量 patch 在服务端合并前留存 before_merge 历史快照。
 */
export async function reconcileRemoteCanvasUnlocked(input: {
    id: string;
    remote: CanvasProject;
    hadLive: boolean;
    onApplied?: (project: CanvasProject, previous: CanvasProject | undefined) => void;
}): Promise<RemoteReconcileOutcome> {
    const { id, remote } = input;
    const scope = getActiveUserScope();
    if (canvasDeleting.has(saveKey(scope, id))) return { kind: "skipped" };
    const journal = peekCanvasOperationJournal(id, scope);
    if (journal?.confirmedSnapshot && typeof remote.revision === "number" && remote.revision <= journal.confirmedRevision) return { kind: "stale" };
    if (journal?.inFlight) return { kind: "deferred" };
    const base = journal?.pendingProjection?.base
        ?? journal?.confirmedSnapshot
        ?? canvasDocumentBase(id, scope)?.snapshot
        ?? null;
    let confirmed;
    try {
        confirmed = await confirmRemoteDocument(remote, scope);
    } catch {
        return { kind: "skipped" };
    }
    if ((remote.revision ?? 0) < confirmed.confirmedRevision) return { kind: "stale" };
    if (input.hadLive && !openLocalCanvasProject(id)) return { kind: "skipped" };
    const project = alignLiveAfterConfirmedRemote({
        id,
        scope,
        remote,
        base,
        hadLive: input.hadLive,
        onApplied: input.onApplied,
    });
    await persistProjectedCanvas(id, scope, confirmed.pendingProjection?.identity, { throwOnFailure: false });
    const current = openLocalCanvasProject(id);
    const confirmedSnapshot = confirmed.confirmedSnapshot ?? remote;
    return { kind: "applied", project, unconfirmed: Boolean(current && !sameCanvasDocument(current, confirmedSnapshot)) };
}

export async function applyBackendCanvasRead(
    local: CanvasProject | null | undefined,
    backend: CanvasProject,
    hadLiveAtStart = Boolean(local),
) {
    const scope = getActiveUserScope();
    return withCanvasProjection(scope, backend.id, async () => {
        await replayPendingCanvasProjection(backend.id, scope);
        const liveNow = openLocalCanvasProject(backend.id);
        let currentLocal = liveNow ?? local;
        const hadLive = Boolean(liveNow) || hadLiveAtStart;
        const journal = peekCanvasOperationJournal(backend.id, scope);
        if ((!currentLocal || currentLocal.summaryOnly) && journal?.inFlight?.payload?.document && !journal.inFlight.payload.document.summaryOnly) {
            const recoveredInFlight = normalizeCanvasProjectGraph(journal.inFlight.payload.document);
            applyLiveCanvasProject(backend.id, recoveredInFlight, false);
            currentLocal = recoveredInFlight;
        }
        const chosen = selectPreferredCanvasProject(currentLocal, backend, scope);
        traceCanvasGraph("repository.read.select", { local: currentLocal, backend, base: canvasDocumentBase(backend.id, scope)?.snapshot, chosen });
        if (!currentLocal || currentLocal.summaryOnly || (!journal?.inFlight && (chosen === backend || sameCanvasDocument(chosen, backend)))) {
            const base = journal?.pendingProjection?.base
                ?? journal?.confirmedSnapshot
                ?? canvasDocumentBase(backend.id, scope)?.snapshot
                ?? null;
            let confirmed;
            try {
                confirmed = await confirmRemoteDocument(backend, scope);
            } catch {
                if (!currentLocal || currentLocal.summaryOnly) {
                    applyLiveCanvasProject(backend.id, backend, false);
                    return backend;
                }
                return openLocalCanvasProject(backend.id) ?? currentLocal ?? backend;
            }
            if ((backend.revision ?? 0) < confirmed.confirmedRevision) {
                const live = openLocalCanvasProject(backend.id);
                if (!live || live.summaryOnly) {
                    const fullFallback = confirmed.confirmedSnapshot && !confirmed.confirmedSnapshot.summaryOnly
                        ? confirmed.confirmedSnapshot
                        : backend;
                    applyLiveCanvasProject(backend.id, fullFallback, true);
                    return fullFallback;
                }
                return live;
            }
            const aligned = alignLiveAfterConfirmedRemote({
                id: backend.id,
                scope,
                remote: backend,
                base,
                hadLive,
            });
            await persistProjectedCanvas(backend.id, scope, confirmed.pendingProjection?.identity, { throwOnFailure: false });
            if (hadLive && !openLocalCanvasProject(backend.id)) {
                return openLocalCanvasProject(backend.id) ?? currentLocal ?? backend;
            }
            return aligned ?? openLocalCanvasProject(backend.id) ?? currentLocal ?? backend;
        }
        const recorded = canvasDocumentBase(currentLocal.id, scope);
        const serverMoved = !recorded
            || (backend.revision ?? 0) !== recorded.revision
            || !sameCanvasDocument(backend, recorded.snapshot);
        if (serverMoved) {
            const outcome = await reconcileRemoteCanvasUnlocked({ id: backend.id, remote: backend, hadLive });
            if (outcome.kind === "applied") return outcome.project ?? openLocalCanvasProject(backend.id) ?? currentLocal;
        }
        const unsettled = openLocalCanvasProject(backend.id) ?? currentLocal;
        const settled = settleInFlightGenerationOverlay({
            base: canvasDocumentBase(backend.id, scope)?.snapshot ?? backend,
            local: unsettled,
            remote: backend,
        });
        if (settled !== unsettled) applyLiveCanvasProject(backend.id, settled, false);
        return settled;
    });
}
