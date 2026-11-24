import { refreshResource, prepareResourcePlayback, getResourcePlayback, ownedResourceStorageKey, resourceIdFromStorageKey, type ResourcePlayback } from "@/services/api/resources";
import { resolveMediaUrl } from "@/services/file-storage";
import { canUseLoopbackMediaTicket, resolveResourceMediaStream } from "@/services/media-asset-url";

export type ResourcePlaybackStream = {
    url: string;
    compatible: boolean;
    mode: "loopback-ticket" | "same-origin-fallback";
    expiresAtMs?: number;
};

export type ResolvedVideoPlayback = string | ResourcePlayback | ResourcePlaybackStream;

export async function resolveResourceVideoPlayback(
    storageKey: string,
    fallback: string,
    signal: AbortSignal,
    needsCompatible = false,
): Promise<ResolvedVideoPlayback> {
    const effectiveKey = ownedResourceStorageKey(storageKey, fallback);
    const id = resourceIdFromStorageKey(effectiveKey);
    if (id) {
        let resource = await refreshResource(id, { signal });
        if (resource) {
            if (needsCompatible && resource.playbackStatus !== "processing") {
                resource = await prepareResourcePlayback(id, { signal });
            }
            for (let attempt = 0; resource?.playbackStatus === "processing"; attempt += 1) {
                if (attempt >= 120) throw new Error("视频预览仍在准备中，请稍后重新打开");
                await waitForPlaybackPoll(signal);
                resource = await refreshResource(id, { signal });
            }
            if (resource?.playbackStatus === "ready") {
                if (canUseLoopbackMediaTicket()) {
                    const stream = await tryResolveMediaStream(id, "playback", signal);
                    if (stream) return stream;
                }
                const playback = await getResourcePlayback(effectiveKey, { signal });
                if (!playback) throw new Error("视频预览不可用，请重试");
                return playback;
            }
            if (needsCompatible && resource?.playbackStatus !== "ready") {
                throw new Error("视频已导入，暂时无法准备预览，请重试。原文件仍可下载。");
            }
        }
        if (canUseLoopbackMediaTicket()) {
            const originalStream = await tryResolveMediaStream(id, "original", signal);
            if (originalStream) return originalStream;
        }
    }
    const url = await resolveMediaUrl(effectiveKey, fallback, { renderable: true });
    if (signal.aborted) throw signal.reason;
    return url;
}

async function tryResolveMediaStream(
    resourceId: string,
    variant: "original" | "playback",
    signal: AbortSignal,
): Promise<ResourcePlaybackStream | null> {
    if (!canUseLoopbackMediaTicket()) return null;
    try {
        const stream = await resolveResourceMediaStream(resourceId, variant, { signal });
        if (signal.aborted) throw signal.reason;
        if (!stream?.url) return null;
        return {
            url: stream.url,
            compatible: stream.compatible,
            mode: stream.mode,
            expiresAtMs: stream.expiresAtMs,
        };
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (signal.aborted) throw signal.reason;
        // Fallback for older servers or unit tests that only mock `/file`.
        return null;
    }
}

function waitForPlaybackPoll(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); reject(signal.reason); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, 2500);
        signal.addEventListener("abort", abort, { once: true });
    });
}
