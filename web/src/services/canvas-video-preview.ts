import { onStorageNamespaceChange } from "@/lib/user-scope";
import { captureVideoPoster } from "@/lib/video-poster";
import { ownedResourceIdFromMediaRef, resourceIdFromStorageKey } from "@/services/api/resources";
import { acquireCanvasVideoSource } from "@/services/canvas-video-source";
import { canUseSameOriginResourceAsset, resourcePosterAssetUrl } from "@/services/media-asset-url";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type VideoPreview = NonNullable<CanvasNodeMetadata["videoPreview"]>;
type VideoPreviewSource = Pick<CanvasNodeData, "metadata">;
type CachedPoster = { poster: Blob; meta: Omit<VideoPreview, "content"> };

export const CANVAS_VIDEO_PREVIEW_VERSION = 2;

export function canvasDerivedPreviewSourceKey(node: VideoPreviewSource) {
    return JSON.stringify([node.metadata?.storageKey || "", node.metadata?.content || "", node.metadata?.importSource?.provider || ""]);
}

type PreviewEntry = { refs: number; controller: AbortController; url?: string; promise: Promise<VideoPreview | null> };
const previewRequests = new Map<string, PreviewEntry>();
const posterBlobCache = new Map<string, CachedPoster>();
const posterReadyListeners = new Map<string, Set<() => void>>();
const MAX_ACTIVE_PREVIEWS = 32;
let posterTimeoutOverrideMs: number | null = null;
onStorageNamespaceChange(() => posterBlobCache.clear());

export function setCanvasVideoPosterTimeoutForTests(timeoutMs: number | null) {
    posterTimeoutOverrideMs = timeoutMs;
}

export function subscribeCanvasVideoPosterReady(node: VideoPreviewSource, listener: () => void) {
    const requestKey = canvasDerivedPreviewSourceKey(node);
    let listeners = posterReadyListeners.get(requestKey);
    if (!listeners) {
        listeners = new Set();
        posterReadyListeners.set(requestKey, listeners);
    }
    listeners.add(listener);
    return () => {
        const current = posterReadyListeners.get(requestKey);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) posterReadyListeners.delete(requestKey);
    };
}

function notifyCanvasVideoPosterReady(requestKey: string) {
    const listeners = posterReadyListeners.get(requestKey);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
        listener();
    }
}
const MAX_CONCURRENT_PREVIEW_SOURCES = 2;
let activePreviewSources = 0;
const previewSourceQueue: Array<() => void> = [];

