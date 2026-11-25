import { create } from "zustand";
import { persist, type StorageValue } from "zustand/middleware";
import { nanoid } from "nanoid";

import { parseAssetRecord } from "@/lib/asset-record";
import { rebaseAssetSnapshot, serializeAssetStorageDocument, type AssetStorageDocument } from "@/lib/asset-storage-revision";
import { parseCanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { bumpMediaReferenceEpoch, readMediaReferenceEpoch } from "@/lib/media-gc-epoch";
import { getActiveUserScope } from "@/lib/user-scope";
import { parseWorkspaceAssetPayloads } from "@/lib/workspace-asset-normalize";
import { lookupWorkspaceAssetsByIds } from "@/services/api/workspace-assets";
import { getCanvasHydrationHealth } from "@/services/canvas-hydration-health";
import { readAllCanvasSyncDrafts } from "@/services/canvas-sync-drafts";
import { cleanupUnusedMedia, collectMediaStorageKeys } from "@/services/file-storage";
import { insertOrReturnGenerationAsset, withGenerationArtifactCommitLock, withGenerationAssetStorageLock } from "@/services/generation-asset-repository";
import { cleanupUnusedImages, collectImageStorageKeys } from "@/services/image-storage";
import { usesSingleSourceLocalPersistence } from "@/services/workspace-resource-storage";
import { CANVAS_DRAFTS_KEY, CANVAS_HISTORY_STORE_KEY } from "@/stores/canvas/canvas-store-persistence";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import {
    CANVAS_STORE_KEY,
    commitPendingCanvasStorePersistenceLocked,
    pendingCanvasStorePersistence,
    useCanvasStore,
    withCanvasStorePersistenceLock,
    type CanvasProject,
} from "@/stores/canvas/use-canvas-store";
import {
    bindAssetDraftStoreHooks,
    flushAssetStoreDraftWrites,
    hydrateAssetStoreDrafts,
    isDeletedGenerationAsset,
    markAssetStoreDraft,
    markAssetStoreDraftForScope,
    peekAssetStoreDraft,
    readAssetStoreDraftsForScope,
    retryFailedAssetStoreDraftPersist,
} from "./asset-store-drafts";
import {
    ASSET_STORE_KEY,
    assetStorage,
    clearDesktopLegacyAssetCacheScopesForTests,
    commitPendingAssetStorePersistenceLocked,
    observedAssetPersistForScope,
    readLegacyDeletedGenerationIdsForScope,
    readPersistedAssetDocumentForScope,
    recordAssetStorageDocument,
    recordGenerationAssetFailure,
    trackAssetOperation,
    trackGenerationAssetOperation,
    withAssetStorePersistenceSuppressed,
} from "./asset-store-persistence";
import type { Asset, AssetStore } from "./asset-types";

export type {
    Asset,
    AssetCategory,
    AssetKind,
    AssetStatus,
    AssetStoreDraft,
    AssetStoreDraftKind,
    AssetStoreDraftRecord,
    AudioAsset,
    EntityAsset,
    ImageAsset,
    ModelAsset,
    NewAsset,
    TextAsset,
    VideoAsset,
} from "./asset-types";
export {
    ASSET_STORE_DRAFTS_KEY,
    ackAssetStoreDraft,
    hydrateAssetStoreDrafts,
    isDeletedGenerationAsset,
    peekAssetStoreDraft,
    promoteAssetStoreDraftsBatch,
    readAssetStoreDrafts,
    recordAssetStoreDraft,
    resetAssetStoreDraftsForTests,
    runAssetStoreProjection,
    unloadAssetStoreDraftsForTests,
} from "./asset-store-drafts";
export {
    ASSET_STORE_KEY,
    clearLegacyDesktopAssetCache,
    flushAssetStorePersistence,
    hasActiveAssetStorePersistence,
    withAssetStorePersistenceSuppressed,
} from "./asset-store-persistence";

export async function generationAssetId(effectKey: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(effectKey));
    return `generation_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [parseAssetRecord({ ...asset, id, createdAt: now, updatedAt: now }), ...state.assets] }));
                markAssetStoreDraft(id, "upsert");
                return id;
            },
            addGenerationAsset: (effectKey, asset, signal) => {
                const scope = getActiveUserScope();
                if (usesSingleSourceLocalPersistence()) {
                    return trackGenerationAssetOperation(
                        scope,
                        effectKey,
                        (async () => {
                            const id = await generationAssetId(effectKey);
                            await hydrateAssetStoreDrafts(scope);
                            // Check SQLite outside the asset storage lock so a slow or transient
                            // backend error neither blocks sibling writes nor breaks draft creation.
                            let remoteMatches: Asset[] = [];
                            let lookupFailed = false;
                            const hasLocalMatch = get().assets.some((item) => item.id === id || item.metadata?.generationEffectKey === effectKey);
                            if (!isDeletedGenerationAsset(scope, id) && !hasLocalMatch) {
                                try {
                                    const remote = await lookupWorkspaceAssetsByIds([id], { signal });
                                    remoteMatches = parseWorkspaceAssetPayloads(remote.assets);
                                } catch (error) {
                                    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
                                        throw error;
                                    }
                                    lookupFailed = true;
                                    console.warn("生成素材回查本地库失败，将先保存为本地草稿等待后续同步", {
                                        scope,
                                        assetId: id,
                                        error: error instanceof Error ? error.message : String(error),
                                    });
                                }
                            }
                            let createdAsset: Asset | undefined;
                            const resolvedId = await insertOrReturnGenerationAsset<Asset>({
                                storageScope: scope,
                                effectKey,
                                assetId: id,
                                createAsset: () => {
                                    const now = new Date().toISOString();
                                    createdAsset = parseAssetRecord({
                                        ...asset,
                                        id,
                                        createdAt: now,
                                        updatedAt: now,
                                        metadata: {
                                            ...asset.metadata,
                                            generationEffectKey: effectKey,
                                            ...(lookupFailed ? { generationLookupUnverified: true } : {}),
                                        },
                                    });
                                    return createdAsset;
                                },
                                updateAssets: (updater) => {
                                    withAssetStorePersistenceSuppressed(() => {
                                        set((state) => ({ assets: updater(state.assets) }));
                                    });
                                },
                                readAssets: () => get().assets,
                                readPersistedAssets: async () => {
                                    try {
                                        await hydrateAssetStoreDrafts(scope);
                                        const current = get().assets;
                                        if (!remoteMatches.length) return current;
                                        const byId = new Map(current.map((item) => [item.id, item]));
                                        for (const item of remoteMatches) {
                                            if (!byId.has(item.id)) byId.set(item.id, item);
                                        }
                                        return [...byId.values()];
                                    } catch (error) {
                                        recordGenerationAssetFailure(scope, effectKey, error);
                                        throw error;
                                    }
                                },
                                isAssetDeleted: () => isDeletedGenerationAsset(scope, id),
                                requireCrossRealmLock: true,
                                signal,
                                persistAssets: async () => {
                                    try {
                                        markAssetStoreDraftForScope(scope, id, "upsert", createdAsset);
                                        await flushAssetStoreDraftWrites(scope);
                                    } catch (error) {
                                        recordGenerationAssetFailure(scope, effectKey, error);
                                        throw error;
                                    }
                                },
                            });
                            if (!createdAsset && peekAssetStoreDraft(scope, resolvedId)) {
                                try {
                                    retryFailedAssetStoreDraftPersist(scope);
                                    await flushAssetStoreDraftWrites(scope);
                                } catch (error) {
                                    recordGenerationAssetFailure(scope, effectKey, error);
                                    throw error;
                                }
                            }
                            return resolvedId;
                        })(),
                    );
                }

                const publicationBase = observedAssetPersistForScope(scope) ?? { assets: get().assets, revision: 0 };
                return trackGenerationAssetOperation(
                    scope,
                    effectKey,
                    (async () => {
                        const id = await generationAssetId(effectKey);
                        let persistedDocument: AssetStorageDocument | null = null;
                        return insertOrReturnGenerationAsset<Asset>({
                            storageScope: scope,
                            effectKey,
                            assetId: id,
                            createAsset: () => {
                                const now = new Date().toISOString();
                                return parseAssetRecord({
                                    ...asset,
                                    id,
                                    createdAt: now,
                                    updatedAt: now,
                                    metadata: { ...asset.metadata, generationEffectKey: effectKey },
                                });
                            },
                            updateAssets: (updater) => {
                                withAssetStorePersistenceSuppressed(() => {
                                    set((state) => {
                                        if (!persistedDocument) return { assets: updater(state.assets) };
                                        const liveDocument = rebaseAssetSnapshot({
                                            document: persistedDocument,
                                            baseAssets: publicationBase.assets,
                                            localAssets: state.assets,
                                            baseRevision: publicationBase.revision,
                                        });
                                        const generationAssets = updater(persistedDocument.state.assets);
                                        const published = rebaseAssetSnapshot({
                                            document: liveDocument,
                                            baseAssets: persistedDocument.state.assets,
                                            localAssets: generationAssets,
                                            baseRevision: persistedDocument.storageRevision,
                                        });
                                        return { assets: published.state.assets };
                                    });
                                });
                            },
                            readAssets: () => get().assets,
                            readPersistedAssets: async () => {
                                try {
                                    await commitPendingAssetStorePersistenceLocked(scope);
                                    persistedDocument = await readPersistedAssetDocumentForScope(scope);
                                    recordAssetStorageDocument(scope, persistedDocument);
                                    return persistedDocument.state.assets;
                                } catch (error) {
                                    recordGenerationAssetFailure(scope, effectKey, error);
                                    throw error;
                                }
                            },
                            isAssetDeleted: () => Boolean(persistedDocument?.tombstones.assets[id]),
                            requireCrossRealmLock: true,
                            signal,
                            persistAssets: async (assets) => {
                                const durable = persistedDocument ?? (await readPersistedAssetDocumentForScope(scope));
                                const nextDocument: AssetStorageDocument = {
                                    ...durable,
                                    state: { assets },
                                    storageRevision: durable.storageRevision + 1,
                                };
                                try {
                                    await localForageStorageForScope(scope).setItem(ASSET_STORE_KEY, serializeAssetStorageDocument(nextDocument));
                                } catch (error) {
                                    recordGenerationAssetFailure(scope, effectKey, error);
                                    throw error;
                                }
                                persistedDocument = nextDocument;
                                recordAssetStorageDocument(scope, nextDocument);
                            },
                        });
                    })(),
                );
            },
            updateAsset: (id, patch) => {
                set((state) => ({
                    assets: state.assets.map((asset) => {
                        if (asset.id !== id) return asset;
                        const merged = { ...asset, ...patch, updatedAt: new Date().toISOString() };
                        if (merged.metadata?.generationLookupUnverified === true && patch.metadata?.generationLookupUnverified !== true) {
                            const { generationLookupUnverified: _omitted, ...rest } = merged.metadata;
                            merged.metadata = Object.keys(rest).length ? rest : undefined;
                        }
                        return parseAssetRecord(merged);
                    }),
                }));
                markAssetStoreDraft(id, "upsert");
            },
            removeAsset: async (id, options) => {
                let remainingAssets: Asset[] = [];
                let removedAsset: Asset | undefined;
                set((state) => {
                    removedAsset = state.assets.find((asset) => asset.id === id);
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    remainingAssets = assets;
                    return { assets };
                });
                markAssetStoreDraft(id, "delete");
                // 没有本地媒体定位时没有需要由该删除动作回收的 Blob；跳过全库扫描，
                // 避免纯文本/远程资源删除依赖浏览器 IndexedDB 驱动。
                if (options?.cleanupMedia === false) return;
                if (!removedAsset || (!collectImageStorageKeys(removedAsset).size && !collectMediaStorageKeys(removedAsset).size)) return;
                await get().cleanupImages({ assets: remainingAssets }).catch((error) => {
                    // 素材删除本身已成功，媒体清理 fail-closed 失败时不把删除动作误报为失败。
                    console.warn("素材删除后的本地媒体清理已跳过", { id, error });
                });
            },
            replaceAssets: (assets) => set({ assets: assets.map(parseAssetRecord) }),
            cleanupImages: async (extra) => {
                const scope = getActiveUserScope();
                const frozenExtraImageKeys = collectImageStorageKeys(extra);
                const frozenExtraMediaKeys = collectMediaStorageKeys(extra);
                return new Promise<boolean>((resolve, reject) => {
                    window.setTimeout(() =>
                        withGenerationArtifactCommitLock(scope, async () => {
                            const hydration = getCanvasHydrationHealth();
                            if (hydration.loading || Boolean(hydration.error)) return false;
                            const journalModule = await import("@/services/canvas-operation-journal");
                            const startEpoch = readMediaReferenceEpoch();
                            const shouldAbortSweep = () => {
                                const currentHealth = getCanvasHydrationHealth();
                                return currentHealth.loading
                                    || Boolean(currentHealth.error)
                                    || readMediaReferenceEpoch() !== startEpoch;
                            };
                            const storage = localForageStorageForScope(scope);
                            const syncDrafts = await readAllCanvasSyncDrafts(scope);
                            // 在画布持久化锁外读取提交日记与回收站快照，避免拖慢 pagehide/切页落盘；
                            // 读取或解析失败时 fail-closed 向上抛错，绝不在不完整引用下删媒体。
                            const journals = typeof journalModule.readAllCanvasOperationJournals === "function"
                                ? await journalModule.readAllCanvasOperationJournals(scope)
                                : [];
                            const journalDocuments = journals.flatMap((journal) => [
                                ...(journal.confirmedSnapshot ? [journal.confirmedSnapshot] : []),
                                ...(journal.inFlight?.payload?.document ? [journal.inFlight.payload.document] : []),
                                ...(journal.pendingProjection?.remote ? [journal.pendingProjection.remote] : []),
                                ...(journal.pendingProjection?.base ? [journal.pendingProjection.base] : []),
                            ]);
                            const liveDeletedEntries = scope === getActiveUserScope()
                                ? (useCanvasHistoryStore.getState?.()?.deletedProjects ?? [])
                                : [];
                            const liveDeletedProjects = liveDeletedEntries
                                .map((item) => item.project)
                                .filter((project): project is CanvasProject => Boolean(project && !project.summaryOnly));
                            const durableDeletedProjects = parseDeletedHistoryProjects(await storage.getItem(CANVAS_HISTORY_STORE_KEY));
                            // 固定锁序：artifact -> Canvas（释放）-> Asset，避免跨 store 锁重入。
                            const canvasReferences = await withCanvasStorePersistenceLock(scope, async () => {
                                await commitPendingCanvasStorePersistenceLocked(scope);
                                const durableCanvas = parseCanvasStorageDocument(await storage.getItem(CANVAS_STORE_KEY));
                                const durableCanvasDrafts = parseCanvasStorageDocument(await storage.getItem(CANVAS_DRAFTS_KEY));
                                const liveProjects = scope === getActiveUserScope() ? useCanvasStore.getState().projects : [];
                                const pendingProjects = pendingCanvasStorePersistence(scope)?.projects ?? [];
                                const summaryMediaRefs = [...liveProjects, ...pendingProjects].flatMap((project) =>
                                    project.summaryOnly && project.summaryMediaKeys?.length
                                        ? project.summaryMediaKeys.map((storageKey) => ({ storageKey }))
                                        : [],
                                );
                                return {
                                    projects: [
                                        ...liveProjects,
                                        ...pendingProjects,
                                        ...durableCanvas.state.projects,
                                        ...durableCanvasDrafts.state.projects,
                                        ...liveDeletedProjects,
                                        ...durableDeletedProjects,
                                        ...journalDocuments,
                                    ],
                                    summaryMediaRefs,
                                };
                            });
                            return withGenerationAssetStorageLock(scope, async () => {
                                await commitPendingAssetStorePersistenceLocked(scope);
                                await hydrateAssetStoreDrafts(scope);
                                const durableAssets = (await readPersistedAssetDocumentForScope(scope)).state.assets;
                                const liveAssets = scope === getActiveUserScope() ? get().assets : [];
                                const draftAssets = readAssetStoreDraftsForScope(scope).upserts;
                                const references = {
                                    projects: canvasReferences.projects,
                                    summaryMediaRefs: canvasReferences.summaryMediaRefs,
                                    assets: durableAssets,
                                    liveAssets,
                                    draftAssets,
                                    syncDrafts,
                                };
                                const imageKeys = new Set([...frozenExtraImageKeys, ...collectImageStorageKeys(references)]);
                                const mediaKeys = new Set([...frozenExtraMediaKeys, ...collectMediaStorageKeys(references)]);
                                if (shouldAbortSweep()) return false;
                                const imagesDone = await cleanupUnusedImages(
                                    [...imageKeys].map((storageKey) => ({ storageKey })),
                                    scope,
                                    { shouldAbort: shouldAbortSweep },
                                );
                                if (!imagesDone || shouldAbortSweep()) return false;
                                return cleanupUnusedMedia(
                                    [...mediaKeys].map((storageKey) => ({ storageKey })),
                                    scope,
                                    { shouldAbort: shouldAbortSweep },
                                );
                            });
                        }).then(resolve, reject),
                    );
                });
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => () => {
                useAssetStore.setState({ hydrated: true });
                void hydrateAssetStoreDrafts(undefined, { reproject: true });
            },
        },
    ),
);

let suppressingInternalAssetDraftEpoch = false;

bindAssetDraftStoreHooks({
    readAssets: () => useAssetStore.getState().assets,
    applyDrafts: (updater) => {
        suppressingInternalAssetDraftEpoch = true;
        try {
            withAssetStorePersistenceSuppressed(() => {
                useAssetStore.setState((state) => ({ assets: updater(state.assets) }));
            });
        } finally {
            suppressingInternalAssetDraftEpoch = false;
        }
    },
    trackOperation: trackAssetOperation,
    clearDesktopLegacyScopes: clearDesktopLegacyAssetCacheScopesForTests,
    readLegacyDeletedGenerationIds: readLegacyDeletedGenerationIdsForScope,
});

if (typeof useCanvasStore.subscribe === "function") {
    useCanvasStore.subscribe((next, prev) => {
        if (next.projects !== prev.projects) bumpMediaReferenceEpoch();
    });
}
if (typeof useCanvasHistoryStore.subscribe === "function") {
    useCanvasHistoryStore.subscribe((next, prev) => {
        if (next.deletedProjects !== prev.deletedProjects) bumpMediaReferenceEpoch();
    });
}
if (typeof useAssetStore.subscribe === "function") {
    useAssetStore.subscribe((next, prev) => {
        if (!suppressingInternalAssetDraftEpoch && next.assets !== prev.assets) {
            bumpMediaReferenceEpoch();
        }
    });
}

function parseDeletedHistoryProjects(raw: string | null): CanvasProject[] {
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { state?: { deletedProjects?: unknown } };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("回收站本地记录损坏，已中止媒体清理");
    }
    const items = parsed.state?.deletedProjects;
    if (items === undefined) return [];
    if (!Array.isArray(items)) {
        throw new Error("回收站项目列表格式异常，已中止媒体清理");
    }
    const projects: CanvasProject[] = [];
    for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("回收站记录项格式异常，已中止媒体清理");
        }
        const project = (item as { project?: unknown }).project;
        if (project === undefined || project === null) continue;
        if (typeof project !== "object" || Array.isArray(project)) {
            throw new Error("回收站画布快照格式异常，已中止媒体清理");
        }
        const typed = project as CanvasProject;
        if (!typed.summaryOnly) projects.push(typed);
    }
    return projects;
}
