import type { Dispatch, SetStateAction } from "react";

import { uploadNodeTitle, uploadNodeType } from "@/lib/canvas/canvas-file-upload";
import { videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { fitNodeSize, VIDEO_NODE_MAX_SIZE } from "@/lib/canvas/canvas-node-size";
import { isLocalRuntimeMode } from "@/lib/runtime-mode";
import { getResource, resourceFileUrl, resourceStorageKey } from "@/services/api/resources";
import { uploadMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import type { TimelineDirectMedia } from "@/types/timeline";

import type { StartCanvasUploadStatus } from "./use-canvas-upload";

type UploadGuard = {
    alive: () => boolean;
    signal: AbortSignal;
    suppress: (error: unknown) => boolean;
};

type MessageApi = {
    warning: (text: string) => void;
    success: (text: string) => void;
    error: (text: string) => void;
};

/** 把本地视频/音频/图片文件上传为时间线直连媒体（不落画布节点）。 */
export async function uploadTimelineLocalMediaFiles(params: {
    files: File[];
    guard: UploadGuard;
    message: MessageApi;
    persistTimelineMedia: (media: TimelineDirectMedia, signal?: AbortSignal) => Promise<string | undefined>;
    uploadMedia?: typeof uploadMediaFile;
    uploadImageFile?: typeof uploadImage;
}): Promise<TimelineDirectMedia[]> {
    const {
        files,
        guard,
        message,
        persistTimelineMedia,
        uploadMedia = uploadMediaFile,
        uploadImageFile = uploadImage,
    } = params;
    const supportedFiles = files.filter((file) => {
        const type = uploadNodeType(file);
        return type === CanvasNodeType.Video || type === CanvasNodeType.Audio || type === CanvasNodeType.Image;
    });
    if (!supportedFiles.length) {
        message.warning("请选择视频、音频或图片文件");
        return [];
    }
    const created: TimelineDirectMedia[] = [];
    for (const file of supportedFiles) {
        if (!guard.alive()) return [];
        try {
            const fileType = uploadNodeType(file);
            if (fileType === CanvasNodeType.Audio) {
                const audio = await uploadMedia(file, "audio");
                if (!guard.alive()) return [];
                const media: TimelineDirectMedia = {
                    id: `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    kind: "audio",
                    title: uploadNodeTitle(file.name),
                    storageKey: audio.storageKey,
                    url: audio.url,
                    durationMs: audio.durationMs,
                    bytes: audio.bytes,
                    mimeType: audio.mimeType,
                };
                media.assetId = await persistTimelineMedia(media, guard.signal);
                if (!guard.alive()) return [];
                created.push(media);
            } else if (fileType === CanvasNodeType.Image) {
                const image = await uploadImageFile(file);
                if (!guard.alive()) return [];
                const media: TimelineDirectMedia = {
                    id: `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    kind: "image",
                    title: uploadNodeTitle(file.name),
                    storageKey: image.storageKey,
                    url: image.url,
                    width: image.width,
                    height: image.height,
                    durationMs: 3_000,
                    bytes: image.bytes,
                    mimeType: image.mimeType,
                };
                media.assetId = await persistTimelineMedia(media, guard.signal);
                if (!guard.alive()) return [];
                created.push(media);
            } else {
                const video = await uploadMedia(file, "video");
                if (!guard.alive()) return [];
                const media: TimelineDirectMedia = {
                    id: `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    kind: "video",
                    title: uploadNodeTitle(file.name),
                    storageKey: video.storageKey,
                    url: video.url,
                    width: video.width,
                    height: video.height,
                    durationMs: video.durationMs,
                    bytes: video.bytes,
                    mimeType: video.mimeType,
                };
                media.assetId = await persistTimelineMedia(media, guard.signal);
                if (!guard.alive()) return [];
                created.push(media);
            }
        } catch (error) {
            if (guard.suppress(error)) return [];
            message.error(error instanceof Error ? `素材上传失败：${error.message}` : "素材上传失败");
        }
    }
    if (!guard.alive()) return [];
    if (created.length) message.success(`已上传 ${created.length} 个素材到时间线`);
    return created;
}

/** 直接消费原生渲染产出的 resourceId 创建并绑定画布视频节点，避免下载后再重传 Blob。 */
export async function createCanvasVideoNodeFromResource(params: {
    input: { resourceId: string; title: string; durationMs?: number; width?: number; height?: number; size?: number; mimeType?: string };
    guard: UploadGuard;
    domainProjectId?: string;
    getCanvasCenter: () => Position;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    selectInsertedNode: (id: string, mode: "open" | "close" | "preserve") => void;
    persistMediaNode: (node: CanvasNodeData, signal?: AbortSignal) => Promise<boolean>;
    startUploadStatus: StartCanvasUploadStatus;
    message: MessageApi;
    fetchResource?: typeof getResource;
}): Promise<CanvasNodeData | null> {
    const {
        input,
        guard,
        domainProjectId,
        getCanvasCenter,
        setNodes,
        selectInsertedNode,
        persistMediaNode,
        startUploadStatus,
        message,
        fetchResource = getResource,
    } = params;
    const resourceId = input.resourceId.trim();
    if (!resourceId) return null;
    const progress = startUploadStatus("合成视频片段", "绑定本地渲染结果", domainProjectId ? 3 : 2);
    try {
        const resource = await fetchResource(resourceId, { signal: guard.signal }).catch(() => null);
        if (!guard.alive()) return null;
        const width = resource?.width || input.width || 1280;
        const height = resource?.height || input.height || 720;
        const durationMs = resource?.durationMs || input.durationMs;
        const bytes = resource?.size || input.size;
        const mimeType = resource?.mimeType || input.mimeType || "video/mp4";
        progress.update("更新画布节点", 2);
        const size = fitNodeSize(width, height, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height);
        const center = getCanvasCenter();
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const node = {
            id,
            type: CanvasNodeType.Video,
            title: input.title,
            position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: {
                content: resource?.publicUrl || resourceFileUrl(resourceId),
                storageKey: resourceStorageKey(resourceId),
                status: "success" as const,
                naturalWidth: width,
                naturalHeight: height,
                bytes,
                mimeType,
                durationMs,
                hasAudio: true,
            },
        } satisfies CanvasNodeData;
        setNodes((current) => [...current, node]);
        selectInsertedNode(id, "preserve");
        if (domainProjectId) progress.update("写入项目资产", 3);
        const persisted = await persistMediaNode(node, guard.signal);
        if (!guard.alive()) return null;
        progress.done(persisted ? "已生成新视频片段并加入项目资产" : "已生成新视频片段，项目资产待重试");
        return node;
    } catch (error) {
        if (guard.suppress(error)) return null;
        const details = error instanceof Error ? error.message : "合成视频片段失败";
        progress.fail(details);
        message.error(details);
        return null;
    }
}

/** 浏览器 wasm 回退路径：上传 MP4 Blob 并创建新视频节点。 */
export async function createCanvasVideoNodeFromBlob(params: {
    blob: Blob;
    title: string;
    guard: UploadGuard;
    domainProjectId?: string;
    getCanvasCenter: () => Position;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    selectInsertedNode: (id: string, mode: "open" | "close" | "preserve") => void;
    persistMediaNode: (node: CanvasNodeData, signal?: AbortSignal) => Promise<boolean>;
    startUploadStatus: StartCanvasUploadStatus;
    message: MessageApi;
}): Promise<CanvasNodeData | null> {
    const { blob, title, guard, domainProjectId, getCanvasCenter, setNodes, selectInsertedNode, persistMediaNode, startUploadStatus, message } = params;
    const progress = startUploadStatus("合成视频片段", "上传合成结果", domainProjectId ? 4 : 3);
    try {
        const localRuntime = isLocalRuntimeMode();
        progress.update(localRuntime ? "保存合成结果到本地资源目录" : "上传到服务器并同步资源", 2);
        const video = await uploadMediaFile(blob, "video");
        if (!guard.alive()) return null;
        progress.update("更新画布节点", 3);
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height);
        const center = getCanvasCenter();
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const node = {
            id,
            type: CanvasNodeType.Video,
            title,
            position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: { ...videoMetadata(video), status: "success" as const },
        } satisfies CanvasNodeData;
        setNodes((current) => [...current, node]);
        selectInsertedNode(id, "preserve");
        if (domainProjectId) progress.update("写入项目资产", 4);
        const persisted = await persistMediaNode(node, guard.signal);
        if (!guard.alive()) return null;
        progress.done(persisted ? "已生成新视频片段并加入项目资产" : "已生成新视频片段，项目资产待重试");
        return node;
    } catch (error) {
        if (guard.suppress(error)) return null;
        const details = error instanceof Error ? error.message : "合成视频片段失败";
        progress.fail(details);
        message.error(details);
        return null;
    }
}
