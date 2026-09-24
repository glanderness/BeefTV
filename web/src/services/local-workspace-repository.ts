import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { http } from "@/services/api/request";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

type LocalCanvasContent = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">>;
type CanvasSaveSummary = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt" | "revision">;

const backendSaveTails = new Map<string, Promise<void>>();
const backendSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
function syncLocalCanvasProject(id: string, includeGeneratedAssets: boolean, generationEffectKey?: string): Promise<void> {
    const previous = backendSaveTails.get(id) || Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
        const project = openLocalCanvasProject(id);
        if (!project) return;
        const assets = includeGeneratedAssets ? canvasGenerationCommitAssets(project, useAssetStore.getState().assets) : [];
        const projectForSave = includeGeneratedAssets ? bindCanvasGenerationCommitAssets(project, assets) : project;
        const endpoint = includeGeneratedAssets ? `/canvas-projects/${encodeURIComponent(id)}/generated-assets` : `/canvas-projects/${encodeURIComponent(id)}`;
        const response = await http.put<{ project: CanvasSaveSummary }>(endpoint, includeGeneratedAssets ? { project: projectForSave, assets, effectKey: generationEffectKey } : { project: projectForSave });
        const saved = response.project;
        if (!saved) return;
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
        void flushCanvasStorePersistence().catch((error) => {
            console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
        });
    });
    const tail = next.finally(() => {
        if (backendSaveTails.get(id) === tail) backendSaveTails.delete(id);
    });
    backendSaveTails.set(id, tail);
    return next;
}

export function syncLocalCanvasProjectToBackend(id: string): Promise<void> {
    return syncLocalCanvasProject(id, false);
}

export function syncLocalCanvasGenerationProjectToBackend(id: string, generationEffectKey: string): Promise<void> {
    return syncLocalCanvasProject(id, true, generationEffectKey);
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

export async function openLocalCanvasProjectFromBackend(id: string) {
    try {
        const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
        const backendProject = response.project;
        if (!backendProject) return openLocalCanvasProject(id);
        const project = selectPreferredCanvasProject(openLocalCanvasProject(id), backendProject);
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

export async function refreshLocalCanvasProjectIfChanged(id: string) {
    const current = openLocalCanvasProject(id);
    try {
        const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
        const remote = response.project;
        if (!remote || selectPreferredCanvasProject(current, remote) !== remote) return false;
        useCanvasStore.setState((state) => ({
            projects: state.projects.some((item) => item.id === id)
                ? state.projects.map((item) => item.id === id ? remote : item)
                : [...state.projects, remote],
        }));
        await flushCanvasStorePersistence();
        return remote;
    } catch {
        return undefined;
    }
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
