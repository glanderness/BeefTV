import type { PersistStorage, StorageValue } from "zustand/middleware";

import { parseAssetRecord } from "@/lib/asset-record";
import { parseAssetStorageDocumentRecovering, rebaseAssetSnapshot, serializeAssetStorageDocument, type AssetStorageDocument } from "@/lib/asset-storage-revision";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { resolveMediaUrl } from "@/services/file-storage";
import { flushGenerationAssetStorageLocks, withGenerationAssetStorageLock } from "@/services/generation-asset-repository";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { usesSingleSourceLocalPersistence } from "@/services/workspace-resource-storage";
import {
    flushAssetStoreDraftWrites,
    hasActiveAssetStoreDraftWrites,
    hydrateAssetStoreDrafts,
    isDeletedGenerationAsset,
    peekAssetStoreDraft,
    recordDeletedGenerationAssetIds,
    retryFailedAssetStoreDraftPersist,
} from "./asset-store-drafts";
import type { Asset, AssetStore } from "./asset-types";

export const ASSET_STORE_KEY = "infinite-canvas:asset_store";

type PersistedAssetState = Pick<AssetStore, "assets">;

type ObservedAssetPersist = {
    assets: Asset[];
    revision: number;
};

type QueuedAssetPersist = {
    name: string;
    scope: string;
    baseAssets: Asset[];
    baseRevision: number;
    assets: Asset[];
    token: number;
};

type LegacyDesktopAssetCacheState = {
    assetIds: string[];
    deletedGenerationIds: string[];
    hasInvalidRecords: boolean;
};

let suppressAssetStorePersistence = 0;
const assetMemoryStates = new Map<string, PersistedAssetState>();
const observedAssetPersists = new Map<string, ObservedAssetPersist>();
const queuedAssetPersists = new Map<string, QueuedAssetPersist>();
const assetPersistTokens = new Map<string, number>();
const assetOperations = new Set<Promise<unknown>>();
const generationAssetFailures = new Map<string, unknown>();
const desktopLegacyAssetCaches = new Map<string, LegacyDesktopAssetCacheState>();

export function clearDesktopLegacyAssetCacheScopesForTests() {
    desktopLegacyAssetCaches.clear();
}

export function readLegacyDeletedGenerationIdsForScope(scope: string): readonly string[] {
    return desktopLegacyAssetCaches.get(scope)?.deletedGenerationIds ?? [];
}

export function observedAssetPersistForScope(scope: string) {
    return observedAssetPersists.get(scope);
}

export function recordAssetStorageDocument(scope: string, document: AssetStorageDocument) {
    observedAssetPersists.set(scope, {
        assets: document.state.assets,
        revision: document.storageRevision,
    });
}

export function withAssetStorePersistenceSuppressed<T>(operation: () => T) {
    suppressAssetStorePersistence += 1;
    try {
        return operation();
    } finally {
        suppressAssetStorePersistence -= 1;
    }
}

export async function commitPendingAssetStorePersistenceLocked(scope: string) {
    const storage = localForageStorageForScope(scope);
    let committed: AssetStorageDocument | null = null;

    while (true) {
        const queued = queuedAssetPersists.get(scope);
        if (!queued) return committed;

        // 读取旧版本时允许隔离历史坏记录；真正写回前，queued.assets 已经由 persistAssetState 严格校验。
        // 这样既不会用伪造默认值掩盖坏数据，也不会让一条旧记录阻断整库的后续写入。
        const recovery = parseAssetStorageDocumentRecovering(await storage.getItem(queued.name), queued.baseAssets);
        if (recovery.invalid.length) {
            console.warn("素材本地缓存包含无法恢复的历史记录，写回时将隔离这些记录", {
                scope,
                invalid: recovery.invalid,
            });
        }
        const durable = recovery.document;
        const rebased = rebaseAssetSnapshot({
            document: durable,
            baseAssets: queued.baseAssets,
            localAssets: queued.assets,
            baseRevision: queued.baseRevision,
        });
        await storage.setItem(queued.name, serializeAssetStorageDocument(rebased));
        committed = rebased;
        recordAssetStorageDocument(scope, rebased);

        const latest = queuedAssetPersists.get(scope);
        if (!latest || latest.token === queued.token) {
            if (latest?.token === queued.token) queuedAssetPersists.delete(scope);
            return committed;
        }

        latest.baseAssets = queued.assets;
        latest.baseRevision = rebased.storageRevision;
    }
}

async function writeQueuedAssetPersist(scope: string) {
    await withGenerationAssetStorageLock(scope, () => commitPendingAssetStorePersistenceLocked(scope));
}

