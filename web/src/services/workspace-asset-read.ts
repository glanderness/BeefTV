import { parseAssetRecord } from "@/lib/asset-record";
import { assertUserScope, captureUserScope, UserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import {
    listWorkspaceAssetSummaries,
    listWorkspaceAssetsPage,
    lookupWorkspaceAssetsByIds,
    type WorkspaceAssetPageResponse,
} from "@/services/api/workspace-assets";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import {
    hydrateAssetStoreDrafts,
    readAssetStoreDrafts,
    runAssetStoreProjection,
    useAssetStore,
    type Asset,
    type AssetStoreDraftRecord,
} from "@/stores/use-asset-store";

type AssetStoreDraftWithSnapshot = AssetStoreDraftRecord & { asset?: Asset };

export const WORKSPACE_ASSET_BATCH_LIMIT = 100;
export const WORKSPACE_ASSET_RECENT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * SQLite Library hard-deletes rows and GET /assets plus POST /assets/batch only
 * return surviving owner records. There is no tombstone/import list, so a
 * cache-only id cannot be distinguished from a server deletion.
 */
export const WORKSPACE_ASSET_TOMBSTONE_SEAM =
    "asset.Library 没有墓碑/导入清单：GET /assets 与 POST /assets/batch 只返回仍存在的所属记录。浏览器缓存里多出的 ID 无法区分「从未写入 SQLite」和「服务端已删除」。";

const preservedDraftScopes = new Set<string>();

export type WorkspaceAssetLibraryPageOptions = {
    page: number;
    pageSize: number;
    kind?: string;
    category?: string;
    folderId?: string;
    uncategorized?: boolean;
    status?: string;
    query?: string;
    favorite?: boolean;
    recent?: boolean;
    project?: string;
    signal?: AbortSignal;
    expectedScope?: CapturedUserScope;
};

export type WorkspaceAssetLibraryPage = {
    assets: Asset[];
    kindCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
    folderCounts: Record<string, number>;
    favoriteTotal: number;
    recentTotal: number;
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
};

export function usesWorkspaceAssetLibraryApi() {
    return !usesBrowserLocalResourceStore();
}

export function resetWorkspaceAssetReadStateForTests() {
    preservedDraftScopes.clear();
}

export function isUnsavedWorkspaceAsset(asset: Asset) {
    return asset.status === "draft" || asset.metadata?.unsaved === true || asset.metadata?.recoverableLocalDraft === true;
}

export async function loadWorkspaceAssetLibraryPage(options: WorkspaceAssetLibraryPageOptions): Promise<WorkspaceAssetLibraryPage> {
    throwIfAborted(options.signal);
    if (!usesWorkspaceAssetLibraryApi()) return loadBrowserLocalAssetPage(options);

    const expected = options.expectedScope ?? captureUserScope();
    assertUserScope(expected);
    await hydrateAssetStoreDrafts(expected.userScope);
    assertUserScope(expected);
    throwIfAborted(options.signal);

    const remote = await listWorkspaceAssetsPage(
        {
            page: options.page,
            pageSize: options.pageSize,
            kind: options.kind,
            category: options.category,
            folderId: options.folderId,
            uncategorized: options.uncategorized,
            status: options.status,
            query: options.query,
            favorite: options.favorite,
            recent: options.recent,
            project: options.project,
        },
        { signal: options.signal, expectedScope: expected },
    );
    assertUserScope(expected);
    throwIfAborted(options.signal);

    const parsed = parseWorkspaceAssetPage(remote);
    const overlaid = overlayAssetDrafts(parsed, options, expected);
    projectCommittedAssets(parsed.assets, expected);
    return overlaid;
}

export async function loadWorkspaceAssetsForUse(ids: Iterable<string>, expectedScope?: CapturedUserScope) {
    const unique = [...new Set([...ids].map((id) => id.trim()).filter(Boolean))];
    if (!unique.length) return;
    if (!usesWorkspaceAssetLibraryApi()) {
        const available = new Set(useAssetStore.getState().assets.map((asset) => asset.id));
        if (unique.some((id) => !available.has(id))) throw new Error("部分本地素材不存在，请重新选择素材");
        return;
    }

    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    await hydrateAssetStoreDrafts(expected.userScope);
    assertUserScope(expected);
    const drafts = readAssetStoreDrafts(expected);
    const deleted = new Set(drafts.deletes.map((draft) => draft.id));
    const upsertById = new Map(drafts.upserts.map((draft) => [draft.id, draft]));
    const storeById = new Map(useAssetStore.getState().assets.map((asset) => [asset.id, asset]));
    if (unique.some((id) => deleted.has(id))) throw new Error("部分本地素材不存在，请重新选择素材");

    const lookupIds = unique.filter((id) => !upsertById.has(id));
    const found = new Set<string>();
    const snapshots: Asset[] = [];
    for (const id of unique) {
        const draft = upsertById.get(id);
        if (!draft) continue;
        const live = resolveDraftAsset(draft, storeById);
        if (!live) continue;
        found.add(id);
        if (!storeById.has(id)) snapshots.push(live);
    }
    const loaded: Asset[] = [];
    for (const chunk of chunkIds(lookupIds, WORKSPACE_ASSET_BATCH_LIMIT)) {
        const result = await lookupWorkspaceAssetsByIds(chunk, { expectedScope: expected });
        assertUserScope(expected);
        for (const asset of parseWorkspaceAssetPayloads(result.assets)) {
            found.add(asset.id);
            loaded.push(asset);
        }
    }
    projectCommittedAssets(loaded, expected);
    if (snapshots.length) projectDraftSnapshots(snapshots, expected);
    if (unique.some((id) => !found.has(id))) throw new Error("部分本地素材不存在，请重新选择素材");
}

export async function preserveLegacyCacheOnlyAssetDrafts(expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    if (!usesWorkspaceAssetLibraryApi()) {
        return { preservedIds: [] as string[], tombstoneSeam: WORKSPACE_ASSET_TOMBSTONE_SEAM };
    }
    if (preservedDraftScopes.has(expected.userScope)) {
        return { preservedIds: [] as string[], tombstoneSeam: WORKSPACE_ASSET_TOMBSTONE_SEAM };
    }

    await hydrateAssetStoreDrafts(expected.userScope);
    assertUserScope(expected);
    const summaries = await listWorkspaceAssetSummaries({ expectedScope: expected });
    assertUserScope(expected);
    const committed = new Set((summaries.assets || []).map((item) => item.id).filter(Boolean));
    const drafts = readAssetStoreDrafts(expected);
    const drafted = new Set([...drafts.upserts, ...drafts.deletes].map((draft) => draft.id));
    const preservedIds: string[] = [];
    for (const asset of useAssetStore.getState().assets) {
        if (committed.has(asset.id) || drafted.has(asset.id)) continue;
        useAssetStore.getState().updateAsset(asset.id, {
            status: "draft",
            metadata: { ...(asset.metadata || {}), recoverableLocalDraft: true },
        });
        preservedIds.push(asset.id);
    }
    preservedDraftScopes.add(expected.userScope);
    return { preservedIds, tombstoneSeam: WORKSPACE_ASSET_TOMBSTONE_SEAM };
}

function loadBrowserLocalAssetPage(options: WorkspaceAssetLibraryPageOptions): WorkspaceAssetLibraryPage {
    const query = options.query?.trim().toLowerCase() || "";
    const catalog = useAssetStore.getState().assets;
    const filtered = catalog.filter((asset) => matchesLibraryFilters(asset, options, query));
    const start = Math.max(0, options.page - 1) * options.pageSize;
    const active = catalog.filter((asset) => asset.status !== "archived");
    return {
        assets: filtered.slice(start, start + options.pageSize),
        kindCounts: countMap(filtered, (asset) => asset.kind),
        categoryCounts: countMap(filtered, (asset) => asset.category || "other"),
        folderCounts: countMap(filtered, (asset) => asset.folderId || ""),
        favoriteTotal: active.filter((asset) => asset.metadata?.favorite === true).length,
        recentTotal: active.filter(isRecentAsset).length,
        page: options.page,
        pageSize: options.pageSize,
        total: filtered.length,
        hasMore: start + options.pageSize < filtered.length,
    };
}

function overlayAssetDrafts(page: WorkspaceAssetLibraryPage, options: WorkspaceAssetLibraryPageOptions, expected: CapturedUserScope): WorkspaceAssetLibraryPage {
    assertUserScope(expected);
    const drafts = readAssetStoreDrafts(expected);
    const deleted = new Set(drafts.deletes.map((draft) => draft.id));
    const upsertById = new Map(drafts.upserts.map((draft) => [draft.id, draft]));
    const storeById = new Map(useAssetStore.getState().assets.map((asset) => [asset.id, asset]));
    const query = options.query?.trim().toLowerCase() || "";
    const backendIds = new Set(page.assets.map((asset) => asset.id));
    const seen = new Set<string>();
    const assets: Asset[] = [];

    for (const asset of page.assets) {
        if (deleted.has(asset.id)) continue;
        const draft = upsertById.get(asset.id);
        if (draft) {
            if (options.page > 1) continue;
            const live = resolveDraftAsset(draft, storeById) ?? asset;
            if (!matchesLibraryFilters(live, options, query) || seen.has(live.id)) continue;
            seen.add(live.id);
            assets.push(markUnsavedCopy(live));
            continue;
        }
        if (seen.has(asset.id)) continue;
        seen.add(asset.id);
        assets.push(asset);
    }

    if (options.page <= 1) {
        for (const draft of drafts.upserts) {
            if (seen.has(draft.id) || deleted.has(draft.id)) continue;
            const live = resolveDraftAsset(draft, storeById);
            if (!live || !matchesLibraryFilters(live, options, query)) continue;
            seen.add(draft.id);
            assets.unshift(markUnsavedCopy(live));
        }
    }

    let hidden = 0;
    let localOnlyMatching = 0;
    let favoriteTotal = page.favoriteTotal;
    let recentTotal = page.recentTotal;
    for (const asset of page.assets) {
        if (deleted.has(asset.id)) hidden += 1;
    }
    for (const draft of drafts.upserts) {
        if (deleted.has(draft.id)) continue;
        const live = resolveDraftAsset(draft, storeById);
        if (!live) continue;
        if (!matchesLibraryFilters(live, options, query)) {
            if (backendIds.has(draft.id) && !deleted.has(draft.id)) hidden += 1;
            continue;
        }
        if (isLocalOnlyLibraryAsset(live) && !backendIds.has(draft.id)) {
            localOnlyMatching += 1;
            if (live.metadata?.favorite === true) favoriteTotal += 1;
            if (isRecentAsset(live)) recentTotal += 1;
        }
    }

    return {
        ...page,
        assets,
        total: Math.max(0, page.total - hidden + localOnlyMatching),
        hasMore: page.hasMore,
        favoriteTotal,
        recentTotal,
    };
}

function projectCommittedAssets(assets: Asset[], expected: CapturedUserScope) {
    if (!assets.length) return;
    assertUserScope(expected);
    const drafts = readAssetStoreDrafts(expected);
    const skip = new Set([...drafts.upserts, ...drafts.deletes].map((draft) => draft.id));
    runAssetStoreProjection(() => {
        useAssetStore.setState((state) => {
            const next = new Map(state.assets.map((asset) => [asset.id, asset]));
            for (const asset of assets) {
                if (skip.has(asset.id)) continue;
                next.set(asset.id, asset);
            }
            return { assets: [...next.values()] };
        });
    });
}

function projectDraftSnapshots(assets: Asset[], expected: CapturedUserScope) {
    if (!assets.length) return;
    assertUserScope(expected);
    runAssetStoreProjection(() => {
        useAssetStore.setState((state) => {
            const next = new Map(state.assets.map((asset) => [asset.id, asset]));
            for (const asset of assets) {
                if (next.has(asset.id)) continue;
                next.set(asset.id, asset);
            }
            return { assets: [...next.values()] };
        });
    });
}

function parseWorkspaceAssetPage(remote: WorkspaceAssetPageResponse): WorkspaceAssetLibraryPage {
    if (!remote || !Array.isArray(remote.assets)) throw new Error("素材列表无效");
    return {
        assets: parseWorkspaceAssetPayloads(remote.assets),
        kindCounts: numberMap(remote.kindCounts),
        categoryCounts: numberMap(remote.categoryCounts),
        folderCounts: numberMap(remote.folderCounts),
        favoriteTotal: Number(remote.favoriteTotal) || 0,
        recentTotal: Number(remote.recentTotal) || 0,
        page: Number(remote.page) || 1,
        pageSize: Number(remote.pageSize) || 40,
        total: Number(remote.total) || 0,
        hasMore: Boolean(remote.hasMore),
    };
}

function parseWorkspaceAssetPayloads(values: unknown): Asset[] {
    if (values == null) return [];
    if (!Array.isArray(values)) throw new Error("素材列表无效");
    const assets: Asset[] = [];
    values.forEach((item, index) => {
        try {
            assets.push(normalizeWorkspaceAssetPayload(item));
        } catch (error) {
            const id = isRecord(item) && typeof item.id === "string" && item.id.trim() ? item.id : `#${index}`;
            console.warn("已隔离无法展示的素材记录", { id, error: error instanceof Error ? error.message : String(error) });
        }
    });
    return assets;
}

export function normalizeWorkspaceAssetPayload(value: unknown): Asset {
    return applyResourceDisplayUrls(parseAssetRecord(value));
}

function applyResourceDisplayUrls(asset: Asset): Asset {
    const storageKey = "data" in asset && asset.data && "storageKey" in asset.data ? asset.data.storageKey : undefined;
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (!resourceId) return asset;
    const url = resourceFileUrl(resourceId);
    const coverUrl = rewriteResourceCoverUrl(asset.coverUrl, resourceId, url);
    if (asset.kind === "video") {
        return { ...asset, coverUrl, data: { ...asset.data, url } };
    }
    if (asset.kind === "audio") {
        return { ...asset, coverUrl, data: { ...asset.data, url } };
    }
    if (asset.kind === "model") {
        return { ...asset, coverUrl, data: { ...asset.data, url } };
    }
    if (asset.kind === "image") {
        return { ...asset, coverUrl, data: { ...asset.data, dataUrl: url } };
    }
    return { ...asset, coverUrl };
}

function rewriteResourceCoverUrl(value: string | undefined, resourceId: string, current: string) {
    if (blobOrEmpty(value) || looksLikeOwnedResourceFileUrl(value, resourceId)) return current;
    return value || current;
}

function looksLikeOwnedResourceFileUrl(value: string | undefined, resourceId: string) {
    if (!value) return false;
    const path = (value.includes("://") ? safeURLPathname(value) : value.split(/[?#]/, 1)[0] || "").replace(/\/+$/, "");
    const match = path.match(/\/(?:api\/)?resources\/([^/]+)\/file$/);
    if (!match) return false;
    try {
        return decodeURIComponent(match[1]) === resourceId;
    } catch {
        return match[1] === resourceId;
    }
}

function safeURLPathname(value: string) {
    try {
        return new URL(value).pathname;
    } catch {
        return value.split(/[?#]/, 1)[0] || "";
    }
}

function resolveDraftAsset(draft: AssetStoreDraftRecord, storeById: Map<string, Asset>) {
    const stored = storeById.get(draft.id);
    if (stored) return stored;
    const snapshot = (draft as AssetStoreDraftWithSnapshot).asset;
    if (!snapshot || snapshot.id !== draft.id) return undefined;
    return applyResourceDisplayUrls(snapshot);
}

function isLocalOnlyLibraryAsset(asset: Asset) {
    return asset.status === "draft" || asset.metadata?.recoverableLocalDraft === true;
}

function isRecentAsset(asset: Asset) {
    const updated = new Date(asset.updatedAt).getTime();
    return Number.isFinite(updated) && Date.now() - updated <= WORKSPACE_ASSET_RECENT_MS;
}

function matchesLibraryFilters(asset: Asset, options: WorkspaceAssetLibraryPageOptions, query: string) {
    if (options.kind && asset.kind !== options.kind) return false;
    if (options.category && (asset.category || "other") !== options.category) return false;
    if (options.status === "archived" && asset.status !== "archived") return false;
    if (options.status === "active" && asset.status === "archived") return false;
    if (options.status && options.status !== "active" && options.status !== "archived" && asset.status !== options.status) return false;
    if (options.uncategorized && asset.folderId) return false;
    if (options.folderId && asset.folderId !== options.folderId) return false;
    if (!matchesExtraClientFilters(asset, options)) return false;
    if (!query) return true;
    return [asset.title, asset.source, ...(asset.tags || [])].join(" ").toLowerCase().includes(query);
}

function matchesExtraClientFilters(asset: Asset, options: WorkspaceAssetLibraryPageOptions) {
    if (options.favorite && asset.metadata?.favorite !== true) return false;
    if (options.recent && !isRecentAsset(asset)) return false;
    if (options.project && assetProjectLabel(asset) !== options.project) return false;
    return true;
}

function assetProjectLabel(asset: Asset) {
    const projectName = asset.metadata?.projectName;
    if (typeof projectName === "string" && projectName.trim()) return projectName.trim();
    return Array.isArray(asset.metadata?.projectIds) && asset.metadata.projectIds.length ? "已关联项目" : "未关联项目";
}

function markUnsavedCopy(asset: Asset): Asset {
    return { ...asset, metadata: { ...(asset.metadata || {}), unsaved: true } };
}

function countMap(assets: Asset[], keyOf: (asset: Asset) => string | undefined) {
    return assets.reduce<Record<string, number>>((counts, asset) => {
        const key = keyOf(asset) || "";
        counts[key] = (counts[key] || 0) + 1;
        return counts;
    }, {});
}

function numberMap(value: unknown): Record<string, number> {
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, Number(item) || 0]));
}

function chunkIds(ids: string[], size: number) {
    const chunks: string[][] = [];
    for (let index = 0; index < ids.length; index += size) chunks.push(ids.slice(index, index + size));
    return chunks;
}

function blobOrEmpty(value?: string) {
    return !value || value.startsWith("blob:");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

export { UserScopeAbandonedError };
