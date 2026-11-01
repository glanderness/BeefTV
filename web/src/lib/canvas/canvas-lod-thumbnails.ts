import { canvasNodeVideoPreviewUrl } from "@/lib/canvas/canvas-media-preview";
import { buildLibTVImagePreviewUrl } from "@/lib/canvas/libtv-import";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { acquireCanvasVideoPreview, canvasVideoPreviewNeedsHydration } from "@/services/canvas-video-preview";
import { resolveImageUrl } from "@/services/image-storage";
import { cacheResourceImagePreviewObjectUrl, cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * Small display-only bitmaps for the overview canvas. They are derived from
 * the same cached previews the DOM cards use and never replace the original
 * resource or mutate the canvas document.
 */
export type CanvasLodThumbnail = { source: CanvasImageSource; width: number; height: number };

type Entry = {
    state: "pending" | "ready" | "failed";
    thumbnail?: CanvasLodThumbnail;
    failedAt?: number;
    listeners: Set<() => void>;
};

const THUMBNAIL_MAX_SIDE = 256;
const MAX_ENTRIES = 900;
const MAX_CONCURRENT_LOADS = 4;
const FAILED_RETRY_DELAY_MS = 1000;
// Persisted preview tier shared with the DOM image cards.
const IMAGE_PREVIEW_TIER = 512;

const entries = new Map<string, Entry>();
const queue: Array<{ key: string; node: CanvasNodeData }> = [];
let activeLoads = 0;

export function canvasLodThumbnailKey(node: CanvasNodeData) {
    const metadata = node.metadata;
    if (node.type === CanvasNodeType.Image) {
        const identity = metadata?.storageKey || metadata?.previewContent || metadata?.content || "";
        return identity ? `image:${identity}` : "";
    }
    if (node.type === CanvasNodeType.Video) {
        const identity = metadata?.videoPreview?.storageKey || canvasNodeVideoPreviewUrl(node) || metadata?.storageKey || metadata?.content || "";
        return identity ? `video:${identity}` : "";
    }
    return "";
}

/**
 * Returns the bitmap when ready; otherwise queues one load and calls
 * `onReady` once it settles. Callers redraw from scratch, so a missed
 * notification only delays the thumbnail until the next frame.
 */
export function getCanvasLodThumbnail(node: CanvasNodeData, onReady: () => void): CanvasLodThumbnail | null | "failed" {
    const key = canvasLodThumbnailKey(node);
    if (!key) return null;
    const existing = entries.get(key);
    if (existing) {
        if (existing.state === "ready") {
            // Refresh LRU position.
            entries.delete(key);
            entries.set(key, existing);
            return existing.thumbnail || null;
        }
        if (existing.state === "failed") {
            if (Date.now() - (existing.failedAt || 0) < FAILED_RETRY_DELAY_MS) return "failed";
            // A transient download/decode failure must not poison the overview
            // for the rest of the session. Retry on a later visible redraw.
            entries.delete(key);
        } else {
            existing.listeners.add(onReady);
            return null;
        }
    }
    const entry: Entry = { state: "pending", listeners: new Set([onReady]) };
    entries.set(key, entry);
    queue.push({ key, node });
    pumpQueue();
    evictOverflow();
    return null;
}

function evictOverflow() {
    if (entries.size <= MAX_ENTRIES) return;
    for (const [key, entry] of entries) {
        if (entries.size <= MAX_ENTRIES) break;
        if (entry.state === "pending") continue;
        entries.delete(key);
    }
}

function pumpQueue() {
    while (activeLoads < MAX_CONCURRENT_LOADS && queue.length) {
        // Most recent requests are what the user is looking at now.
        const job = queue.pop()!;
        const entry = entries.get(job.key);
        if (!entry || entry.state !== "pending") continue;
        activeLoads += 1;
        void loadThumbnail(job.node)
            .then((thumbnail) => {
                entry.state = thumbnail ? "ready" : "failed";
                entry.thumbnail = thumbnail || undefined;
                if (!thumbnail) entry.failedAt = Date.now();
            })
            .catch(() => {
                entry.state = "failed";
                entry.failedAt = Date.now();
            })
            .finally(() => {
                activeLoads -= 1;
                const listeners = [...entry.listeners];
                entry.listeners.clear();
                listeners.forEach((listener) => listener());
                evictOverflow();
                pumpQueue();
            });
    }
}

async function loadThumbnail(node: CanvasNodeData): Promise<CanvasLodThumbnail | null> {
    if (node.type === CanvasNodeType.Video) return loadVideoThumbnail(node);
    const url = await resolveImageThumbnailUrl(node);
    return url ? rasterize(url) : null;
}

async function resolveImageThumbnailUrl(node: CanvasNodeData) {
    const metadata = node.metadata;
    const storageKey = metadata?.storageKey || "";
    const content = metadata?.content || "";
    const fallback = metadata?.previewContent || (metadata?.importSource?.provider === "libtv" ? buildLibTVImagePreviewUrl(content) : content);
    if (resourceIdFromStorageKey(storageKey)) {
        const large = Math.max(metadata?.naturalWidth || 0, metadata?.naturalHeight || 0) > IMAGE_PREVIEW_TIER;
        if (large && /^image\/(jpeg|png)$/i.test(metadata?.mimeType || "")) {
            return cacheResourceImagePreviewObjectUrl(storageKey, IMAGE_PREVIEW_TIER);
        }
        return cacheResourceObjectUrl(storageKey);
    }
    if (storageKey) return resolveImageUrl(storageKey, fallback);
    return fallback;
}

async function loadVideoThumbnail(node: CanvasNodeData) {
    const previewKey = node.metadata?.videoPreview?.storageKey || "";
    const persisted = canvasNodeVideoPreviewUrl(node);
    if (previewKey) {
        const url = resourceIdFromStorageKey(previewKey) ? await cacheResourceObjectUrl(previewKey) : await resolveImageUrl(previewKey, persisted);
        if (url) return rasterize(url);
    }
    if (persisted && !canvasVideoPreviewNeedsHydration(node)) return rasterize(persisted);
    // Same display-only poster lease as the DOM card; release once copied.
    const lease = acquireCanvasVideoPreview(node);
    try {
        const preview = await lease.promise;
        if (preview?.content) return await rasterize(preview.content);
        return persisted ? await rasterize(persisted) : null;
    } finally {
        lease.release();
    }
}

async function rasterize(url: string): Promise<CanvasLodThumbnail | null> {
    const image = new Image();
    image.decoding = "async";
    try {
        image.src = url;
        await image.decode();
        const naturalWidth = image.naturalWidth;
        const naturalHeight = image.naturalHeight;
        if (!naturalWidth || !naturalHeight) return null;
        const ratio = Math.min(1, THUMBNAIL_MAX_SIDE / Math.max(naturalWidth, naturalHeight));
        const width = Math.max(1, Math.round(naturalWidth * ratio));
        const height = Math.max(1, Math.round(naturalHeight * ratio));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, width, height);
        return { source: canvas, width: naturalWidth, height: naturalHeight };
    } finally {
        image.src = "";
    }
}
