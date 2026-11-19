import { purgeLegacyResourceBlobIndexedDB } from "@/lib/diagnostics-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { getResourceBlob, resourceIdFromStorageKey } from "@/services/api/resources";
import { createCanvasImagePreviewBlob } from "@/lib/canvas/canvas-image-preview-blob";
import { canUseSameOriginResourceAsset, resourcePreviewAssetUrl } from "@/services/media-asset-url";

export { purgeLegacyResourceBlobIndexedDB };

/**
 * Bounded in-memory LRU cache for callers that genuinely need raw Blob bytes
 * (reference uploads, browser-only zip exports, or fallback when direct
 * same-origin asset serving is unavailable).
 *
 * Backend-hosted resources are NEVER mirrored into IndexedDB: the local Go
 * backend (`data/resources/` + `data/cache/previews/`) is the single source
 * of truth on disk. Browser-local mode (`image_files` / `media_files`) is
 * untouched and lives in `local-image-repository` / `local-media-repository`.
 */
type MemoryEntry = {
    key: string;
    blob: Blob;
    bytes: number;
    url?: string;
};

const MAX_MEMORY_BYTES = 128 * 1024 * 1024;
const MAX_MEMORY_ENTRIES = 128;
const MAX_CONCURRENT_DOWNLOADS = 4;

const memoryCache = new Map<string, MemoryEntry>();
let memoryBytes = 0;

const inFlight = new Map<string, Promise<string>>();
const downloadQueue: Array<{ key?: string; run: () => void }> = [];
let activeDownloads = 0;
let imagePreviewQueue: Promise<unknown> = Promise.resolve();

function cacheKeyFor(storageKey: string, version = "file") {
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (!resourceId) return "";
    return `${getActiveUserScope()}:${resourceId}:${version}`;
}

function touchEntry(key: string): MemoryEntry | undefined {
    const entry = memoryCache.get(key);
    if (!entry) return undefined;
    memoryCache.delete(key);
    memoryCache.set(key, entry);
    return entry;
}

function deleteEntry(key: string) {
    const entry = memoryCache.get(key);
    if (!entry) return;
    memoryCache.delete(key);
    memoryBytes = Math.max(0, memoryBytes - entry.bytes);
    if (entry.url) {
        URL.revokeObjectURL(entry.url);
    }
}

function storeEntry(key: string, blob: Blob, replaceUrl = false): string {
    const existing = memoryCache.get(key);
    if (existing) {
        if (!replaceUrl && existing.blob === blob && existing.url) {
            touchEntry(key);
            return existing.url;
        }
        deleteEntry(key);
    }
    const bytes = Math.max(0, blob.size || 0);
    // Do not evict the whole cache for a single giant blob (> half budget);
    // return an ephemeral object URL without retaining the blob in LRU memory.
    if (bytes > MAX_MEMORY_BYTES / 2) {
        return URL.createObjectURL(blob);
    }
    evictForBudget(bytes);
    const url = URL.createObjectURL(blob);
    memoryCache.set(key, { key, blob, bytes, url });
    memoryBytes += bytes;
    return url;
}

function evictForBudget(incomingBytes: number) {
    while (memoryCache.size > 0 && (memoryBytes + incomingBytes > MAX_MEMORY_BYTES || memoryCache.size >= MAX_MEMORY_ENTRIES)) {
        const oldestKey = memoryCache.keys().next().value;
        if (oldestKey === undefined) break;
        deleteEntry(oldestKey);
    }
}

export function clearResourceMemoryCache() {
    for (const entry of memoryCache.values()) {
        if (entry.url) URL.revokeObjectURL(entry.url);
    }
    memoryCache.clear();
    memoryBytes = 0;
}

export function resourceMemoryCacheStats() {
    return { entries: memoryCache.size, bytes: memoryBytes, maxBytes: MAX_MEMORY_BYTES };
}

export function primeResourceImagePreviewForTests(storageKey: string, maxSize: number, blob: Blob) {
    const key = cacheKeyFor(storageKey, `preview-${maxSize}`);
    if (!key) return "";
    return storeEntry(key, blob, true);
}

export async function getCachedResourceObjectUrl(storageKey: string) {
    const key = cacheKeyFor(storageKey);
    if (!key) return "";
    const entry = touchEntry(key);
    if (!entry) return "";
    if (!entry.url) entry.url = URL.createObjectURL(entry.blob);
    return entry.url;
}