function acquirePreviewSourceSlot(signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (activePreviewSources < MAX_CONCURRENT_PREVIEW_SOURCES) {
        activePreviewSources += 1;
        return Promise.resolve(releasePreviewSourceSlot);
    }
    return new Promise<() => void>((resolve, reject) => {
        const grant = () => {
            signal?.removeEventListener("abort", onAbort);
            resolve(releasePreviewSourceSlot);
        };
        const onAbort = () => {
            const idx = previewSourceQueue.indexOf(grant);
            if (idx >= 0) previewSourceQueue.splice(idx, 1);
            reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        previewSourceQueue.push(grant);
    });
}

function releasePreviewSourceSlot() {
    const next = previewSourceQueue.shift();
    if (next) next();
    else activePreviewSources = Math.max(0, activePreviewSources - 1);
}

function disposeEntry(key: string, entry: PreviewEntry) {
    entry.controller.abort();
    if (entry.url) URL.revokeObjectURL(entry.url);
    if (previewRequests.get(key) === entry) previewRequests.delete(key);
}

/** Display-only leases: never upload a poster or mutate the durable canvas. */
export function acquireCanvasVideoPreview(node: VideoPreviewSource) {
    const sourceKey = node.metadata?.storageKey || node.metadata?.content || "";
    const requestKey = canvasDerivedPreviewSourceKey(node);
    let entry = previewRequests.get(requestKey);
    if (!entry && sourceKey && previewRequests.size < MAX_ACTIVE_PREVIEWS) {
        const controller = new AbortController();
        const created: PreviewEntry = { refs: 0, controller, promise: Promise.resolve(null) };
        const forgetFailedRequest = () => {
            // Existing consumers still own their leases; never remove a newer retry.
            if (previewRequests.get(requestKey) === created) previewRequests.delete(requestKey);
        };
        created.promise = generateCanvasVideoPreview(node, requestKey, controller.signal).then((preview) => {
            if (!preview) { forgetFailedRequest(); return null; }
            if (controller.signal.aborted) { URL.revokeObjectURL(preview.content); return null; }
            created.url = preview.content;
            return preview;
        }).catch(() => { forgetFailedRequest(); return null; });
        entry = created;
        previewRequests.set(requestKey, entry);
    }
    if (entry) entry.refs += 1;
    const leased = entry;
    let released = false;
    return { promise: entry?.promise || Promise.resolve(null), release() {
        if (released || !leased) return;
        released = true;
        if (--leased.refs === 0) disposeEntry(requestKey, leased);
    } };
}

export function resolveServerVideoPosterUrl(node: VideoPreviewSource): string {
    if (!canUseSameOriginResourceAsset()) return "";
    const resourceId = ownedResourceIdFromMediaRef(node.metadata?.storageKey, node.metadata?.content);
    return resourceId ? resourcePosterAssetUrl(resourceId) : "";
}

export function canvasVideoPreviewNeedsHydration(node: VideoPreviewSource, options?: { ignoreServerPoster?: boolean }) {
    if (!options?.ignoreServerPoster && resolveServerVideoPosterUrl(node)) return false;
    const sourceKey = canvasVideoPreviewSourceKey(node);
    if (!sourceKey) return false;
    const preview = node.metadata?.videoPreview;
    return !preview?.content || preview.captureVersion !== CANVAS_VIDEO_PREVIEW_VERSION || preview.sourceKey !== sourceKey;
}

export function hasCachedCanvasVideoPreview(node: VideoPreviewSource) {
    const requestKey = canvasDerivedPreviewSourceKey(node);
    return posterBlobCache.has(requestKey) || Boolean(previewRequests.get(requestKey)?.url);
}

export function getCachedCanvasVideoPreviewBlob(node: VideoPreviewSource) {
    const requestKey = canvasDerivedPreviewSourceKey(node);
    return posterBlobCache.get(requestKey)?.poster || null;
}

/**
 * Capture a one-shot poster Object URL backed by the shared poster cache,
 * 2-slot `acquirePreviewSourceSlot` semaphore, and single-decoder `captureVideoPoster`
 * queue. Queue wait is bounded only by the caller's AbortSignal; `timeoutMs` starts
 * after a source slot is granted so large coverless grids never drop or starve cards.
 */
export async function captureCanvasVideoPosterBlobUrl(
    node: VideoPreviewSource,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
    const { signal, timeoutMs = posterTimeoutOverrideMs ?? 8_000 } = options;
    throwIfAborted(signal);
    const requestKey = canvasDerivedPreviewSourceKey(node);
    const cached = touchCachedPoster(requestKey);
    if (cached) return URL.createObjectURL(cached.poster);
    const inFlight = previewRequests.get(requestKey);
    if (inFlight) {
        const result = await awaitWithAbort(inFlight.promise, signal, timeoutMs);
        throwIfAborted(signal);
        const blob = result && getCachedCanvasVideoPreviewBlob(node);
        if (blob) return URL.createObjectURL(blob);
    }
    const captured = await capturePosterWithSharedSlot(node, requestKey, signal, timeoutMs);
    throwIfAborted(signal);
    return captured ? URL.createObjectURL(captured.poster) : "";
}

async function generateCanvasVideoPreview(node: VideoPreviewSource, requestKey: string, signal?: AbortSignal): Promise<VideoPreview | null> {
    const cached = touchCachedPoster(requestKey);
    if (cached) {
        await Promise.resolve();
        throwIfAborted(signal);
        return { ...cached.meta, content: URL.createObjectURL(cached.poster) };
    }
    const captured = await capturePosterWithSharedSlot(node, requestKey, signal);
    if (!captured) return null;
    return {
        ...captured.meta,
        content: URL.createObjectURL(captured.poster),
    };
}

function touchCachedPoster(requestKey: string): CachedPoster | undefined {
    const cached = posterBlobCache.get(requestKey);
    if (!cached) return undefined;
    posterBlobCache.delete(requestKey);
    posterBlobCache.set(requestKey, cached);
    return cached;
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal, timeoutMs = 0): Promise<T> {
    if (!signal && timeoutMs <= 0) return promise;
    if (signal?.aborted) return Promise.reject(abortError());
    let onAbort: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError());
        signal?.addEventListener("abort", onAbort, { once: true });
        if (timeoutMs > 0) {
            timer = setTimeout(() => reject(new DOMException("Video poster timed out", "TimeoutError")), timeoutMs);
        }
    });
    return Promise.race([promise, bounded]).finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    });
}

