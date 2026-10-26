import { captureVideoPoster } from "@/lib/video-poster";
import { CANVAS_VIDEO_PREVIEW_VERSION } from "@/services/canvas-video-preview";
import { acquireCanvasVideoSource } from "@/services/canvas-video-source";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import type { CanvasNodeMetadata } from "@/types/canvas";

export type GeneratedVideoMedia = { storageKey?: string; content: string };

export type GeneratedVideoPreview = NonNullable<CanvasNodeMetadata["videoPreview"]>;

/**
 * 首帧记录跟着视频本体走：sourceKey 说明这张图属于哪个视频，
 * captureVersion 说明用的是哪一版取帧口径。两者都在，展示层就不会
 * 把同一张首帧当成旧图再解一次视频。
 */
export function videoPreviewFromImage(image: UploadedImage | undefined, sourceKey: string): GeneratedVideoPreview | undefined {
    if (!image) return undefined;
    return {
        content: image.url,
        storageKey: image.storageKey,
        width: image.width,
        height: image.height,
        bytes: image.bytes,
        mimeType: image.mimeType,
        captureVersion: CANVAS_VIDEO_PREVIEW_VERSION,
        sourceKey,
    };
}

/**
 * 生成出来的视频也要有一张首帧，和用户拖入视频时走同一套取帧代码。
 * 首帧只影响未激活节点的显示，取不到时返回 undefined，视频本身照常可用。
 */
export async function captureGeneratedVideoPreview(media: GeneratedVideoMedia, signal?: AbortSignal): Promise<UploadedImage | undefined> {
    const source = await acquireCanvasVideoSource(media.storageKey, media.content, signal);
    if (!source.url) {
        source.release();
        return undefined;
    }
    let captured: Awaited<ReturnType<typeof captureVideoPoster>>;
    try {
        captured = await captureVideoPoster(source.url, { signal, maxWidth: 400 });
    } finally {
        source.release();
    }
    if (!captured.poster) return undefined;
    return uploadImage(captured.poster);
}