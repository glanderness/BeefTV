import { create } from "zustand";
import { persist, type StorageValue } from "zustand/middleware";
import { nanoid } from "nanoid";

import { parseAssetRecord } from "@/lib/asset-record";
import { rebaseAssetSnapshot, serializeAssetStorageDocument, type AssetStorageDocument } from "@/lib/asset-storage-revision";
import { parseCanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { parseWorkspaceAssetPayloads } from "@/lib/workspace-asset-normalize";
import { lookupWorkspaceAssetsByIds } from "@/services/api/workspace-assets";
import { getCanvasHydrationHealth } from "@/services/canvas-hydration-health";
import { readAllCanvasSyncDrafts } from "@/services/canvas-sync-drafts";
import { cleanupUnusedMedia, collectMediaStorageKeys } from "@/services/file-storage";
import { insertOrReturnGenerationAsset, withGenerationArtifactCommitLock, withGenerationAssetStorageLock } from "@/services/generation-asset-repository";
import { cleanupUnusedImages, collectImageStorageKeys } from "@/services/image-storage";
import { usesSingleSourceLocalPersistence } from "@/services/workspace-resource-storage";
import { CANVAS_DRAFTS_KEY } from "@/stores/canvas/canvas-store-persistence";
import {
    CANVAS_STORE_KEY,
    commitPendingCanvasStorePersistenceLocked,
    pendingCanvasStorePersistence,
    useCanvasStore,
    withCanvasStorePersistenceLock,
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

async function generationAssetId(effectKey: string) {
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
                await get().cleanupImages({ assets: remainingAssets });
            },
            replaceAssets: (assets) => set({ assets: assets.map(parseAssetRecord) }),
            cleanupImages: async (extra) => {
                const scope = getActiveUserScope();
                const frozenExtraImageKeys = collectImageStorageKeys(extra);
                const frozenExtraMediaKeys = collectMediaStorageKeys(extra);
                await new Promise<void>((resolve, reject) => {
                    window.setTimeout(() =>
                        withGenerationArtifactCommitLock(scope, async () => {
                            const hydration = getCanvasHydrationHealth();
                            if (hydration.started && (hydration.loading || Boolean(hydration.error))) return;
                            const storage = localForageStorageForScope(scope);
                            const syncDrafts = await readAllCanvasSyncDrafts(scope);
                            const journalModule = await import("@/services/canvas-operation-journal");
                            const journals = typeof journalModule.readAllCanvasOperationJournals === "function"
                                ? await journalModule.readAllCanvasOperationJournals(scope)
                                : [];
                            const journalDocuments = journals.flatMap((journal) => [
                                ...(journal.inFlight?.payload?.document ? [journal.inFlight.payload.document] : []),
                                ...(journal.pendingProjection?.remote ? [journal.pendingProjection.remote] : []),
                                ...(journal.pendingProjection?.base ? [journal.pendingProjection.base] : []),
                            ]);
                            // 固定锁序：artifact -> Canvas（释放）-> Asset，避免跨 store 锁重入。
                            const canvasReferences = await withCanvasStorePersistenceLock(scope, async () => {
                                await commitPendingCanvasStorePersistenceLocked(scope);
                                const durableCanvas = parseCanvasStorageDocument(await storage.getItem(CANVAS_STORE_KEY));
                                const durableCanvasDrafts = parseCanvasStorageDocument(await storage.getItem(CANVAS_DRAFTS_KEY));
                                const liveProjects = scope === getActiveUserScope() ? useCanvasStore.getState().projects : [];
                                const summaryMediaRefs = liveProjects.flatMap((project) =>
                                    project.summaryOnly && project.summaryMediaKeys?.length
                                        ? project.summaryMediaKeys.map((storageKey) => ({ storageKey }))
                                        : [],
                                );
                                return {
                                    projects: [
                                        ...liveProjects,
                                        ...(pendingCanvasStorePersistence(scope)?.projects ?? []),
                                        ...durableCanvas.state.projects,
                                        ...durableCanvasDrafts.state.projects,
                                        ...journalDocuments,
                                    ],
                                    summaryMediaRefs,
                                };
                            });
                            await withGenerationAssetStorageLock(scope, async () => {
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
                                await cleanupUnusedImages(
                                    [...imageKeys].map((storageKey) => ({ storageKey })),
                                    scope,
                                );
                                await cleanupUnusedMedia(
                                    [...mediaKeys].map((storageKey) => ({ storageKey })),
                                    scope,
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

bindAssetDraftStoreHooks({
    readAssets: () => useAssetStore.getState().assets,
    applyDrafts: (updater) => {
        withAssetStorePersistenceSuppressed(() => {
            useAssetStore.setState((state) => ({ assets: updater(state.assets) }));
        });
    },
    trackOperation: trackAssetOperation,
    clearDesktopLegacyScopes: clearDesktopLegacyAssetCacheScopesForTests,
    readLegacyDeletedGenerationIds: readLegacyDeletedGenerationIdsForScope,
});