export async function cacheResourceImagePreviewObjectUrl(storageKey: string, maxSize: number, reload = false) {
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (!resourceId) return "";
    if (canUseSameOriginResourceAsset()) {
        return resourcePreviewAssetUrl(resourceId, maxSize, "preserve", reload ? Date.now() : undefined);
    }
    if (![128, 256, 512, 1024, 2048].includes(maxSize)) return "";
    const key = cacheKeyFor(storageKey, `preview-${maxSize}`);
    if (!reload) {
        const hit = touchEntry(key);
        if (hit?.url) return hit.url;
    }
    const pending = inFlight.get(key);
    if (pending) return pending;

    const task = imagePreviewQueue
        .catch(() => undefined)
        .then(async () => {
            if (typeof window !== "undefined") {
                await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
            }
            const original = await getCachedResourceBlob(storageKey, false);
            if (!original) return "";
            const preview = await createCanvasImagePreviewBlob(original, maxSize);
            if (preview === original) return storeEntry(cacheKeyFor(storageKey), original, reload);
            return storeEntry(key, preview, reload);
        })
        .catch((error) => {
            console.warn("图片预览生成失败，保留原图显示", { resourceId, error });
            return cacheResourceObjectUrl(storageKey, reload);
        })
        .finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    imagePreviewQueue = task;
    return task;
}

/** 同步读取本会话内存中的 Blob URL，仅在真实内存命中时返回（不伪装未加载的直连预览为已缓存）。 */
export function peekCachedResourceObjectUrl(storageKey: string, previewSize?: number) {
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (!resourceId) return "";
    if (previewSize && [128, 256, 512, 1024, 2048].includes(previewSize)) {
        return memoryCache.get(cacheKeyFor(storageKey, `preview-${previewSize}`))?.url || "";
    }
    return memoryCache.get(cacheKeyFor(storageKey))?.url || "";
}

export function peekFallbackResourceImagePreviewUrl(storageKey: string, previewSize?: number) {
    const exact = peekCachedResourceObjectUrl(storageKey, previewSize);
    if (exact) return exact;
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (!resourceId) return "";
    const maxCandidate = previewSize || 2048;
    for (const tier of [2048, 1024, 512, 256, 128]) {
        if (tier >= maxCandidate) continue;
        const hit = memoryCache.get(cacheKeyFor(storageKey, `preview-${tier}`));
        if (hit?.url) return hit.url;
    }
    return "";
}

export async function cacheResourceObjectUrl(storageKey: string, reload = false, priority = false) {
    const key = cacheKeyFor(storageKey);
    if (!key) return "";
    if (reload) {
        await inFlight.get(key)?.catch(() => undefined);
        const blob = await withDownloadSlot(() => getResourceBlob(storageKey), priority);
        if (!blob) return "";
        return storeEntry(key, blob, true);
    }
    const hit = touchEntry(key);
    if (hit?.url) return hit.url;

    const pending = inFlight.get(key);
    if (pending) {
        if (priority) {
            const index = downloadQueue.findIndex((job) => job.key === key);
            if (index > 0) downloadQueue.unshift(...downloadQueue.splice(index, 1));
        }
        return pending;
    }

    const task = withDownloadSlot(async () => {
        const blob = await getResourceBlob(storageKey);
        if (!blob) return "";
        return storeEntry(key, blob);
    }, priority, key).finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
}

/**
 * Retired: video/audio streams directly over loopback HTTP Range tickets
 * instead of mirroring multi-hundred-MB files into browser memory or IndexedDB.
 */
export function scheduleResourceBlobCache(_storageKey: string, _delayMs = 4_000) {
    // Intentionally no-op.
}

function withDownloadSlot<T>(task: () => Promise<T>, priority = false, key?: string) {
    return new Promise<T>((resolve, reject) => {
        const job = () => {
            activeDownloads += 1;
            task().then(resolve, reject).finally(() => {
                activeDownloads -= 1;
                runDownloadQueue();
            });
        };
        if (priority) downloadQueue.unshift({ key, run: job });
        else downloadQueue.push({ key, run: job });
        runDownloadQueue();
    });
}

function runDownloadQueue() {
    while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length) downloadQueue.shift()?.run();
}

export async function primeResourceBlobCache(storageKey: string, blob: Blob) {
    const key = cacheKeyFor(storageKey);
    if (!key) return "";
    // Do not pin huge videos in memory right after upload; Go disk storage serves them via Range.
    if (blob.size > 16 * 1024 * 1024) return "";
    return storeEntry(key, blob);
}

export async function getCachedResourceBlob(storageKey: string, priority = true) {
    const key = cacheKeyFor(storageKey);
    if (!key) return null;
    const hit = touchEntry(key);
    if (hit) return hit.blob;
    const url = await cacheResourceObjectUrl(storageKey, false, priority);
    const loaded = touchEntry(key);
    if (loaded) return loaded.blob;
    // Large blobs (> half budget) bypassed LRU storage; fetch directly without pinning.
    if (url.startsWith("blob:")) {
        try {
            const response = await fetch(url);
            return await response.blob();
        } finally {
            URL.revokeObjectURL(url);
        }
    }
    return null;
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", (event) => {
        if (event.persisted) return;
        clearResourceMemoryCache();
    });
}
