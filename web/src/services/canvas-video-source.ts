import { getResourcePlaybackBlob, refreshResource, resourceIdFromStorageKey } from "@/services/api/resources";
import { resolveMediaUrl } from "@/services/file-storage";

export type CanvasVideoSource = { url: string; release: () => void };

/** Use the original for browser-compatible files and the existing H.264 copy for HEVC. */
export async function acquireCanvasVideoSource(storageKey?: string, fallback = "", signal?: AbortSignal): Promise<CanvasVideoSource> {
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (resourceId) {
        let resource = await refreshResource(resourceId, { signal });
        for (let attempt = 0; resource.playbackStatus === "processing" && attempt < 120; attempt += 1) {
            await waitForPlayback(2500, signal);
            resource = await refreshResource(resourceId, { signal });
        }
        if (resource.playbackStatus === "ready") {
            const blob = await getResourcePlaybackBlob(storageKey!);
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            if (blob) {
                const url = URL.createObjectURL(blob);
                return { url, release: () => URL.revokeObjectURL(url) };
            }
        }
    }
    const url = await resolveMediaUrl(storageKey, fallback);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return { url, release: () => undefined };
}

function waitForPlayback(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
        const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
        const timer = window.setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
        signal?.addEventListener("abort", abort, { once: true });
    });
}
