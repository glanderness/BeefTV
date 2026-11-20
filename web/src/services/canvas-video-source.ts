import { resolveResourceVideoPlayback } from "@/services/resource-video-playback";

export type CanvasVideoSource = { url: string; release: () => void };

/** Use loopback HTTP Range streaming when available, or browser-compatible Blob fallback. */
export async function acquireCanvasVideoSource(storageKey?: string, fallback = "", signal?: AbortSignal, needsCompatible = false): Promise<CanvasVideoSource> {
    const requestSignal = signal || new AbortController().signal;
    const resolved = await resolveResourceVideoPlayback(storageKey || "", fallback, requestSignal, needsCompatible);
    requestSignal.throwIfAborted();
    if (typeof resolved === "string") return { url: resolved, release: () => undefined };
    if ("url" in resolved) return { url: resolved.url, release: () => undefined };
    const url = URL.createObjectURL(resolved.blob);
    return { url, release: () => URL.revokeObjectURL(url) };
}
