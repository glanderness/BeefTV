import { acceptCanvasExternalRevisionCandidate, applyExternalCanvasRevision, canvasDocumentBase, canvasDurableSnapshot, canvasExternalRevisionConflict, clearCanvasDocumentBase, flushCanvasStorePersistence, recordCanvasDocumentBase, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { ApiError, http } from "@/services/api/request";
import { commitCanvasDocument } from "@/services/api/operations";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { notifyCanvasRefresh } from "@/services/local-workspace-sync";
import { canvasBackendSubmitPaused, handleRejectedCanvasBackendSave, isCanvasRevisionConflict, resumeCanvasBackendSubmit } from "@/services/canvas-revision-conflict";
import { abandonCanvasInFlight, CanvasJournalError, clearCanvasOperationJournal, loadCanvasOperationJournal, newCanvasCommitOperationId, peekCanvasOperationJournal, recordConfirmedCanvasCommit, saveCanvasOperationJournal } from "@/services/canvas-operation-journal";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { getActiveUserScope } from "@/lib/user-scope";
import { sameCanvasDocument } from "@/lib/canvas/canvas-content";

type LocalCanvasContent = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">>;
type CanvasSaveSummary = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt" | "revision">;
type CanvasDocumentPersistPatch = Partial<Pick<CanvasProject, "nodes" | "connections" | "timeline" | "chatSessions" | "activeChatId" | "appearance" | "backgroundMode" | "showImageInfo" | "title" | "folderId" | "directorScenes">>;

const backendSaveTails = new Map<string, Promise<void>>();
const backendSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    serverConfirmedCanvasSnapshots.set(saveKey(scope, project.id), project);
    recordCanvasDocumentBase(project, scope);
}

async function recordConfirmedWithoutInventing(project: CanvasProject, scope: string, options?: { ackOperationId?: string }) {
    try {
        await recordConfirmedCanvasCommit(project, scope, options);
    } catch (error) {
        if (!(error instanceof CanvasJournalError)) throw error;
    }
}

