import localforage from "localforage";

import type { CanvasDrawingEngine } from "@/lib/canvas/canvas-drawing-engine";
import { readImageMeta } from "@/lib/image-utils";
import { getActiveUserScope } from "@/lib/user-scope";
import { deleteCanvasDrawing, getCanvasDrawing, putCanvasDrawing, type CanvasDrawingRecord } from "@/services/api/workspace-data";
import { ApiError } from "@/services/api/request";
import { getResourceBlob, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { imageToDataUrl } from "@/services/image-storage";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";

export type CanvasDrawingSnapshot = {
    version: 2;
    engine: CanvasDrawingEngine;
    snapshot: unknown;
    revision: number;
    updatedAt: string;
    shapeCount: number;
    pageCount: number;
    previewResourceId?: string;
    renderResourceId?: string;
};

export type CanvasDrawingRenderDraft = {
    blob: Blob;
    pageId: string;
    width: number;
    height: number;
    mimeType: string;
    background: "white";
    storageKey?: string;
    url?: string;
};

export type CanvasDrawingRender = CanvasDrawingRenderDraft & {
    version: 1;
    revision: number;
    updatedAt: string;
};

const drawingStore = localforage.createInstance({ name: "infinite-canvas", storeName: "drawing_documents" });
const drawingPreviewStore = localforage.createInstance({ name: "infinite-canvas", storeName: "drawing_previews" });
const drawingRenderStore = localforage.createInstance({ name: "infinite-canvas", storeName: "drawing_generation_renders" });
const INITIAL_DRAWING_RENDER_MAX_DIMENSION = 2048;
const INITIAL_DRAWING_RENDER_PADDING = 24;

function drawingKey(projectId: string, drawingId: string) {
    return `${getActiveUserScope()}:${projectId}:${drawingId}`;
}

export async function loadCanvasDrawing(projectId: string, drawingId: string) {
    if (!projectId || !drawingId) return null;
    if (!usesBrowserLocalResourceStore()) {
        try {
            const remote = await getCanvasDrawing(projectId, drawingId);
            const saved = snapshotFromRecord(remote.drawing);
            await cacheCanvasDrawing(projectId, drawingId, saved, undefined, undefined);
            await cacheDrawingResources(projectId, drawingId, remote.drawing);
            return saved;
        } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
        }
    }
    const saved = normalizeCanvasDrawingSnapshot(await drawingStore.getItem<CanvasDrawingSnapshot>(drawingKey(projectId, drawingId)));
    if (!saved) return null;
    // IndexedDB revision is a local draft, not a backend CAS token.
    if (!usesBrowserLocalResourceStore()) return { ...saved, revision: 0 };
    return saved;
}

export async function saveCanvasDrawing(
    projectId: string,
    drawingId: string,
    engine: CanvasDrawingEngine,
    snapshot: unknown,
    previous?: CanvasDrawingSnapshot | null,
    preview?: Blob | null,
    render?: CanvasDrawingRenderDraft | null,
) {
    const summary = summarizeCanvasDrawing(engine, snapshot);
    if (!usesBrowserLocalResourceStore()) {
        const saved = await persistCanvasDrawingToBackend(projectId, drawingId, engine, snapshot, summary, previous, preview, render);
        await cacheCanvasDrawing(projectId, drawingId, saved, preview, render);
        return saved;
    }
    const revision = (previous?.revision || 0) + 1;
    const updatedAt = new Date().toISOString();
    const next: CanvasDrawingSnapshot = {
        version: 2,
        engine,
        snapshot,
        revision,
        updatedAt,
        shapeCount: summary.shapeCount,
        pageCount: Math.min(summary.pageCount, 1),
        previewResourceId: previous?.previewResourceId,
        renderResourceId: previous?.renderResourceId,
    };
    await cacheCanvasDrawing(projectId, drawingId, next, preview, render);
    return next;
}

export async function createCanvasDrawingFromImage(
    projectId: string,
    drawingId: string,
    engine: CanvasDrawingEngine,
    image: { url: string; storageKey?: string; name: string; mimeType?: string },
) {
    const dataUrl = await imageToDataUrl({ url: image.url, storageKey: image.storageKey, name: image.name, mimeType: image.mimeType });
    if (!dataUrl?.startsWith("data:image/")) throw new Error("无法读取来源图片");

    const { width, height, mimeType } = await readImageMeta(dataUrl);
    const source = { dataUrl, width, height, mimeType: mimeType || image.mimeType || "image/png", name: image.name || "来源图片" };
    const document = (await import("@/lib/canvas/canvas-drawing-excalidraw-document")).createExcalidrawDrawingFromImage(source);

    // 来源图必须进入绘图快照本身，不能继续依赖可能被替换或清理的原节点 URL。
    try {
        const render = await createInitialDrawingRender(dataUrl, width, height, document.pageId);
        return await saveCanvasDrawing(projectId, drawingId, engine, document.snapshot, null, render.blob, render);
    } catch (error) {
        await removeCanvasDrawing(projectId, drawingId).catch((cleanupError) => console.warn("清理失败的绘图初始化数据失败", cleanupError));
        throw error;
    }
}

