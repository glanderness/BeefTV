import { acceptCanvasExternalRevisionCandidate, applyExternalCanvasRevision, canvasDocumentBase, canvasDurableSnapshot, canvasExternalRevisionConflict, clearCanvasDocumentBase, clearCanvasExternalRevisionConflict, flushCanvasStorePersistence, recordCanvasDocumentBase, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { ApiError, http } from "@/services/api/request";
import { commitCanvasDocument } from "@/services/api/operations";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { notifyCanvasRefresh } from "@/services/local-workspace-sync";
import { canvasBackendSubmitPaused, CanvasBackendSubmitPausedError, CanvasStaleScopeError, handleRejectedCanvasBackendSave, isCanvasRevisionConflict, isCanvasSubmitControlError, pauseCanvasBackendSubmit, resumeCanvasBackendSubmit } from "@/services/canvas-revision-conflict";
import { CanvasJournalError, clearCanvasOperationJournal, loadCanvasOperationJournal, newCanvasCommitOperationId, peekCanvasOperationJournal, recordConfirmedCanvasCommit, updateCanvasOperationJournal } from "@/services/canvas-operation-journal";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { getActiveUserScope } from "@/lib/user-scope";
import { sameCanvasDocument } from "@/lib/canvas/canvas-content";
import { rebaseCanvasDocumentThreeWay } from "@/lib/canvas/canvas-document-rebase";

export { CanvasBackendSubmitPausedError, CanvasStaleScopeError } from "@/services/canvas-revision-conflict";

type LocalCanvasContent = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">>;
type CanvasSaveSummary = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt" | "revision">;
type CanvasDocumentPersistPatch = Partial<Pick<CanvasProject, "nodes" | "connections" | "timeline" | "chatSessions" | "activeChatId" | "appearance" | "backgroundMode" | "showImageInfo" | "title" | "folderId" | "directorScenes">>;

const backendSaveTails = new Map<string, Promise<void>>();
const backendSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const canvasDeleting = new Set<string>();
/**
 * 每画布最后一次被服务端确认的文档快照：成功提交的入参，或从服务端读回并被
 * 采纳的内容。它是判断「本地是否有服务端尚未确认的编辑」的唯一权威基线——
 * 浏览器存储队列只说明有没有写进 IndexedDB，不代表服务端已经收到。
 */
const serverConfirmedCanvasSnapshots = new Map<string, CanvasProject>();

function saveKey(scope: string, id: string) {
    return `${scope}\0${id}`;
}

function isCurrentDispatchScope(scope: string) {
    return getActiveUserScope() === scope;
}

function recordServerConfirmedCanvas(project: CanvasProject | undefined, scope: string) {
    if (!project) return;
    const current = canvasDocumentBase(project.id, scope);
    if (current && (project.revision ?? 0) < current.revision) return;
    serverConfirmedCanvasSnapshots.set(saveKey(scope, project.id), project);
    recordCanvasDocumentBase(project, scope);
}

async function confirmRemoteDocument(project: CanvasProject, scope: string) {
    const journal = await recordConfirmedCanvasCommit(project, scope);
    recordServerConfirmedCanvas(journal.confirmedSnapshot ?? project, scope);
    return journal;
}

/** HTTP 层是否还有该画布未落地的提交（已排队或正在发送）。 */
function canvasBackendSubmitPending(id: string, scope: string) {
    const key = saveKey(scope, id);
    return backendSaveTails.has(key) || backendSaveTimers.has(key);
}

function canvasSubmitBlocked(id: string, scope: string) {
    return canvasBackendSubmitPaused(id, scope) || Boolean(canvasExternalRevisionConflict(scope, id));
}

function throwIfCanvasNotWritable(id: string, scope: string) {
    if (canvasDeleting.has(saveKey(scope, id))) {
        throw new CanvasBackendSubmitPausedError("画布正在删除，未提交");
    }
    if (canvasSubmitBlocked(id, scope)) {
        throw new CanvasBackendSubmitPausedError();
    }
    if (!isCurrentDispatchScope(scope)) {
        throw new CanvasStaleScopeError();
    }
}

/**
 * 本地是否有服务端尚未确认的编辑。
 *
 * 依次检查三个真实状态的证据，任何一项不成立都按「有未确认编辑」处理，
 * 因为这里判错的代价是覆盖用户正在编辑的内容：
 * 1. HTTP 待提交/正在提交，或上一次提交被拒；
 * 2. 与服务端确认快照的文档内容不同；
 * 3. 没有服务端确认基线时，退回本机已落盘快照；两者都没有则保守判为有编辑。
 */
export function hasUnconfirmedCanvasEdits(id: string) {
    const scope = getActiveUserScope();
    const live = openLocalCanvasProject(id);
    if (!live) return false;
    if (canvasBackendSubmitPending(id, scope) || canvasSubmitBlocked(id, scope)) return true;
    if (peekCanvasOperationJournal(id, scope)?.inFlight) return true;
    const confirmed = canvasDocumentBase(id, scope)?.snapshot ?? serverConfirmedCanvasSnapshots.get(saveKey(scope, id));
    if (confirmed) return !sameCanvasDocument(confirmed, live);
    const durable = canvasDurableSnapshot(scope, id);
    if (durable) return !sameCanvasDocument(durable, live);
    return true;
}

function resourceIdFromLocator(value?: string) {
    const storageID = resourceIdFromStorageKey(value);
    if (storageID) return storageID;
    return value?.match(/\/api\/resources\/([^/?#]+)\/file(?:[?#]|$)/)?.[1] || "";
}

function assetResourceId(asset: Asset) {
    if (!("storageKey" in asset.data)) return "";
    return resourceIdFromLocator(asset.data.storageKey);
}

export function canvasGenerationCommitAssets(project: CanvasProject, assets: Asset[]) {
    const resourceIDs = new Set<string>();
    for (const node of project.nodes) {
        if (node.type !== "image" && node.type !== "video" && node.type !== "audio") continue;
        const resourceID = resourceIdFromLocator(node.metadata?.storageKey) || resourceIdFromLocator(node.metadata?.content);
        if (resourceID) resourceIDs.add(resourceID);
    }
    return assets.filter((asset) => resourceIDs.has(assetResourceId(asset)));
}

export function bindCanvasGenerationCommitAssets(project: CanvasProject, assets: Asset[]): CanvasProject {
    const assetByResource = new Map<string, string>();
    for (const asset of assets) {
        const resourceID = assetResourceId(asset);
        if (resourceID) assetByResource.set(resourceID, asset.id);
    }
    return {
        ...project,
        nodes: project.nodes.map((node) => {
            if (node.type !== "image" && node.type !== "video" && node.type !== "audio") return node;
            const resourceID = resourceIdFromLocator(node.metadata?.storageKey) || resourceIdFromLocator(node.metadata?.content);
            const assetId = assetByResource.get(resourceID);
            return assetId ? { ...node, metadata: { ...node.metadata, assetId } } : node;
        }),
    };
}

function applyLiveCanvasProject(id: string, project: CanvasProject, allowInsert: boolean) {
    useCanvasStore.setState((state) => {
        const exists = state.projects.some((item) => item.id === id);
        if (!exists && !allowInsert) return state;
        return {
            projects: exists
                ? state.projects.map((item) => item.id === id ? project : item)
                : [...state.projects, project],
        };
    });
}

function alignLiveAfterConfirmedRemote(input: {
    id: string;
    scope: string;
    remote: CanvasProject;
    base: CanvasProject | null;
    hadLive: boolean;
    onApplied?: (project: CanvasProject, previous: CanvasProject | undefined) => void;
}): CanvasProject | undefined {
    if (!isCurrentDispatchScope(input.scope)) return input.remote;
    if (canvasDeleting.has(saveKey(input.scope, input.id))) return undefined;
    const live = openLocalCanvasProject(input.id);
    if (!live) {
        if (input.hadLive) return undefined;
        applyLiveCanvasProject(input.id, input.remote, true);
        input.onApplied?.(input.remote, undefined);
        return input.remote;
    }
    if (sameCanvasDocument(live, input.remote) || (input.base && sameCanvasDocument(live, input.base))) {
        const decision = applyExternalCanvasRevision(input.remote, {
            scope: input.scope,
            hasUnsyncedEdits: false,
            onApplied: input.onApplied,
        });
        return decision.kind === "apply" ? decision.project : live;
    }
    if (!input.base) {
        pauseForExternalCandidate(input.id, input.remote, input.scope);
        return live;
    }
    const rebased = rebaseCanvasDocumentThreeWay({ base: input.base, local: live, remote: input.remote });
    applyLiveCanvasProject(input.id, rebased.project, false);
    input.onApplied?.(rebased.project, live);
    if (rebased.conflict) pauseForExternalCandidate(input.id, input.remote, input.scope);
    return rebased.project;
}

/**
 * 桌面本地：已提交真相是服务端 revision。干净缓存采用后端；未确认草稿相对已记录基线保留。
 */
export function selectPreferredCanvasProject(local: CanvasProject | null | undefined, backend: CanvasProject, scope = getActiveUserScope()) {
    if (!local) return backend;
    const recorded = canvasDocumentBase(local.id, scope);
    if (recorded) {
        if (sameCanvasDocument(local, recorded.snapshot) || sameCanvasDocument(local, backend)) return backend;
        return local;
    }
    if (sameCanvasDocument(local, backend)) return backend;
    return local;
}

function pauseForExternalCandidate(id: string, remote: CanvasProject, scope: string) {
    applyExternalCanvasRevision(remote, { hasUnsyncedEdits: true, scope });
    pauseCanvasBackendSubmit(id, scope);
}

async function applyBackendCanvasRead(
    local: CanvasProject | null | undefined,
    backend: CanvasProject,
    scope: string,
    hadLiveAtStart = Boolean(local),
) {
    const liveNow = isCurrentDispatchScope(scope) ? openLocalCanvasProject(backend.id) : undefined;
    const currentLocal = liveNow ?? local;
    const hadLive = Boolean(liveNow) || hadLiveAtStart;
    const chosen = selectPreferredCanvasProject(currentLocal, backend, scope);
    if (!currentLocal || chosen === backend || sameCanvasDocument(chosen, backend)) {
        const base = peekCanvasOperationJournal(backend.id, scope)?.confirmedSnapshot
            ?? canvasDocumentBase(backend.id, scope)?.snapshot
            ?? null;
        let confirmed;
        try {
            confirmed = await confirmRemoteDocument(backend, scope);
        } catch {
            return openLocalCanvasProject(backend.id) ?? currentLocal ?? backend;
        }
        if ((backend.revision ?? 0) < confirmed.confirmedRevision) {
            return openLocalCanvasProject(backend.id) ?? currentLocal ?? backend;
        }
        const aligned = alignLiveAfterConfirmedRemote({
            id: backend.id,
            scope,
            remote: backend,
            base,
            hadLive,
        });
        if (hadLive && !openLocalCanvasProject(backend.id)) {
            return openLocalCanvasProject(backend.id) ?? currentLocal ?? backend;
        }
        return aligned ?? openLocalCanvasProject(backend.id) ?? currentLocal ?? backend;
    }
    const recorded = canvasDocumentBase(currentLocal.id, scope);
    const serverMoved = !recorded
        || (backend.revision ?? 0) !== recorded.revision
        || !sameCanvasDocument(backend, recorded.snapshot);
    if (serverMoved) pauseForExternalCandidate(currentLocal.id, backend, scope);
    return currentLocal;
}

/**
 * Local workspace persistence boundary.
 *
 * Desktop ongoing saves commit through the operations registry. IndexedDB is
 * the offline cache, so a stopped backend never prevents opening a project.
 */
export async function createLocalCanvasProject(title: string, projectId?: string, initialContent?: LocalCanvasContent, workspaceProjectId?: string) {
    const scope = getActiveUserScope();
    const id = useCanvasStore.getState().createProject(title, projectId, workspaceProjectId);
    if (initialContent) useCanvasStore.getState().updateProject(id, initialContent);
    // The in-memory project is already usable. Do not make navigation depend
    // on an IndexedDB/localForage flush completing successfully; the store
    // keeps its pending write queue and will retry it on the next flush.
    // Desktop restarts hydrate from the co-packaged Go repository. Creating a
    // project only in IndexedDB leaves the runtime returning 404 and allows its
    // detached-resource cleanup to delete media that the canvas still uses.
    await syncLocalCanvasProject(id, false, scope);
    // IndexedDB is an offline cache, not the desktop source of truth. A stuck
    // WebKit storage transaction must never block navigation after the Go
    // repository has durably accepted the project.
    void flushCanvasStorePersistence().catch((error) => {
        console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
    });
    return { id };
}

/** Serialize writes per canvas so optimistic revisions cannot race each other. */
function syncLocalCanvasProject(id: string, includeGeneratedAssets: boolean, scope: string): Promise<void> {
    const key = saveKey(scope, id);
    const previous = backendSaveTails.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
        if (canvasDeleting.has(key)) throw new CanvasBackendSubmitPausedError("画布正在删除，未提交");
        if (!isCurrentDispatchScope(scope)) throw new CanvasStaleScopeError();
        if (includeGeneratedAssets) {
            await submitGeneratedAssetsToBackend(id, scope);
            return;
        }
        await commitLiveCanvasDocument(id, scope);
    });
    const tail = next.finally(() => {
        if (backendSaveTails.get(key) === tail) backendSaveTails.delete(key);
    });
    backendSaveTails.set(key, tail);
    return tail;
}

async function applyAcceptedCanvasSave(id: string, submitted: CanvasProject, saved: CanvasSaveSummary, bindAssets: Asset[] | undefined, scope: string, ackOperationId?: string) {
    const confirmed = saved.revision != null ? { ...submitted, revision: saved.revision, updatedAt: saved.updatedAt ?? submitted.updatedAt } : submitted;
    const pendingExternal = canvasExternalRevisionConflict(scope, id);
    const journal = await recordConfirmedCanvasCommit(confirmed, scope, ackOperationId ? { ackOperationId } : {});
    recordServerConfirmedCanvas(journal.confirmedSnapshot ?? confirmed, scope);
    if (!isCurrentDispatchScope(scope)) return;
    useCanvasStore.setState((state) => ({
        projects: state.projects.map((current) => current.id === id
            ? {
                ...(bindAssets ? bindCanvasGenerationCommitAssets(current, bindAssets) : current),
                revision: saved.revision == null ? current.revision : Math.max(current.revision ?? 0, saved.revision),
                ...(current.updatedAt === submitted.updatedAt ? { updatedAt: saved.updatedAt } : {}),
            }
            : current),
    }));
    if (!pendingExternal && !canvasExternalRevisionConflict(scope, id)) {
        resumeCanvasBackendSubmit(id, scope);
    }
    void flushCanvasStorePersistence().catch((error) => {
        console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
    });
}

async function submitGeneratedAssetsToBackend(id: string, scope: string) {
    await commitLiveCanvasDocument(id, scope);
    throwIfCanvasNotWritable(id, scope);
    const project = openLocalCanvasProject(id);
    if (!project) return;
    const assets = canvasGenerationCommitAssets(project, useAssetStore.getState().assets);
    const projectForSave = bindCanvasGenerationCommitAssets(project, assets);
    const saved = await putCanvasProjectToBackend(id, project, `/canvas-projects/${encodeURIComponent(id)}/generated-assets`, projectForSave, assets, true, scope);
    if (!saved) return;
    await applyAcceptedCanvasSave(id, projectForSave, saved, assets, scope);
}

async function putCanvasProjectToBackend(id: string, project: CanvasProject, endpoint: string, projectForSave: CanvasProject, assets: Asset[], includeGeneratedAssets: boolean, scope: string) {
    if (!isCurrentDispatchScope(scope)) throw new CanvasStaleScopeError();
    try {
        const response = await http.put<{ project: CanvasSaveSummary }>(endpoint, includeGeneratedAssets ? { project: projectForSave, assets } : { project: projectForSave });
        return response.project;
    } catch (error) {
        const conflict = await handleRejectedCanvasBackendSave(id, project, error, scope);
        if (includeGeneratedAssets && conflict) {
            throw Object.assign(new Error("生成结果已保留，但画布有版本冲突。请先使用画布最新版本，再重新加载资源，不要重新生成。"), { code: "canvas_conflict" });
        }
        throw error;
    }
}

function isInitialCanvasCreate(project: CanvasProject, scope: string) {
    const journal = peekCanvasOperationJournal(project.id, scope);
    if (journal?.confirmedSnapshot || journal?.inFlight) return false;
    return (project.revision ?? 0) === 0;
}

async function commitLiveCanvasDocument(id: string, scope: string) {
    const journal = await loadCanvasOperationJournal(id, scope);
    let sent = false;
    if (journal.inFlight) {
        await sendCanvasDocumentCommit(id, journal.inFlight.operationId, journal.inFlight.payload, scope);
        sent = true;
    }
    if (!isCurrentDispatchScope(scope)) {
        if (sent) return;
        throw new CanvasStaleScopeError();
    }
    if (canvasDeleting.has(saveKey(scope, id)) || canvasSubmitBlocked(id, scope)) {
        const live = openLocalCanvasProject(id);
        const current = peekCanvasOperationJournal(id, scope);
        if (sent && live && current?.confirmedSnapshot && sameCanvasDocument(current.confirmedSnapshot, live) && !current.inFlight) return;
        throw new CanvasBackendSubmitPausedError(canvasDeleting.has(saveKey(scope, id)) ? "画布正在删除，未提交" : "画布有未处理的外部改动，本次未提交");
    }
    const project = openLocalCanvasProject(id);
    if (!project) return;
    if (isInitialCanvasCreate(project, scope)) {
        const saved = await putCanvasProjectToBackend(id, project, `/canvas-projects/${encodeURIComponent(id)}`, project, [], false, scope);
        if (!saved) return;
        await applyAcceptedCanvasSave(id, project, saved, undefined, scope);
        return;
    }
    const queued = await updateCanvasOperationJournal(id, scope, (current) => {
        if (current.inFlight) return;
        if (current.confirmedSnapshot && sameCanvasDocument(current.confirmedSnapshot, project) && !current.inFlight) return;
        const expectedRevision = current.confirmedRevision || project.revision || 0;
        const operationId = newCanvasCommitOperationId();
        return {
            ...current,
            inFlight: {
                operationId,
                expectedRevision,
                payload: {
                    canvasId: id,
                    expectedRevision,
                    document: structuredClone(project),
                },
            },
        };
    });
    if (!queued.inFlight) return;
    throwIfCanvasNotWritable(id, scope);
    await sendCanvasDocumentCommit(id, queued.inFlight.operationId, queued.inFlight.payload, scope);
}

async function sendCanvasDocumentCommit(id: string, operationId: string, payload: { canvasId: string; expectedRevision: number; document: CanvasProject }, scope: string) {
    if (!isCurrentDispatchScope(scope)) throw new CanvasStaleScopeError();
    try {
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
        await applyAcceptedCanvasSave(id, payload.document, saved, undefined, scope, operationId);
    } catch (error) {
        if (error instanceof CanvasStaleScopeError) throw error;
        if (isCanvasRevisionConflict(error)) {
            await updateCanvasOperationJournal(id, scope, (current) => {
                if (!current.inFlight) return;
                return { ...current, inFlight: null };
            });
            await handleRejectedCanvasBackendSave(id, payload.document, error, scope);
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
    return syncLocalCanvasProject(id, false, getActiveUserScope());
}

function sameDocumentValue(left: unknown, right: unknown) {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function revertUnchangedCanvasNodes(
    previous: CanvasProject["nodes"],
    attempted: CanvasProject["nodes"],
    live: CanvasProject["nodes"],
): CanvasProject["nodes"] {
    if (sameDocumentValue(live, attempted)) return previous;
    const previousById = new Map(previous.map((node) => [node.id, node]));
    const attemptedById = new Map(attempted.map((node) => [node.id, node]));
    const reverted: CanvasProject["nodes"] = [];
    for (const node of live) {
        const before = previousById.get(node.id);
        const optimistic = attemptedById.get(node.id);
        if (!before && optimistic) {
            if (sameDocumentValue(node, optimistic)) continue;
            reverted.push(node);
            continue;
        }
        if (before && optimistic) {
            reverted.push(sameDocumentValue(node, optimistic) ? before : node);
            continue;
        }
        reverted.push(node);
    }
    return reverted;
}

function revertUnchangedCanvasDocumentPatch(current: CanvasProject, previous: CanvasProject, patch: CanvasDocumentPersistPatch): CanvasProject {
    const next: CanvasProject = { ...current };
    (Object.keys(patch) as Array<keyof CanvasDocumentPersistPatch>).forEach((key) => {
        if (key === "nodes") {
            if (!patch.nodes) return;
            next.nodes = revertUnchangedCanvasNodes(previous.nodes, patch.nodes, current.nodes);
            return;
        }
        const attempted = patch[key];
        if (attempted === undefined) return;
        if (sameDocumentValue(current[key], attempted)) {
            (next as Record<string, unknown>)[key] = previous[key];
        }
    });
    return next;
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
    useCanvasStore.getState().updateProject(id, patch);
    const attempted = useCanvasStore.getState().openProject(id);
    try {
        if (localMode) {
            await syncLocalCanvasProject(id, false, scope);
            return;
        }
        await flushCanvasStorePersistence();
    } catch (error) {
        if (isCanvasSubmitControlError(error)) throw error;
        if (localMode && (shouldKeepCanvasCommitIdentity(error) || isCanvasRevisionConflict(error))) throw error;
        if (previous && isCurrentDispatchScope(scope)) {
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

export function syncLocalCanvasGenerationProjectToBackend(id: string): Promise<void> {
    return syncLocalCanvasProject(id, true, getActiveUserScope());
}

/**
 * 采纳服务端已确认的生成结果。无基线时不静默并集。有已确认快照时按字段三路合并到
 * 当前 live：本地删除与未冲突编辑保留，未改动的服务端字段（含生成媒体）采纳。
 */
export async function adoptServerConfirmedGenerationPatch(project: CanvasProject, scope = getActiveUserScope()): Promise<CanvasProject> {
    const incomingRevision = typeof project.revision === "number" && Number.isInteger(project.revision) && project.revision >= 0
        ? project.revision
        : -1;
    const journal = await loadCanvasOperationJournal(project.id, scope);
    const liveAtStart = isCurrentDispatchScope(scope) ? openLocalCanvasProject(project.id) : undefined;
    const existed = Boolean(liveAtStart);
    if (incomingRevision < 0 || incomingRevision < journal.confirmedRevision) {
        return liveAtStart ?? journal.confirmedSnapshot ?? project;
    }
    if (incomingRevision === journal.confirmedRevision && journal.confirmedSnapshot && sameCanvasDocument(journal.confirmedSnapshot, project)) {
        return liveAtStart ?? project;
    }
    const base = journal.confirmedSnapshot ?? canvasDocumentBase(project.id, scope)?.snapshot ?? null;
    const dirty = Boolean(liveAtStart && (!base || !sameCanvasDocument(base, liveAtStart)));
    if (dirty && !base) {
        pauseForExternalCandidate(project.id, project, scope);
        return liveAtStart ?? project;
    }
    if (canvasDeleting.has(saveKey(scope, project.id))) {
        return liveAtStart ?? project;
    }
    let confirmed;
    try {
        confirmed = await confirmRemoteDocument(project, scope);
    } catch {
        return openLocalCanvasProject(project.id) ?? liveAtStart ?? journal.confirmedSnapshot ?? project;
    }
    if (incomingRevision < confirmed.confirmedRevision) {
        return openLocalCanvasProject(project.id) ?? liveAtStart ?? project;
    }
    const aligned = alignLiveAfterConfirmedRemote({
        id: project.id,
        scope,
        remote: project,
        base,
        hadLive: existed,
    });
    if (isCurrentDispatchScope(scope) && aligned && openLocalCanvasProject(project.id)) {
        void flushCanvasStorePersistence().catch((error) => {
            console.error("画布本地缓存写入失败，已保存到桌面数据库", { id: project.id, error });
        });
    }
    if (existed && !openLocalCanvasProject(project.id)) {
        return openLocalCanvasProject(project.id) ?? liveAtStart ?? project;
    }
    return aligned ?? liveAtStart ?? project;
}

export function scheduleLocalCanvasBackendSync(id: string) {
    const scope = getActiveUserScope();
    const key = saveKey(scope, id);
    if (canvasDeleting.has(key)) return;
    const existing = backendSaveTimers.get(key);
    if (existing) clearTimeout(existing);
    backendSaveTimers.set(key, setTimeout(() => {
        backendSaveTimers.delete(key);
        if (canvasDeleting.has(key) || !isCurrentDispatchScope(scope)) return;
        void syncLocalCanvasProject(id, false, scope).catch((error) => {
            if (isCanvasSubmitControlError(error)) return;
            console.error("画布后端持久化失败，等待下次编辑重试", { id, error });
        });
    }, 500));
}

export function resetLocalCanvasBackendSaveState() {
    for (const timer of backendSaveTimers.values()) clearTimeout(timer);
    backendSaveTimers.clear();
    backendSaveTails.clear();
    canvasDeleting.clear();
    serverConfirmedCanvasSnapshots.clear();
}

export function openLocalCanvasProject(id: string) {
    return useCanvasStore.getState().openProject(id);
}

/**
 * Best-effort bridge for the browser preview. The Go local runtime is the
 * canonical store when it is available; IndexedDB remains the offline
 * fallback so a stopped backend never prevents the UI from opening.
 */
export async function hydrateLocalCanvasProjectsFromBackend() {
    const scope = getActiveUserScope();
    try {
        const response = await http.get<{ projects: Array<Pick<CanvasProject, "id">> }>("/canvas-projects", {
            params: { page: 1, pageSize: 500, sort: "updated" },
        });
        const summaries = Array.isArray(response.projects) ? response.projects : [];
        if (summaries.length === 0) return false;
        const projects = (await Promise.all(summaries.map(async (summary) => {
            try {
                const detail = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(summary.id)}`);
                return detail.project;
            } catch {
                return undefined;
            }
        }))).filter((project): project is CanvasProject => Boolean(project));
        if (projects.length === 0) return false;
        if (!isCurrentDispatchScope(scope)) return false;
        const current = useCanvasStore.getState().projects;
        const byId = new Map(current.map((project) => [project.id, project]));
        const existedIds = new Set(current.map((project) => project.id));
        for (const project of projects) {
            if (!isCurrentDispatchScope(scope)) return false;
            try {
                await loadCanvasOperationJournal(project.id, scope);
            } catch (error) {
                if (!(error instanceof CanvasJournalError)) throw error;
            }
            const applied = await applyBackendCanvasRead(byId.get(project.id), project, scope, existedIds.has(project.id));
            if (existedIds.has(project.id) && !openLocalCanvasProject(project.id)) {
                byId.delete(project.id);
                continue;
            }
            byId.set(project.id, applied);
        }
        if (!isCurrentDispatchScope(scope)) return false;
        useCanvasStore.setState({ projects: [...byId.values()] });
        await flushCanvasStorePersistence();
        return true;
    } catch {
        return false;
    }
}

/** Read the durable document without adopting it or hiding errors behind local state. */
export async function readLocalCanvasProjectFromBackend(id: string): Promise<CanvasProject> {
    const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
    if (!response.project) throw new Error("画布读取失败，请重试");
    return response.project;
}

export async function openLocalCanvasProjectFromBackend(id: string) {
    const scope = getActiveUserScope();
    const existed = Boolean(openLocalCanvasProject(id));
    try {
        try {
            await loadCanvasOperationJournal(id, scope);
        } catch (error) {
            if (!(error instanceof CanvasJournalError)) throw error;
        }
        const backendProject = await readLocalCanvasProjectFromBackend(id);
        if (!backendProject) return openLocalCanvasProject(id);
        const project = await applyBackendCanvasRead(openLocalCanvasProject(id), backendProject, scope, existed);
        if (!isCurrentDispatchScope(scope)) return project;
        if (existed && !openLocalCanvasProject(id)) return openLocalCanvasProject(id);
        useCanvasStore.setState((state) => ({
            projects: state.projects.some((item) => item.id === id)
                ? state.projects.map((item) => item.id === id ? project : item)
                : [...state.projects, project],
        }));
        await flushCanvasStorePersistence();
        return project;
    } catch {
        return openLocalCanvasProject(id);
    }
}

/**
 * 外部写入（内置助手回合、CLI/MCP 操作）后把服务端内容投影到本地编辑器。
 *
 * 与 `openLocalCanvasProjectFromBackend` 的区别：这里不假设本地一定服从服务端。
 * 有服务端尚未确认的编辑时保留本地内容、把远端留作候选并记录冲突；只有确认
 * 本地没有这类编辑时才应用外部 revision。
 *
 * 「是否有未确认编辑」在 GET 返回之后、应用之前同步重算一次：等待网络期间用户
 * 仍可能继续编辑，用请求发出时的判断会漏掉这些新编辑。
 */
export async function refreshLocalCanvasProjectIfChanged(id: string) {
    const scope = getActiveUserScope();
    const existed = Boolean(openLocalCanvasProject(id));
    try {
        try {
            await loadCanvasOperationJournal(id, scope);
        } catch (error) {
            if (!(error instanceof CanvasJournalError)) throw error;
            return undefined;
        }
        const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
        const remote = response.project;
        if (!remote) return undefined;
        if (!isCurrentDispatchScope(scope)) return undefined;
        if (existed && !openLocalCanvasProject(id)) return undefined;
        const before = openLocalCanvasProject(id);
        if (before && remote.revision === before.revision && !hasUnconfirmedCanvasEdits(id)) return undefined;
        if (hasUnconfirmedCanvasEdits(id) || canvasSubmitBlocked(id, scope)) {
            pauseForExternalCandidate(id, remote, scope);
            return undefined;
        }
        const base = peekCanvasOperationJournal(id, scope)?.confirmedSnapshot
            ?? canvasDocumentBase(id, scope)?.snapshot
            ?? null;
        const hadLive = Boolean(openLocalCanvasProject(id)) || existed;
        let confirmed;
        try {
            confirmed = await confirmRemoteDocument(remote, scope);
        } catch {
            return undefined;
        }
        if ((remote.revision ?? 0) < confirmed.confirmedRevision) {
            return openLocalCanvasProject(id);
        }
        if (existed && !openLocalCanvasProject(id)) return undefined;
        try {
            const aligned = alignLiveAfterConfirmedRemote({
                id,
                scope,
                remote,
                base,
                hadLive,
                onApplied: (project, previous) => {
                    if (!isCurrentDispatchScope(scope)) return;
                    notifyCanvasRefresh(project, previous);
                },
            });
            if (isCurrentDispatchScope(scope) && aligned && openLocalCanvasProject(id)) {
                await flushCanvasStorePersistence();
            }
            return aligned;
        } catch {
            if (isCurrentDispatchScope(scope)) pauseForExternalCandidate(id, remote, scope);
            return undefined;
        }
    } catch {
        return undefined;
    }
}

/**
 * 用户显式选择以最新内容为准：用冲突时保留的远端候选替换本地文档。
 *
 * 候选本身就是服务端已确认的内容，因此这里只把它落到本地并更新基线，
 * 不再回写一次服务端（回写只会平白推进 revision，甚至在服务端又变化时被拒）。
 */
export async function acceptExternalCanvasRevision(id: string) {
    const scope = getActiveUserScope();
    const conflict = canvasExternalRevisionConflict(scope, id);
    if (!conflict) return undefined;
    const candidate = conflict.candidate;
    await updateCanvasOperationJournal(id, scope, (current) => ({
        ...current,
        confirmedRevision: Math.max(current.confirmedRevision, candidate.revision ?? current.confirmedRevision),
        confirmedSnapshot: structuredClone(candidate),
        inFlight: null,
    }));
    recordServerConfirmedCanvas(candidate, scope);
    if (!isCurrentDispatchScope(scope)) {
        clearCanvasExternalRevisionConflict(scope, id);
        resumeCanvasBackendSubmit(id, scope);
        return candidate;
    }
    const decision = acceptCanvasExternalRevisionCandidate(id, {
        scope,
        onApplied: (project) => {
            notifyCanvasRefresh(project, undefined);
        },
    });
    if (!decision || decision.kind !== "apply") return undefined;
    resumeCanvasBackendSubmit(id, scope);
    await flushCanvasStorePersistence();
    return decision.project;
}

/** 该画布是否存在被本地编辑挡住的外部改动。 */
export function pendingExternalCanvasRevision(id: string) {
    return canvasExternalRevisionConflict(getActiveUserScope(), id);
}

export async function flushLocalWorkspace() {
    await flushCanvasStorePersistence();
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
}

export async function deleteLocalCanvasProjects(ids: readonly string[]) {
    const scope = getActiveUserScope();
    const selected = [...new Set(ids)];
    const snapshots = selected
        .map((id) => useCanvasStore.getState().openProject(id))
        .filter((project): project is CanvasProject => Boolean(project));
    for (const id of selected) canvasDeleting.add(saveKey(scope, id));
    try {
        await Promise.all(selected.map((id) => waitForCanvasBackendIdle(id, scope)));
        if (!isCurrentDispatchScope(scope)) throw new CanvasStaleScopeError("账号已切换，未删除画布");
        const deleted: string[] = [];
        const failures: unknown[] = [];
        for (const id of selected) {
            if (!isCurrentDispatchScope(scope)) throw new CanvasStaleScopeError("账号已切换，未删除画布");
            try {
                await http.delete(`/canvas-projects/${encodeURIComponent(id)}`);
                await clearCanvasOperationJournal(id, scope);
                clearCanvasDocumentBase(id, scope);
                serverConfirmedCanvasSnapshots.delete(saveKey(scope, id));
                deleted.push(id);
            } catch (error) {
                if (error instanceof CanvasStaleScopeError) throw error;
                console.error("画布后端删除失败", { id, error });
                failures.push(error);
                if (isCurrentDispatchScope(scope) && !useCanvasStore.getState().openProject(id)) {
                    const snapshot = snapshots.find((item) => item.id === id);
                    if (snapshot) useCanvasStore.getState().restoreProject(snapshot);
                }
            }
        }
        if (!isCurrentDispatchScope(scope)) {
            throw new CanvasStaleScopeError("账号已切换，未删除画布");
        }
        if (deleted.length) {
            useCanvasStore.getState().deleteProjects(deleted);
            const removed = snapshots.filter((item) => deleted.includes(item.id));
            if (removed.length) useCanvasHistoryStore.getState().recordDeletedProjects(removed);
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