/** HTTP 层是否还有该画布未落地的提交（已排队或正在发送）。 */
function canvasBackendSubmitPending(id: string, scope: string) {
    const key = saveKey(scope, id);
    return backendSaveTails.has(key) || backendSaveTimers.has(key);
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
    if (canvasBackendSubmitPending(id, scope) || canvasBackendSubmitPaused(id)) return true;
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

async function applyBackendCanvasRead(local: CanvasProject | null | undefined, backend: CanvasProject, scope: string) {
    const chosen = selectPreferredCanvasProject(local, backend, scope);
    if (!local || chosen === backend || sameCanvasDocument(chosen, backend)) {
        recordServerConfirmedCanvas(backend, scope);
        await recordConfirmedWithoutInventing(backend, scope);
        return backend;
    }
    const recorded = canvasDocumentBase(local.id, scope);
    const serverMoved = !recorded
        || (backend.revision ?? 0) !== recorded.revision
        || !sameCanvasDocument(backend, recorded.snapshot);
    if (serverMoved) {
        recordServerConfirmedCanvas(backend, scope);
        await recordConfirmedWithoutInventing(backend, scope);
        if (isCurrentDispatchScope(scope)) applyExternalCanvasRevision(backend, { hasUnsyncedEdits: true });
    }
    return local;
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
        if (!isCurrentDispatchScope(scope)) return;
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
    recordServerConfirmedCanvas(confirmed, scope);
    await recordConfirmedCanvasCommit(confirmed, scope, ackOperationId ? { ackOperationId } : {});
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
    resumeCanvasBackendSubmit(id);
    void flushCanvasStorePersistence().catch((error) => {
        console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
    });
}

async function submitGeneratedAssetsToBackend(id: string, scope: string) {
    await commitLiveCanvasDocument(id, scope);
    if (!isCurrentDispatchScope(scope) || canvasBackendSubmitPaused(id)) return;
    const project = openLocalCanvasProject(id);
    if (!project) return;
    const assets = canvasGenerationCommitAssets(project, useAssetStore.getState().assets);
    const projectForSave = bindCanvasGenerationCommitAssets(project, assets);
    const saved = await putCanvasProjectToBackend(id, project, `/canvas-projects/${encodeURIComponent(id)}/generated-assets`, projectForSave, assets, true, scope);
    if (!saved) return;
    await applyAcceptedCanvasSave(id, projectForSave, saved, assets, scope);
}

async function putCanvasProjectToBackend(id: string, project: CanvasProject, endpoint: string, projectForSave: CanvasProject, assets: Asset[], includeGeneratedAssets: boolean, scope: string) {
    try {
        const response = await http.put<{ project: CanvasSaveSummary }>(endpoint, includeGeneratedAssets ? { project: projectForSave, assets } : { project: projectForSave });
        return response.project;
    } catch (error) {
        if (isCurrentDispatchScope(scope)) {
            const conflict = await handleRejectedCanvasBackendSave(id, project, error);
            if (includeGeneratedAssets && conflict) {
                throw Object.assign(new Error("生成结果已保留，但画布有版本冲突。请先使用画布最新版本，再重新加载资源，不要重新生成。"), { code: "canvas_conflict" });
            }
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
    if (journal.inFlight) {
        await sendCanvasDocumentCommit(id, journal.inFlight.operationId, journal.inFlight.payload, scope);
    }
    if (!isCurrentDispatchScope(scope) || canvasBackendSubmitPaused(id)) return;
    const project = openLocalCanvasProject(id);
    if (!project) return;
    const current = await loadCanvasOperationJournal(id, scope);
    if (current.confirmedSnapshot && sameCanvasDocument(current.confirmedSnapshot, project) && !current.inFlight) return;
    if (isInitialCanvasCreate(project, scope) && !current.inFlight) {
        const saved = await putCanvasProjectToBackend(id, project, `/canvas-projects/${encodeURIComponent(id)}`, project, [], false, scope);
        if (!saved) return;
        await applyAcceptedCanvasSave(id, project, saved, undefined, scope);
        return;
    }
    if (current.inFlight) return;
    const expectedRevision = current.confirmedRevision || project.revision || 0;
    const operationId = newCanvasCommitOperationId();
    const payload = { canvasId: id, expectedRevision, document: project };
    await saveCanvasOperationJournal({
        ...current,
        inFlight: { operationId, expectedRevision, payload },
    });
    await sendCanvasDocumentCommit(id, operationId, payload, scope);
}

async function sendCanvasDocumentCommit(id: string, operationId: string, payload: { canvasId: string; expectedRevision: number; document: CanvasProject }, scope: string) {
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
        if (isCanvasRevisionConflict(error)) {
            await abandonCanvasInFlight(id, scope);
            if (isCurrentDispatchScope(scope)) await handleRejectedCanvasBackendSave(id, payload.document, error);
            throw error;
        }
        if (!shouldKeepCanvasCommitIdentity(error)) {
            await abandonCanvasInFlight(id, scope);
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
        if (localMode && (shouldKeepCanvasCommitIdentity(error) || isCanvasRevisionConflict(error))) throw error;
        if (previous && isCurrentDispatchScope(scope)) {
            await abandonCanvasInFlight(id, scope);
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

export function scheduleLocalCanvasBackendSync(id: string) {
    const scope = getActiveUserScope();
    const key = saveKey(scope, id);
    const existing = backendSaveTimers.get(key);
    if (existing) clearTimeout(existing);
    backendSaveTimers.set(key, setTimeout(() => {
        backendSaveTimers.delete(key);
        if (!isCurrentDispatchScope(scope)) return;
        void syncLocalCanvasProject(id, false, scope).catch((error) => console.error("画布后端持久化失败，等待下次编辑重试", { id, error }));
    }, 500));
}

export function resetLocalCanvasBackendSaveState() {
    for (const timer of backendSaveTimers.values()) clearTimeout(timer);
    backendSaveTimers.clear();
    backendSaveTails.clear();
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
        for (const project of projects) {
            if (!isCurrentDispatchScope(scope)) return false;
            try {
                await loadCanvasOperationJournal(project.id, scope);
            } catch (error) {
                if (!(error instanceof CanvasJournalError)) throw error;
            }
            byId.set(project.id, await applyBackendCanvasRead(byId.get(project.id), project, scope));
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
    try {
        try {
            await loadCanvasOperationJournal(id, scope);
        } catch (error) {
            if (!(error instanceof CanvasJournalError)) throw error;
        }
        const backendProject = await readLocalCanvasProjectFromBackend(id);
        if (!backendProject) return openLocalCanvasProject(id);
        const project = await applyBackendCanvasRead(openLocalCanvasProject(id), backendProject, scope);
        if (isCurrentDispatchScope(scope)) {
            useCanvasStore.setState((state) => ({
                projects: state.projects.some((item) => item.id === id)
                    ? state.projects.map((item) => item.id === id ? project : item)
                    : [...state.projects, project],
            }));
            await flushCanvasStorePersistence();
        }
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
    const before = openLocalCanvasProject(id);
    try {
        const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
        const remote = response.project;
        if (!remote) return undefined;
        if (!isCurrentDispatchScope(scope)) return undefined;
        if (before && remote.revision === before.revision && !hasUnconfirmedCanvasEdits(id)) return undefined;
        let decision;
        try {
            decision = applyExternalCanvasRevision(remote, {
                hasUnsyncedEdits: hasUnconfirmedCanvasEdits(id),
                onApplied: (project, previous) => {
                    if (!isCurrentDispatchScope(scope)) return;
                    notifyCanvasRefresh(project, previous);
                    recordServerConfirmedCanvas(project, scope);
                },
            });
        } catch {
            if (isCurrentDispatchScope(scope)) applyExternalCanvasRevision(remote, { hasUnsyncedEdits: true });
            return undefined;
        }
        if (decision.kind === "keep-local") {
            recordServerConfirmedCanvas(remote, scope);
            await recordConfirmedWithoutInventing(remote, scope);
            return undefined;
        }
        await recordConfirmedWithoutInventing(decision.project, scope);
        if (isCurrentDispatchScope(scope)) await flushCanvasStorePersistence();
        return decision.project;
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
    const decision = acceptCanvasExternalRevisionCandidate(id, {
        onApplied: (project) => {
            // Explicitly choosing the latest version replaces the old editor
            // snapshot; re-merging it can resurrect the conflict or drop nodes.
            notifyCanvasRefresh(project, undefined);
            recordServerConfirmedCanvas(project, scope);
        },
    });
    if (!decision || decision.kind !== "apply") return undefined;
    await abandonCanvasInFlight(id, scope);
    await recordConfirmedWithoutInventing(decision.project, scope);
    if (isCurrentDispatchScope(scope)) {
        resumeCanvasBackendSubmit(id);
        await flushCanvasStorePersistence();
    }
    return decision.project;
}

/** 该画布是否存在被本地编辑挡住的外部改动。 */
export function pendingExternalCanvasRevision(id: string) {
    return canvasExternalRevisionConflict(getActiveUserScope(), id);
}

export async function flushLocalWorkspace() {
    await flushCanvasStorePersistence();
}

export async function deleteLocalCanvasProjects(ids: readonly string[]) {
    const scope = getActiveUserScope();
    const selected = new Set(ids);
    const snapshots = useCanvasStore.getState().projects.filter((project) => selected.has(project.id));
    useCanvasStore.getState().deleteProjects([...ids]);
    if (snapshots.length) useCanvasHistoryStore.getState().recordDeletedProjects(snapshots);
    await flushCanvasStorePersistence();
    await Promise.all(ids.map(async (id) => {
        try {
            await http.delete(`/canvas-projects/${encodeURIComponent(id)}`);
            await clearCanvasOperationJournal(id, scope);
            clearCanvasDocumentBase(id, scope);
            serverConfirmedCanvasSnapshots.delete(saveKey(scope, id));
        } catch (error) {
            console.error("画布后端删除失败", { id, error });
            throw error;
        }
    }));
    return snapshots;
}
