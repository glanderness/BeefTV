import { captureVideoPoster } from "@/lib/video-poster";
import { acquireCanvasVideoSource } from "@/services/canvas-video-source";
import { captureUserScopeEpoch, subscribeUserScope, userScopeEpochMatches } from "@/lib/user-scope";
import { recordCanvasVideoPreviewDiagnostic } from "@/services/diagnostics/canvas-media-diagnostics";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type VideoPreview = NonNullable<CanvasNodeMetadata["videoPreview"]>;
type VideoPreviewSource = Pick<CanvasNodeData, "metadata"> & { id?: string };

export const CANVAS_VIDEO_PREVIEW_VERSION = 2;
/**
 * 需求 #113：生成出来的视频节点在 Mac 客户端里只有黑底和播放按钮。
 *
 * 在本机 2.0.3 客户端（这段代码与当时一致）里能看到的事实：
 * 1. 这些节点 metadata.videoPreview 一直是空的，封面只能来自这条显示时取帧的路径；
 * 2. 出问题那张截图里该节点整块是纯 (0,0,0)、没有占位文字，尺寸正好等于节点框；
 *    占位卡片是 #262626 加标题和提示文字的，所以当时显示的不是占位，而是一张全黑的封面图；
 * 3. 那个视频自己的首帧是蓝色（约 RGB 51,74,97），不可能是这张黑图；
 * 4. 同一个节点现在在这台客户端上打开显示正常，而数据库里 videoPreview 仍为空——
 *    说明它的封面确实就是显示时现取、只存在内存里的 blob。
 *
 * 当时为什么会取出一张全黑封面，只能当假设：取帧代码先 fillRect(#000) 再 drawImage，
 * 如果 requestVideoFrameCallback 已经触发、画面却还没进可绘制的缓冲，留下的就是这张黑底。
 * 这属于事后无法复现的推断，下面的诊断事件就是为了下次复现时能分开
 * 「没触发 / 取不到地址 / 取帧失败 / 取到空结果」这几种情况。
 *
 * 因此这里只补两件有把握的事：同一次请求里重试一次，以及把失败原因记进诊断。
 * 画面内容是黑是亮一律不判断，合法的黑场封面要照常留下。
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
            captured = await captureVideoPoster(source.url, { signal, maxWidth: 400 });
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