export async function readPersistedAssetDocumentForScope(scope: string) {
    const recovery = parseAssetStorageDocumentRecovering(await localForageStorageForScope(scope).getItem(ASSET_STORE_KEY));
    if (recovery.invalid.length) {
        console.warn("素材本地缓存包含无法恢复的历史记录，已隔离并保留其诊断信息", {
            scope,
            invalid: recovery.invalid,
        });
    }
    return recovery.document;
}

/**
 * 登记一个素材写操作，供登出、切换账号和页面卸载前统一冲刷。
 *
 * 这里不能直接对 finally 返回的 Promise 放任不管：原操作失败时，finally 派生的
 * Promise 也会拒绝并产生未处理拒绝。用 then 的成功/失败分支做同一个清理动作，
 * 既保留原 Promise 给调用方观察真实错误，也不会制造第二条未处理错误链。
 */
export function trackAssetOperation<T>(operation: Promise<T>) {
    assetOperations.add(operation);
    const cleanup = () => assetOperations.delete(operation);
    void operation.then(cleanup, cleanup);
    return operation;
}

function generationAssetFailureKey(scope: string, effectKey: string) {
    return `${scope}\0${effectKey}`;
}

export function recordGenerationAssetFailure(scope: string, effectKey: string, error: unknown) {
    generationAssetFailures.set(generationAssetFailureKey(scope, effectKey), error);
}

export function trackGenerationAssetOperation<T>(scope: string, effectKey: string, operation: Promise<T>) {
    const failureKey = generationAssetFailureKey(scope, effectKey);
    return trackAssetOperation(
        operation.then(
            (value) => {
                generationAssetFailures.delete(failureKey);
                return value;
            },
            (error) => {
                throw error;
            },
        ),
    );
}

function generationFailureFor(scope: string) {
    const prefix = `${scope}\0`;
    for (const [key, error] of generationAssetFailures) {
        if (key.startsWith(prefix)) return error;
    }
}

function persistAssetState(name: string, value: StorageValue<AssetStore>) {
    const scope = getActiveUserScope();
    const nextAssets = value.state.assets.map(parseAssetRecord);
    const queued = queuedAssetPersists.get(scope);
    const observed = observedAssetPersists.get(scope);
    const baseAssets = assetMemoryStates.get(scope)?.assets ?? observed?.assets ?? [];
    assetMemoryStates.set(scope, { assets: nextAssets });
    if (suppressAssetStorePersistence) return;

    // In desktop/embedded SQLite mode, SQLite owns committed assets and ASSET_STORE_DRAFTS_KEY
    // owns uncommitted local edits; never mirror the full catalog into ASSET_STORE_KEY.
    if (usesSingleSourceLocalPersistence()) return;

    const token = (assetPersistTokens.get(scope) ?? 0) + 1;
    assetPersistTokens.set(scope, token);
    queuedAssetPersists.set(scope, {
        name,
        scope,
        baseAssets: queued?.baseAssets ?? baseAssets,
        baseRevision: queued?.baseRevision ?? observed?.revision ?? 0,
        assets: nextAssets,
        token,
    });
    return trackAssetOperation(writeQueuedAssetPersist(scope));
}

/**
 * Remove the legacy full-catalog IndexedDB mirror in single-source mode only after
 * proving every legacy entry is safely backed by SQLite or a complete durable draft
 * snapshot (and zero invalid records were quarantined).
 */
export async function clearLegacyDesktopAssetCache(scope = getActiveUserScope(), committedIds?: ReadonlySet<string>) {
    if (!usesSingleSourceLocalPersistence()) return false;
    const legacy = desktopLegacyAssetCaches.get(scope);
    if (!legacy) return false;
    if (legacy.hasInvalidRecords) {
        console.warn("旧版素材缓存存在隔离的历史损坏记录，保留旧缓存以免丢数据", { scope });
        return false;
    }
    const uncovered = legacy.assetIds.filter((id) => {
        if (committedIds?.has(id) || isDeletedGenerationAsset(scope, id)) return false;
        const draft = peekAssetStoreDraft(scope, id);
        if (!draft) return true;
        if (draft.kind === "delete") return false;
        return !draft.asset;
    });
    if (uncovered.length > 0) {
        console.warn("旧版素材缓存仍有未被 SQLite 或完整草稿覆盖的记录，保留旧缓存", { scope, uncoveredCount: uncovered.length });
        return false;
    }
    if (legacy.deletedGenerationIds.length) {
        await hydrateAssetStoreDrafts(scope);
        recordDeletedGenerationAssetIds(scope, legacy.deletedGenerationIds);
    }
    retryFailedAssetStoreDraftPersist(scope);
    await flushAssetStoreDraftWrites(scope);
    await localForageStorageForScope(scope).removeItem(ASSET_STORE_KEY);
    desktopLegacyAssetCaches.delete(scope);
    return true;
}