export async function loadCanvasDrawingPreview(projectId: string, drawingId: string) {
    if (!projectId || !drawingId) return null;
    const cached = await drawingPreviewStore.getItem<Blob>(drawingKey(projectId, drawingId));
    if (cached) return cached;
    if (usesBrowserLocalResourceStore()) return null;
    await loadCanvasDrawing(projectId, drawingId);
    return drawingPreviewStore.getItem<Blob>(drawingKey(projectId, drawingId));
}

export async function loadCanvasDrawingRender(projectId: string, drawingId: string) {
    if (!projectId || !drawingId) return null;
    const cached = await drawingRenderStore.getItem<CanvasDrawingRender>(drawingKey(projectId, drawingId));
    if (cached) return cached;
    if (usesBrowserLocalResourceStore()) return null;
    await loadCanvasDrawing(projectId, drawingId);
    return drawingRenderStore.getItem<CanvasDrawingRender>(drawingKey(projectId, drawingId));
}

export async function saveCanvasDrawingRenderPublication(projectId: string, drawingId: string, revision: number, publication: Pick<CanvasDrawingRenderDraft, "storageKey" | "url">) {
    const key = drawingKey(projectId, drawingId);
    const render = await drawingRenderStore.getItem<CanvasDrawingRender>(key);
    if (!render || render.revision !== revision) return false;
    await drawingRenderStore.setItem(key, { ...render, ...publication });
    return true;
}

export async function removeCanvasDrawing(projectId: string, drawingId: string) {
    if (!projectId || !drawingId) return;
    if (!usesBrowserLocalResourceStore()) {
        try {
            await deleteCanvasDrawing(projectId, drawingId);
        } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
        }
    }
    await Promise.all([
        drawingStore.removeItem(drawingKey(projectId, drawingId)),
        drawingPreviewStore.removeItem(drawingKey(projectId, drawingId)),
        drawingRenderStore.removeItem(drawingKey(projectId, drawingId)),
    ]);
}

export async function cloneCanvasDrawing(projectId: string, sourceDrawingId: string, targetDrawingId: string) {
    const [source, preview, render] = await Promise.all([
        loadCanvasDrawing(projectId, sourceDrawingId),
        loadCanvasDrawingPreview(projectId, sourceDrawingId),
        loadCanvasDrawingRender(projectId, sourceDrawingId),
    ]);
    if (!source) return null;
    const renderDraft = render
        ? {
              blob: render.blob,
              pageId: render.pageId,
              width: render.width,
              height: render.height,
              mimeType: render.mimeType,
              background: render.background,
              storageKey: render.storageKey,
              url: render.url,
          } satisfies CanvasDrawingRenderDraft
        : undefined;
    return saveCanvasDrawing(projectId, targetDrawingId, source.engine, source.snapshot, null, preview || undefined, renderDraft);
}

export function summarizeCanvasDrawing(engine: CanvasDrawingEngine, snapshot: unknown) {
    void engine;
    const root = snapshot && typeof snapshot === "object" ? snapshot as Record<string, unknown> : {};
    const elements = Array.isArray(root.elements) ? root.elements : [];
    return { shapeCount: elements.filter((element) => Boolean(element) && typeof element === "object" && !(element as { isDeleted?: boolean }).isDeleted).length, pageCount: 1 };
}

function normalizeCanvasDrawingSnapshot(saved: CanvasDrawingSnapshot | null) {
    if (!saved) return null;
    if (saved.version === 2 && saved.engine === "excalidraw") return saved;
    throw new Error("绘图文档版本或引擎无效");
}

