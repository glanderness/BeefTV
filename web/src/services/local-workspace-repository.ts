import { acceptCanvasExternalRevisionCandidate, applyExternalCanvasRevision, canvasDurableSnapshot, canvasExternalRevisionConflict, flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { http } from "@/services/api/request";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { notifyCanvasRefresh } from "@/services/local-workspace-sync";
import { canvasBackendSubmitPaused, handleRejectedCanvasBackendSave, resumeCanvasBackendSubmit } from "@/services/canvas-revision-conflict";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { getActiveUserScope } from "@/lib/user-scope";
import { sameCanvasDocument } from "@/lib/canvas/canvas-content";

type LocalCanvasContent = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">>;
type CanvasSaveSummary = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt" | "revision">;

const backendSaveTails = new Map<string, Promise<void>>();
const backendSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * 每画布最后一次被服务端确认的文档快照：成功 PUT 的入参，或从服务端读回并被
 * 采纳的内容。它是判断「本地是否有服务端尚未确认的编辑」的唯一权威基线——
 * 浏览器存储队列只说明有没有写进 IndexedDB，不代表服务端已经收到。
 */
const serverConfirmedCanvasSnapshots = new Map<string, CanvasProject>();

function recordServerConfirmedCanvas(project: CanvasProject | undefined) {
    if (!project) return;
    serverConfirmedCanvasSnapshots.set(project.id, project);
}

/** HTTP 层是否还有该画布未落地的提交（已排队或正在发送）。 */
function canvasBackendSubmitPending(id: string) {
    return backendSaveTails.has(id) || backendSaveTimers.has(id);
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
    const live = openLocalCanvasProject(id);
    if (!live) return false;
    if (canvasBackendSubmitPending(id) || canvasBackendSubmitPaused(id)) return true;
    const confirmed = serverConfirmedCanvasSnapshots.get(id);
    if (confirmed) return !sameCanvasDocument(confirmed, live);
    const durable = canvasDurableSnapshot(getActiveUserScope(), id);
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

function projectUpdatedAt(project: CanvasProject) {
    const timestamp = Date.parse(project.updatedAt);
    return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Resolve the browser/desktop dual-store snapshot without allowing an older
 * backend response to erase edits that have already been persisted locally.
 * Unknown/equal versions intentionally keep the local copy: data preservation
 * is safer than treating a backend read as authoritative without evidence that
 * it is newer.
 */
export function selectPreferredCanvasProject(local: CanvasProject | null | undefined, backend: CanvasProject) {
    if (!local) return backend;
    const localUpdatedAt = projectUpdatedAt(local);
    const backendUpdatedAt = projectUpdatedAt(backend);
    if (backendUpdatedAt !== localUpdatedAt) return backendUpdatedAt > localUpdatedAt ? backend : local;
    const localRevision = local.revision ?? 0;
    const backendRevision = backend.revision ?? 0;
    if (backendRevision !== localRevision) return backendRevision > localRevision ? backend : local;
    return local;
}

/**
 * Local workspace persistence boundary.
 *
 * This module deliberately has no network, account, or hosted-service imports.
 * Keep local canvas CRUD here so desktop callers do not need to enter the
 * hosted synchronization service just to persist a project.
 */
export async function createLocalCanvasProject(title: string, projectId?: string, initialContent?: LocalCanvasContent, workspaceProjectId?: string) {
    const id = useCanvasStore.getState().createProject(title, projectId, workspaceProjectId);
    if (initialContent) useCanvasStore.getState().updateProject(id, initialContent);
    // The in-memory project is already usable. Do not make navigation depend
    // on an IndexedDB/localForage flush completing successfully; the store
    // keeps its pending write queue and will retry it on the next flush.
    // Desktop restarts hydrate from the co-packaged Go repository. Creating a
    // project only in IndexedDB leaves the runtime returning 404 and allows its
    // detached-resource cleanup to delete media that the canvas still uses.
    await syncLocalCanvasProjectToBackend(id);
    // IndexedDB is an offline cache, not the desktop source of truth. A stuck
    // WebKit storage transaction must never block navigation after the Go
    // repository has durably accepted the project.
    void flushCanvasStorePersistence().catch((error) => {
        console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
    });
    return { id };
}

/** Serialize writes per canvas so optimistic revisions cannot race each other. */
function syncLocalCanvasProject(id: string, includeGeneratedAssets: boolean): Promise<void> {
    const previous = backendSaveTails.get(id) || Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
        const project = openLocalCanvasProject(id);
        if (!project) return;
        const assets = includeGeneratedAssets ? canvasGenerationCommitAssets(project, useAssetStore.getState().assets) : [];
        const projectForSave = includeGeneratedAssets ? bindCanvasGenerationCommitAssets(project, assets) : project;
        const endpoint = includeGeneratedAssets ? `/canvas-projects/${encodeURIComponent(id)}/generated-assets` : `/canvas-projects/${encodeURIComponent(id)}`;
        const saved = await submitCanvasProjectToBackend(id, project, endpoint, projectForSave, assets, includeGeneratedAssets);
        if (!saved) return;
        // 服务端已确认这次提交：记下被接受的那一份内容，作为后续刷新的基线。
        recordServerConfirmedCanvas(projectForSave);
        useCanvasStore.setState((state) => ({
            projects: state.projects.map((current) => current.id === id
                // Preserve edits made while the request was in flight; only the
                // server-owned optimistic revision must advance.
                ? {
                    ...(includeGeneratedAssets ? bindCanvasGenerationCommitAssets(current, assets) : current),
                    revision: saved.revision,
                    ...(current.updatedAt === project.updatedAt ? { updatedAt: saved.updatedAt } : {}),
                }
                : current),
        }));
        resumeCanvasBackendSubmit(id);
        void flushCanvasStorePersistence().catch((error) => {
            console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
        });
    });
    const tail = next.finally(() => {
        if (backendSaveTails.get(id) === tail) backendSaveTails.delete(id);
    });
    backendSaveTails.set(id, tail);
    return tail;
}

/**
 * 发送一次画布提交并返回服务端摘要。
 *
 * 失败时先按「陈旧提交」收尾（保留本地草稿并暂停自动提交），再把错误抛出，
 * 让调用方看到真实失败，而不是被包装成成功。
 */
async function submitCanvasProjectToBackend(id: string, project: CanvasProject, endpoint: string, projectForSave: CanvasProject, assets: Asset[], includeGeneratedAssets: boolean) {
    try {
        const response = await http.put<{ project: CanvasSaveSummary }>(endpoint, includeGeneratedAssets ? { project: projectForSave, assets } : { project: projectForSave });
        return response.project;
    } catch (error) {
        const conflict = await handleRejectedCanvasBackendSave(id, project, error);
        if (includeGeneratedAssets && conflict) {
            throw Object.assign(new Error("生成结果已保留，但画布有版本冲突。请先使用画布最新版本，再重新加载资源，不要重新生成。"), { code: "canvas_conflict" });
        }
        throw error;
    }
}

export function syncLocalCanvasProjectToBackend(id: string): Promise<void> {
    return syncLocalCanvasProject(id, false);
}

type CanvasDocumentPersistPatch = Partial<Pick<CanvasProject, "nodes" | "connections" | "timeline">>;

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
 * Local desktop hydrates from SQLite, so that profile PUTs the Go repository
 * without waiting on IndexedDB. Hosted keeps update plus an awaited flush.
 * A failed write only reverts patch fields that nobody else changed.
 */
export async function persistCanvasDocument(id: string, patch: CanvasDocumentPersistPatch) {
    const previous = useCanvasStore.getState().openProject(id);
    useCanvasStore.getState().updateProject(id, patch);
    const attempted = useCanvasStore.getState().openProject(id);
    try {
        if (isLocalWorkspaceMode()) {
            await syncLocalCanvasProjectToBackend(id);
            return;
        }
        await flushCanvasStorePersistence();
    } catch (error) {
        if (previous) {
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
    return syncLocalCanvasProject(id, true);
}

export function scheduleLocalCanvasBackendSync(id: string) {
    const existing = backendSaveTimers.get(id);
    if (existing) clearTimeout(existing);
    backendSaveTimers.set(id, setTimeout(() => {
        backendSaveTimers.delete(id);
        void syncLocalCanvasProjectToBackend(id).catch((error) => console.error("画布后端持久化失败，等待下次编辑重试", { id, error }));
    }, 500));
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
        const current = useCanvasStore.getState().projects;
        const byId = new Map(current.map((project) => [project.id, project]));
        for (const project of projects) byId.set(project.id, selectPreferredCanvasProject(byId.get(project.id), project));
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
    try {
        const backendProject = await readLocalCanvasProjectFromBackend(id);
        if (!backendProject) return openLocalCanvasProject(id);
        const project = selectPreferredCanvasProject(openLocalCanvasProject(id), backendProject);
        // 服务端这一版就是它当前的确认内容；即使最终采用较新的本地内容，
        // 这份快照仍然是「服务端确认到哪一版」的基线。
        recordServerConfirmedCanvas(backendProject);
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
    const before = openLocalCanvasProject(id);
    try {
        const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
        const remote = response.project;
        if (!remote) return undefined;
        if (before && remote.revision === before.revision && !hasUnconfirmedCanvasEdits(id)) return undefined;
        let decision;
        try {
            decision = applyExternalCanvasRevision(remote, {
                hasUnsyncedEdits: hasUnconfirmedCanvasEdits(id),
                onApplied: (project, previous) => {
                    notifyCanvasRefresh(project, previous);
                    recordServerConfirmedCanvas(project);
                },
            });
        } catch {
            // The live editor may have edits not yet projected into the store.
            // Keep both versions and expose the same explicit resolution action.
            applyExternalCanvasRevision(remote, { hasUnsyncedEdits: true });
            return undefined;
        }
        if (decision.kind === "keep-local") return undefined;
        await flushCanvasStorePersistence();
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
    const decision = acceptCanvasExternalRevisionCandidate(id, {
        onApplied: (project) => {
            // Explicitly choosing the latest version replaces the old editor
            // snapshot; re-merging it can resurrect the conflict or drop nodes.
            notifyCanvasRefresh(project, undefined);
            recordServerConfirmedCanvas(project);
        },
    });
    if (!decision || decision.kind !== "apply") return undefined;
    resumeCanvasBackendSubmit(id);
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

export async function deleteLocalCanvasProjects(ids: readonly string[]) {
    const selected = new Set(ids);
    const snapshots = useCanvasStore.getState().projects.filter((project) => selected.has(project.id));
    useCanvasStore.getState().deleteProjects([...ids]);
    if (snapshots.length) useCanvasHistoryStore.getState().recordDeletedProjects(snapshots);
    await flushCanvasStorePersistence();
    await Promise.all(ids.map(async (id) => {
        try {
            await http.delete(`/canvas-projects/${encodeURIComponent(id)}`);
        } catch (error) {
            console.error("画布后端删除失败", { id, error });
            throw error;
        }
    }));
    return snapshots;
}