export async function flushAssetStorePersistence() {
    const scope = getActiveUserScope();

    while (true) {
        if (assetOperations.size) {
            await Promise.all([...assetOperations]);
            continue;
        }

        const queued = queuedAssetPersists.get(scope);
        if (queued) {
            await writeQueuedAssetPersist(queued.scope);
            continue;
        }

        await flushGenerationAssetStorageLocks();
        if (!assetOperations.size && !queuedAssetPersists.has(scope)) break;
    }

    await flushAssetStoreDraftWrites(scope);

    const failure = generationFailureFor(scope);
    if (failure !== undefined) throw failure;
}

export function hasActiveAssetStorePersistence() {
    // queuedAssetPersists can retain a failed save for explicit retry. Active
    // operations cover running and lock-waiting writes, including draft IO.
    return assetOperations.size > 0 || hasActiveAssetStoreDraftWrites();
}

export async function normalizePersistedAsset(asset: Asset): Promise<Asset> {
    asset = parseAssetRecord(asset);
    const storageKey = "data" in asset && asset.data && "storageKey" in asset.data ? asset.data.storageKey : undefined;
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (resourceId) {
        const url = resourceFileUrl(resourceId);
        if (asset.kind === "video" || asset.kind === "audio" || asset.kind === "model") return { ...asset, data: { ...asset.data, url } } as Asset;
        if (asset.kind === "image") return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? url : asset.coverUrl, data: { ...asset.data, dataUrl: url } };
    }

    // 非 resource: key 是早期本地存储格式，必须继续从 localForage 恢复，
    // 但只在确有本地 key 时读取，不让远程资源重新走逐条网络查询。
    if (asset.kind === "video" && storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(storageKey, asset.data.url) } };
    if (asset.kind === "audio" && storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(storageKey, asset.data.url) } };
    if (asset.kind === "model" && storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(storageKey, asset.data.url) } };
    if (asset.kind !== "image") return asset;
    if (storageKey) {
        return {
            ...asset,
            coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(storageKey, asset.coverUrl) : asset.coverUrl,
            data: { ...asset.data, dataUrl: await resolveImageUrl(storageKey, asset.data.dataUrl) },
        };
    }
    if (!asset.data.dataUrl.startsWith("data:image/")) return asset;
    const image = await uploadImage(asset.data.dataUrl);
    return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
}

export const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const scope = getActiveUserScope();
        const value = await localForageStorageForScope(scope).getItem(name);
        if (!value) {
            desktopLegacyAssetCaches.delete(scope);
            assetMemoryStates.set(scope, { assets: [] });
            observedAssetPersists.set(scope, { assets: [], revision: 0 });
            return null;
        }
        const recovery = parseAssetStorageDocumentRecovering(value);
        if (recovery.invalid.length) {
            console.warn("素材本地缓存包含无法恢复的历史记录，已隔离并保留其诊断信息", {
                scope,
                invalid: recovery.invalid,
            });
        }
        const document = recovery.document;
        if (usesSingleSourceLocalPersistence()) {
            // Capture legacy tombstones in memory only; never persist into ASSET_STORE_DRAFTS_KEY
            // before hydrateAssetStoreDrafts merges existing durable drafts and clocks.
            desktopLegacyAssetCaches.set(scope, {
                assetIds: document.state.assets.map((asset) => asset.id),
                deletedGenerationIds: Object.keys(document.tombstones.assets || {}).filter((id) => id.startsWith("generation_")),
                hasInvalidRecords: recovery.invalid.length > 0,
            });
        }
        // 持久化恢复只恢复结构化记录，不能为每个 resource: key 逐条读取资源元数据或 Blob。
        // 远程资源直接使用受鉴权的 file URL；本地 legacy key 仍恢复为 Blob URL，避免兼容性回归。
        // 单张本地图片被系统清理时只影响该条记录，不能拒绝整个 getItem，
        // 否则 zustand persist 恢复失败，用户会看到整个素材库消失。
        const assets = await Promise.all(document.state.assets.map(async (asset) => {
            try {
                return await normalizePersistedAsset(asset);
            } catch (error) {
                console.warn("素材本地缓存中的媒体已不可用，已保留该记录", {
                    scope,
                    assetId: asset.id,
                    error: error instanceof Error ? error.message : String(error),
                });
                return asset;
            }
        }));
        const hydratedDocument = { ...document, state: { assets } };
        assetMemoryStates.set(scope, { assets });
        recordAssetStorageDocument(scope, hydratedDocument);
        return hydratedDocument as unknown as StorageValue<AssetStore>;
    },
    setItem: persistAssetState,
    removeItem: (name) => {
        const scope = getActiveUserScope();
        desktopLegacyAssetCaches.delete(scope);
        return localForageStorageForScope(scope).removeItem(name);
    },
};
