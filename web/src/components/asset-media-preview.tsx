import { useEffect, useRef, useState, type ReactNode } from "react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import { isVideoHoverPreviewAllowed, useCanvasMemoryMode } from "@/lib/canvas/canvas-memory-policy";
import { bindCanvasVideoHoverPreview } from "@/lib/canvas/canvas-video-hover-preview";
import { cn } from "@/lib/utils";
import { acquireCanvasVideoPreview, getCachedCanvasVideoPreviewBlob, resolveServerVideoPosterUrl } from "@/services/canvas-video-preview";
import { acquireCanvasVideoSource } from "@/services/canvas-video-source";
import type { Asset } from "@/stores/use-asset-store";

type AssetMediaPreviewProps = {
    asset?: Asset | null;
    alt: string;
    className?: string;
    fallback?: ReactNode;
    hoverPlayDelayMs?: number;
};

// Serialize source acquisition as well as decoding so a grid never downloads
// every full video while the shared poster decoder is still busy.
let posterQueue: Promise<unknown> = Promise.resolve();

function loadAssetPoster(storageKey: string, content: string, signal: AbortSignal) {
    const work = posterQueue.then(async () => {
        signal.throwIfAborted();
        const controller = new AbortController();
        const cancel = () => controller.abort(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
        const deadline = setTimeout(() => controller.abort(new DOMException("Video poster timed out", "TimeoutError")), 8_000);
        const node = { metadata: { storageKey, content } };
        const preview = acquireCanvasVideoPreview(node);
        let rejectAborted: () => void = () => undefined;
        const aborted = new Promise<never>((_, reject) => {
            rejectAborted = () => reject(controller.signal.reason);
            controller.signal.addEventListener("abort", rejectAborted, { once: true });
        });
        try {
            const result = await Promise.race([preview.promise, aborted]);
            controller.signal.throwIfAborted();
            const blob = result && getCachedCanvasVideoPreviewBlob(node);
            return blob ? URL.createObjectURL(blob) : "";
        } finally {
            clearTimeout(deadline);
            signal.removeEventListener("abort", cancel);
            controller.signal.removeEventListener("abort", rejectAborted);
            preview.release();
        }
    });
    posterQueue = work.catch(() => undefined);
    return work;
}

function AssetVideoCover({ asset, alt, className, fallback, hoverPlayDelayMs }: AssetMediaPreviewProps & { asset: Extract<Asset, { kind: "video" }> }) {
    const target = useRef<HTMLSpanElement>(null);
    const [memoryMode] = useCanvasMemoryMode();
    const storageKey = asset.data.storageKey || "";
    const content = asset.data.url || "";
    const identity = JSON.stringify([storageKey, content]);
    const [failedCovers, setFailedCovers] = useState<{ identity: string; urls: string[] }>({ identity: "", urls: [] });
    const failedUrls = failedCovers.identity === identity ? failedCovers.urls : [];
    const explicitCover = asset.coverUrl && asset.coverUrl !== content && !failedUrls.includes(asset.coverUrl) ? asset.coverUrl : "";
    const serverPoster = resolveServerVideoPosterUrl({ metadata: { storageKey, content } });
    const directServerPoster = serverPoster && !failedUrls.includes(serverPoster) ? serverPoster : "";
    const directCover = explicitCover || directServerPoster;
    const [captured, setCaptured] = useState({ identity: "", url: "" });
    const [retryEpoch, setRetryEpoch] = useState(0);
    const poster = directCover || (captured.identity === identity ? captured.url : "");

    useEffect(() => {
        if (directCover || !target.current || (!storageKey && !content)) return;
        let ownedUrl = "";
        let controller: AbortController | undefined;
        let visible = false;
        let attempts = 0;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const load = () => {
            if (ownedUrl || attempts >= 2 || (controller && !controller.signal.aborted)) return;
            attempts++;
            const current = new AbortController();
            controller = current;
            void loadAssetPoster(storageKey, content, current.signal).then(url => {
                if (current.signal.aborted) { if (url) URL.revokeObjectURL(url); return; }
                ownedUrl = url;
                setCaptured({ identity, url });
            }).catch(() => undefined).finally(() => {
                if (ownedUrl || current.signal.aborted) return;
                current.abort();
                if (visible && attempts < 2) retryTimer = setTimeout(load, 1_000);
            });
        };
        const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => {
            visible = entries.some(entry => entry.isIntersecting);
            if (visible) load();
            else if (!ownedUrl) {
                clearTimeout(retryTimer);
                controller?.abort();
                attempts = 0;
            }
        });
        if (observer) observer.observe(target.current);
        else { visible = true; load(); }
        return () => {
            clearTimeout(retryTimer);
            observer?.disconnect();
            controller?.abort();
            if (ownedUrl) URL.revokeObjectURL(ownedUrl);
        };
    }, [directCover, content, identity, retryEpoch, storageKey]);

    useEffect(() => {
        if (!target.current || hoverPlayDelayMs === undefined || (!storageKey && !content) || !isVideoHoverPreviewAllowed(memoryMode)) return;
        return bindCanvasVideoHoverPreview(target.current,
            signal => acquireCanvasVideoSource(storageKey, content, signal),
            { delayMs: hoverPlayDelayMs, className: "pointer-events-none absolute inset-0 size-full object-cover" });
    }, [content, hoverPlayDelayMs, memoryMode, storageKey]);

    return <span ref={target} className={cn("relative block size-full overflow-hidden object-cover", className)} onPointerEnter={() => { if (!poster && (storageKey || content)) setRetryEpoch(value => value + 1); }}>
        {poster ? <CachedResourceImage key={poster} src={poster} alt={alt} className="size-full" style={{ objectFit: "inherit", maxHeight: "inherit" }} loading="lazy" decoding="async" fallback={fallback} onError={() => {
            if (!directCover) return;
            setFailedCovers(prev => ({
                identity,
                urls: prev.identity === identity ? (prev.urls.includes(directCover) ? prev.urls : [...prev.urls, directCover]) : [directCover],
            }));
        }} /> : fallback}
    </span>;
}

export function AssetMediaPreview({ asset, alt, className = "", fallback = null, hoverPlayDelayMs }: AssetMediaPreviewProps) {
    if (!asset) return fallback;
    if (asset.kind === "video") return <AssetVideoCover asset={asset} alt={alt} className={className} fallback={fallback} hoverPlayDelayMs={hoverPlayDelayMs} />;
    const storageKey = asset.kind === "image" ? asset.data.storageKey : undefined;
    const imageUrl = asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "");
    if (!imageUrl && !storageKey) return fallback;
    return <CachedResourceImage storageKey={storageKey} src={imageUrl} alt={alt} loading="lazy" decoding="async" className={className} fallback={fallback} />;
}
