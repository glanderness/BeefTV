import type { CanvasDrawingEngine } from "@/lib/canvas/canvas-drawing-engine";

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
    origin?: "canonical" | "browser";
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

export type DrawingKeyStore<T> = {
    getItem(key: string): Promise<T | null>;
    setItem(key: string, value: T): Promise<T>;
    removeItem(key: string): Promise<void>;
};