async function acquireTimedVideoSource(
    storageKey: string | undefined,
    fallback: string,
    signal?: AbortSignal,
    needsCompatible = false,
    timeoutMs = 0,
) {
    if (timeoutMs <= 0) {
        return acquireCanvasVideoSource(storageKey, fallback, signal, needsCompatible);
    }
    throwIfAborted(signal);
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(signal?.reason ?? abortError());
    signal?.addEventListener("abort", onParentAbort, { once: true });
    const deadline = setTimeout(
        () => controller.abort(new DOMException("Video poster timed out", "TimeoutError")),
        timeoutMs,
    );
    try {
        return await acquireCanvasVideoSource(storageKey, fallback, controller.signal, needsCompatible);
    } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", onParentAbort);
    }
}

async function capturePosterWithSharedSlot(
    node: VideoPreviewSource,
    requestKey: string,
    signal?: AbortSignal,
    workTimeoutMs = 0,
): Promise<CachedPoster | null> {
    await waitForBrowserIdle(signal);
    const releaseSlot = await acquirePreviewSourceSlot(signal);
    let captured: Awaited<ReturnType<typeof captureVideoPoster>>;
    try {
        throwIfAborted(signal);
        const cached = touchCachedPoster(requestKey);
        if (cached) return cached;
        const storageKey = node.metadata?.storageKey;
        const fallback = node.metadata?.content || "";
        // Bound source acquisition and active decoding separately so neither
        // the 2-slot source queue nor captureVideoPoster's single-decoder queue
        // consumes the active work timeout budget.
        const source = await acquireTimedVideoSource(storageKey, fallback, signal, false, workTimeoutMs);
        if (!source.url) { source.release(); return null; }
        let firstError: unknown;
        try {
            captured = await captureVideoPoster(source.url, {
                signal,
                maxWidth: 400,
                timeoutMs: workTimeoutMs > 0 ? workTimeoutMs : undefined,
            });
        } catch (error) {
            firstError = error;
            captured = { width: 0, height: 0, capturedAtMs: 0 };
        } finally {
            source.release();
        }
        if (!captured.poster) {
            throwIfAborted(signal);
            if (!resourceIdFromStorageKey(storageKey)) {
                if (firstError) throw firstError;
                return null;
            }
            const compatibleSource = await acquireTimedVideoSource(storageKey, fallback, signal, true, workTimeoutMs);
            if (!compatibleSource.url) { compatibleSource.release(); return null; }
            try {
                captured = await captureVideoPoster(compatibleSource.url, {
                    signal,
                    maxWidth: 400,
                    timeoutMs: workTimeoutMs > 0 ? workTimeoutMs : undefined,
                });
            } finally {
                compatibleSource.release();
            }
        }
    } finally {
        releaseSlot();
    }
    throwIfAborted(signal);
    if (!captured.poster) return null;
    const meta: Omit<VideoPreview, "content"> = {
        width: captured.width,
        height: captured.height,
        bytes: captured.poster.size,
        mimeType: captured.poster.type,
        captureVersion: CANVAS_VIDEO_PREVIEW_VERSION,
        sourceKey: canvasVideoPreviewSourceKey(node),
        capturedAtMs: captured.capturedAtMs,
    };
    if (posterBlobCache.has(requestKey)) posterBlobCache.delete(requestKey);
    else if (posterBlobCache.size >= MAX_ACTIVE_PREVIEWS) {
        const oldestKey = posterBlobCache.keys().next().value;
        if (oldestKey !== undefined) posterBlobCache.delete(oldestKey);
    }
    const entry: CachedPoster = { poster: captured.poster, meta };
    posterBlobCache.set(requestKey, entry);
    notifyCanvasVideoPosterReady(requestKey);
    return entry;
}

function canvasVideoPreviewSourceKey(node: VideoPreviewSource) {
    return node.metadata?.storageKey || node.metadata?.content || "";
}

function waitForBrowserIdle(signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        let idleId: number | undefined;
        let timerId: ReturnType<typeof globalThis.setTimeout> | undefined;
        const idleWindow = window as unknown as {
            requestIdleCallback?: Window["requestIdleCallback"];
            cancelIdleCallback?: Window["cancelIdleCallback"];
        };
        const cleanup = () => {
            signal?.removeEventListener("abort", handleAbort);
            if (idleId !== undefined) idleWindow.cancelIdleCallback?.(idleId);
            if (timerId !== undefined) globalThis.clearTimeout(timerId);
        };
        const finish = () => {
            cleanup();
            resolve();
        };
        const handleAbort = () => {
            cleanup();
            reject(abortError());
        };
        signal?.addEventListener("abort", handleAbort, { once: true });
        if (idleWindow.requestIdleCallback) idleId = idleWindow.requestIdleCallback(finish, { timeout: 1_000 });
        else timerId = globalThis.setTimeout(finish, 250);
    });
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortError();
}

function abortError() {
    return new DOMException("Canvas video preview hydration aborted", "AbortError");
}