async function persistCanvasDrawingToBackend(
    projectId: string,
    drawingId: string,
    engine: CanvasDrawingEngine,
    snapshot: unknown,
    summary: { shapeCount: number; pageCount: number },
    previous?: CanvasDrawingSnapshot | null,
    preview?: Blob | null,
    render?: CanvasDrawingRenderDraft | null,
) {
    const previewResourceId = preview
        ? (await uploadResourceFile(preview, "image", { fileName: `${drawingId}-preview.png`, idempotencyKey: `canvas-drawing-preview:sha256:${await contentDigest(preview)}` })).id
        : preview === null
            ? ""
            : previous?.previewResourceId;
    let renderRecord: { resourceId?: string; pageId?: string; width?: number; height?: number; mimeType?: string; background?: "white"; storageKey?: string } | undefined;
    if (render) {
        const resource = await uploadResourceFile(render.blob, "image", {
            fileName: `${drawingId}-render.png`,
            width: render.width,
            height: render.height,
            idempotencyKey: `canvas-drawing-render:sha256:${await contentDigest(render.blob)}`,
        });
        renderRecord = {
            resourceId: resource.id,
            pageId: render.pageId,
            width: render.width,
            height: render.height,
            mimeType: render.mimeType,
            background: render.background,
            storageKey: render.storageKey || resourceStorageKey(resource.id),
        };
    } else if (render === null) {
        renderRecord = { resourceId: "" };
    }
    const saved = await putCanvasDrawing(projectId, drawingId, {
        drawingId,
        engine,
        revision: previous?.revision ?? 0,
        snapshot,
        shapeCount: summary.shapeCount,
        pageCount: Math.min(summary.pageCount, 1),
        previewResourceId,
        render: renderRecord,
    });
    return snapshotFromRecord(saved.drawing, snapshot);
}

async function cacheCanvasDrawing(
    projectId: string,
    drawingId: string,
    next: CanvasDrawingSnapshot,
    preview?: Blob | null,
    render?: CanvasDrawingRenderDraft | null,
) {
    const key = drawingKey(projectId, drawingId);
    await drawingStore.setItem(key, next);
    if (preview) await drawingPreviewStore.setItem(key, preview);
    else if (preview === null) await drawingPreviewStore.removeItem(key);
    if (render) {
        await drawingRenderStore.setItem<CanvasDrawingRender>(key, {
            ...render,
            version: 1,
            revision: next.revision,
            updatedAt: next.updatedAt,
        });
    } else if (render === null) await drawingRenderStore.removeItem(key);
}

async function cacheDrawingResources(projectId: string, drawingId: string, record: CanvasDrawingRecord) {
    const key = drawingKey(projectId, drawingId);
    if (record.previewResourceId) {
        const blob = await getResourceBlob(resourceStorageKey(record.previewResourceId));
        if (blob) await drawingPreviewStore.setItem(key, blob);
    }
    if (record.render?.resourceId) {
        const blob = await getResourceBlob(resourceStorageKey(record.render.resourceId));
        if (!blob) return;
        const previous = await drawingRenderStore.getItem<CanvasDrawingRender>(key);
        await drawingRenderStore.setItem<CanvasDrawingRender>(key, {
            blob,
            pageId: record.render.pageId || previous?.pageId || "",
            width: record.render.width || previous?.width || 0,
            height: record.render.height || previous?.height || 0,
            mimeType: record.render.mimeType || previous?.mimeType || blob.type || "image/png",
            background: "white",
            storageKey: record.render.storageKey || resourceStorageKey(record.render.resourceId),
            url: previous?.url,
            version: 1,
            revision: record.revision,
            updatedAt: record.updatedAt,
        });
    }
}

function snapshotFromRecord(record: CanvasDrawingRecord, snapshot: unknown = record.snapshot): CanvasDrawingSnapshot {
    return normalizeCanvasDrawingSnapshot({
        version: 2,
        engine: record.engine,
        snapshot,
        revision: record.revision,
        updatedAt: record.updatedAt,
        shapeCount: record.shapeCount,
        pageCount: record.pageCount,
        previewResourceId: record.previewResourceId,
        renderResourceId: record.render?.resourceId,
    })!;
}

async function contentDigest(blob: Blob) {
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createInitialDrawingRender(dataUrl: string, width: number, height: number, pageId: string): Promise<CanvasDrawingRenderDraft> {
    const source = await loadDrawingImage(dataUrl);
    const paddedWidth = width + INITIAL_DRAWING_RENDER_PADDING * 2;
    const paddedHeight = height + INITIAL_DRAWING_RENDER_PADDING * 2;
    const scale = Math.min(1, INITIAL_DRAWING_RENDER_MAX_DIMENSION / Math.max(paddedWidth, paddedHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(paddedWidth * scale));
    canvas.height = Math.max(1, Math.round(paddedHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建绘图预览");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
        source,
        Math.round(INITIAL_DRAWING_RENDER_PADDING * scale),
        Math.round(INITIAL_DRAWING_RENDER_PADDING * scale),
        Math.max(1, Math.round(width * scale)),
        Math.max(1, Math.round(height * scale)),
    );
    const blob = await canvasToPngBlob(canvas);
    return {
        blob,
        pageId,
        width: canvas.width,
        height: canvas.height,
        mimeType: "image/png",
        background: "white",
    };
}

function loadDrawingImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("来源图片无法载入绘图"));
        image.src = dataUrl;
    });
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法生成绘图预览")), "image/png");
    });
}
