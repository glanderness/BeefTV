import { getCanvasMemoryMode, type CanvasMemoryMode } from "@/lib/canvas/canvas-memory-policy";

export function canvasImagePreviewSize(
    width: number,
    height: number,
    scale: number,
    dpr: number,
    naturalWidth: number,
    naturalHeight: number,
    mimeType: string,
    memoryMode: CanvasMemoryMode = getCanvasMemoryMode(),
): 128 | 256 | 512 | 1024 | 2048 | undefined {
    if (memoryMode === "thumbnail-only") {
        if (mimeType && /^image\/gif$/i.test(mimeType)) return undefined;
        return 256;
    }
    if (memoryMode === "low-memory") {
        if (mimeType && /^image\/gif$/i.test(mimeType)) return undefined;
        return 512;
    }
    if (!/^image\/(jpeg|png)$/i.test(mimeType) || !naturalWidth || !naturalHeight) return undefined;
    const required = Math.max(width, height) * scale * Math.max(1, dpr) * 2;
    const tier = ([128, 512, 1024, 2048] as const).find((size) => size >= required);
    return tier && tier < Math.max(naturalWidth, naturalHeight) ? tier : undefined;
}

let dprListeners: Set<(dpr: number) => void> | null = null;
let dprMediaQuery: MediaQueryList | null = null;

function notifyDevicePixelRatio() {
    if (typeof window === "undefined" || !dprListeners?.size) return;
    const next = window.devicePixelRatio || 1;
    bindDprMediaQuery(next);
    for (const listener of dprListeners) listener(next);
}

function bindDprMediaQuery(dpr: number) {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    dprMediaQuery?.removeEventListener("change", notifyDevicePixelRatio);
    dprMediaQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
    dprMediaQuery.addEventListener("change", notifyDevicePixelRatio);
}

export function subscribeDevicePixelRatio(listener: (dpr: number) => void) {
    if (typeof window === "undefined") return () => undefined;
    if (!dprListeners) {
        dprListeners = new Set();
        bindDprMediaQuery(window.devicePixelRatio || 1);
        window.addEventListener("resize", notifyDevicePixelRatio);
    }
    dprListeners.add(listener);
    return () => {
        dprListeners?.delete(listener);
        if (dprListeners && dprListeners.size === 0) {
            dprMediaQuery?.removeEventListener("change", notifyDevicePixelRatio);
            dprMediaQuery = null;
            window.removeEventListener("resize", notifyDevicePixelRatio);
            dprListeners = null;
        }
    };
}

/**
 * Disposable display pixels fallback for non-server / browser-local blobs.
 * Backend-hosted resources use server-generated disk-cached previews instead
 * of main-thread canvas.toBlob().
 */
export async function createCanvasImagePreviewBlob(original: Blob, maxSize: number): Promise<Blob> {
    const normalizedMime = original.type.toLowerCase();
    if (normalizedMime !== "image/jpeg" && normalizedMime !== "image/png" && normalizedMime !== "image/webp") return original;
    // APNG keeps its animation. acTL precedes the first image-data chunk.
    if (normalizedMime === "image/png") {
        const header = new Uint8Array(await original.slice(0, 65536).arrayBuffer());
        if (header[24] === 16) return original;
        const view = new DataView(header.buffer);
        for (let offset = 8; offset + 8 <= header.length;) {
            const type = String.fromCharCode(...header.subarray(offset + 4, offset + 8));
            if (type === "acTL") return original;
            if (type === "IDAT") break;
            offset += view.getUint32(offset) + 12;
        }
    }
    const image = new Image();
    image.decoding = "async";
    const source = URL.createObjectURL(original);
    const canvas = document.createElement("canvas");
    try {
        const context =
            canvas.getContext("2d", { colorSpace: "display-p3" }) ||
            canvas.getContext("2d");
        if (!context) return original;
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("图片预览解码失败"));
            image.src = source;
        });
        if (typeof image.decode === "function") {
            await image.decode().catch(() => undefined);
        }
        const ratio = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
        if (ratio === 1) return original;
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const outputMime = normalizedMime === "image/png" ? "image/png" : "image/jpeg";
        const outputQuality = outputMime === "image/jpeg" ? 0.86 : undefined;
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片预览编码失败")), outputMime, outputQuality));
    } finally {
        image.onload = image.onerror = null;
        image.src = "";
        URL.revokeObjectURL(source);
        canvas.width = canvas.height = 0;
    }
}
