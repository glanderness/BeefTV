import { captureVideoPoster } from "@/lib/video-poster";
import { acquireCanvasVideoSource } from "@/services/canvas-video-source";
import { captureUserScopeEpoch, subscribeUserScope, userScopeEpochMatches } from "@/lib/user-scope";
import { recordCanvasVideoPreviewDiagnostic } from "@/services/diagnostics/canvas-media-diagnostics";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type VideoPreview = NonNullable<CanvasNodeMetadata["videoPreview"]>;
type VideoPreviewSource = Pick<CanvasNodeData, "metadata"> & { id?: string };

export const CANVAS_VIDEO_PREVIEW_VERSION = 2;
/**
 * 刚生成完的视频偶尔还在落盘或解码准备中，第一次取帧会落空（或只画出一张黑图）。
 * 以前这种落空只算一次失败，同一个节点要等重新打开画布才再试，表现就是“一直没有首帧”。
 * 所以同一次请求里补一次，两次之间等一小段让资源就绪。
 */
const PREVIEW_CAPTURE_ATTEMPTS = 2;
const PREVIEW_RETRY_DELAY_MS = 400;

export function canvasDerivedPreviewSourceKey(node: VideoPreviewSource) {
    return JSON.stringify([node.metadata?.storageKey || "", node.metadata?.content || "", node.metadata?.importSource?.provider || ""]);
}

type PreviewEntry = { refs: number; controller: AbortController; url?: string; promise: Promise<VideoPreview | null> };
const previewRequests = new Map<string, PreviewEntry>();
const MAX_ACTIVE_PREVIEWS = 32;

function disposeEntry(key: string, entry: PreviewEntry) {
    entry.controller.abort();
    if (entry.url) URL.revokeObjectURL(entry.url);
    if (previewRequests.get(key) === entry) previewRequests.delete(key);
}

subscribeUserScope(() => {
    for (const [key, entry] of previewRequests) disposeEntry(key, entry);
});

/** Display-only leases: never upload a poster or mutate the durable canvas. */
export function acquireCanvasVideoPreview(node: VideoPreviewSource) {
    const epoch = captureUserScopeEpoch();
    const sourceKey = node.metadata?.storageKey || node.metadata?.content || "";
    const requestKey = JSON.stringify([epoch.scope, epoch.generation, canvasDerivedPreviewSourceKey(node)]);
    let entry = previewRequests.get(requestKey);
    if (!entry && sourceKey && previewRequests.size < MAX_ACTIVE_PREVIEWS) {
        const controller = new AbortController();
        const created: PreviewEntry = { refs: 0, controller, promise: Promise.resolve(null) };
        const forgetFailedRequest = () => {
            // Existing consumers still own their leases; never remove a newer retry.
            if (previewRequests.get(requestKey) === created) previewRequests.delete(requestKey);
        };
        created.promise = generateCanvasVideoPreview(node, controller.signal).then((preview) => {
            if (!preview) { forgetFailedRequest(); return null; }
            if (controller.signal.aborted || !userScopeEpochMatches(epoch)) { URL.revokeObjectURL(preview.content); return null; }
            created.url = preview.content;
            return preview;
        }).catch(() => { forgetFailedRequest(); return null; });
        entry = created;
        previewRequests.set(requestKey, entry);
    }
    if (entry) entry.refs += 1;
    else if (sourceKey) recordCanvasVideoPreviewDiagnostic(node, "capacity_exhausted");
    const leased = entry;
    let released = false;
    return { promise: entry?.promise || Promise.resolve(null), release() {
        if (released || !leased) return;
        released = true;
        if (--leased.refs === 0) disposeEntry(requestKey, leased);
    } };
}

export function canvasVideoPreviewNeedsHydration(node: VideoPreviewSource) {
    const sourceKey = canvasVideoPreviewSourceKey(node);
    if (!sourceKey) return false;
    const preview = node.metadata?.videoPreview;
    return !preview?.content || preview.captureVersion !== CANVAS_VIDEO_PREVIEW_VERSION || preview.sourceKey !== sourceKey;
}

async function generateCanvasVideoPreview(node: VideoPreviewSource, signal?: AbortSignal): Promise<VideoPreview | null> {
    for (let attempt = 0; attempt < PREVIEW_CAPTURE_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await waitForRetry(signal);
        await waitForBrowserIdle(signal);
        throwIfAborted(signal);
        const source = await acquireCanvasVideoSource(node.metadata?.storageKey, node.metadata?.content || "", signal);
        if (!source.url) {
            // 取不到可播放的地址时再试一次也一样，留给下次打开画布重试。
            source.release();
            recordCanvasVideoPreviewDiagnostic(node, "source_missing");
            return null;
        }
        let captured: Awaited<ReturnType<typeof captureVideoPoster>>;
        try {
            captured = await captureVideoPoster(source.url, { signal, maxWidth: 400, rejectBlankFrame: true });
        } catch (error) {
            if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
            recordCanvasVideoPreviewDiagnostic(node, "capture_failed", error);
            throw error;
        } finally {
            source.release();
        }
        throwIfAborted(signal);
        if (!captured.poster) continue;
        return {
            content: URL.createObjectURL(captured.poster),
            width: captured.width,
            height: captured.height,
            bytes: captured.poster.size,
            mimeType: captured.poster.type,
            captureVersion: CANVAS_VIDEO_PREVIEW_VERSION,
            sourceKey: canvasVideoPreviewSourceKey(node),
            capturedAtMs: captured.capturedAtMs,
        };
    }
    recordCanvasVideoPreviewDiagnostic(node, "capture_empty");
    return null;
}

function waitForRetry(signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const handleAbort = () => {
            globalThis.clearTimeout(timer);
            reject(abortError());
        };
        const timer = globalThis.setTimeout(() => {
            signal?.removeEventListener("abort", handleAbort);
            resolve();
        }, PREVIEW_RETRY_DELAY_MS);
        signal?.addEventListener("abort", handleAbort, { once: true });
    });
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
