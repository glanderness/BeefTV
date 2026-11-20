import { useEffect, useRef, useState, type ReactNode } from "react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import { isVideoHoverPreviewAllowed, useCanvasMemoryMode } from "@/lib/canvas/canvas-memory-policy";
import { bindCanvasVideoHoverPreview } from "@/lib/canvas/canvas-video-hover-preview";
import { cn } from "@/lib/utils";
import { captureCanvasVideoPosterBlobUrl, getCachedCanvasVideoPreviewBlob, resolveServerVideoPosterUrl, subscribeCanvasVideoPosterReady } from "@/services/canvas-video-preview";
import { acquireCanvasVideoSource } from "@/services/canvas-video-source";
import type { Asset } from "@/stores/use-asset-store";

type AssetMediaPreviewProps = {
    asset?: Asset | null;
    alt: string;
    className?: string;
    fallback?: ReactNode;
    hoverPlayDelayMs?: number;
};

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
        const previewNode = { metadata: { storageKey, content } };
        let ownedUrl = "";
        let controller: AbortController | undefined;
        let visible = false;
        let attempts = 0;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let active = true;
        const applyCapturedUrl = (url: string) => {
            if (!url || !active || ownedUrl) {
                if (url) URL.revokeObjectURL(url);
                return;
            }
            clearTimeout(retryTimer);
            ownedUrl = url;
            setCaptured({ identity, url });
        };
        const unsubscribeReady = subscribeCanvasVideoPosterReady(previewNode, () => {
            if (!active || ownedUrl) return;
            const blob = getCachedCanvasVideoPreviewBlob(previewNode);
            if (!blob) return;
            applyCapturedUrl(URL.createObjectURL(blob));
        });
        const load = () => {
            if (ownedUrl || attempts >= 2 || (controller && !controller.signal.aborted)) return;
            attempts++;
            const current = new AbortController();
            controller = current;
            void captureCanvasVideoPosterBlobUrl(previewNode, { signal: current.signal }).then(url => {
                if (current.signal.aborted || !active) { if (url) URL.revokeObjectURL(url); return; }
                applyCapturedUrl(url);
            }).catch(() => undefined).finally(() => {
                if (ownedUrl || current.signal.aborted || !active) return;
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
            active = false;
            clearTimeout(retryTimer);
            unsubscribeReady();
            observer?.disconnect();
            controller?.abort();
            if (ownedUrl) {
                const revokedUrl = ownedUrl;
                URL.revokeObjectURL(revokedUrl);
                setCaptured(prev => prev.url === revokedUrl ? { identity: "", url: "" } : prev);
            }
        };
    }, [directCover, content, identity, retryEpoch, storageKey]);

    useEffect(() => {
        if (!target.current || hoverPlayDelayMs === undefined || (!storageKey && !content) || !isVideoHoverPreviewAllowed(memoryMode)) return;
        return bindCanvasVideoHoverPreview(target.current,
            signal => acquireCanvasVideoSource(storageKey, content, signal),
            { delayMs: hoverPlayDelayMs, className: "pointer-events-none absolute inset-0 size-full object-cover" });
    }, [content, hoverPlayDelayMs, memoryMode, storageKey]);

    const markDirectCoverFailed = () => {
        if (!directCover) return;
        setFailedCovers(prev => ({
            identity,
            urls: prev.identity === identity ? (prev.urls.includes(directCover) ? prev.urls : [...prev.urls, directCover]) : [directCover],
        }));
    };

    return <span ref={target} className={cn("asset-media-preview-frame", className)} onPointerEnter={() => { if (!poster && (storageKey || content)) setRetryEpoch(value => value + 1); }}>
        {poster ? <CachedResourceImage key={poster} src={poster} alt={alt} className="asset-media-preview-image" loading="lazy" decoding="async" fallback={fallback} onLoadError={markDirectCoverFailed} /> : fallback}
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
