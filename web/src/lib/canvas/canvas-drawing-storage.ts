import {
    DRAWING_DOCUMENTS_STORE_NAME,
    DRAWING_GENERATION_RENDERS_STORE_NAME,
    DRAWING_PREVIEWS_STORE_NAME,
    localForageInstance,
} from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import type { CanvasDrawingEngine } from "@/lib/canvas/canvas-drawing-engine";
import { readImageMeta } from "@/lib/image-utils";
import { http } from "@/services/api/request";
import { resourceFileUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { deleteCanvasDrawing, getCanvasDrawing, putCanvasDrawing, type CanvasDrawingRecord } from "@/services/api/workspace-data";
import { imageToDataUrl } from "@/services/image-storage";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import {
    createInitialDrawingRender,
    documentFields,
    isDrawingRevisionConflict,
    isNotFoundDrawingError,
    liveRenderPublication,
    normalizeCanvasDrawingSnapshot,
    snapshotFromRecord,
    summarizeCanvasDrawing,
} from "./canvas-drawing-snapshot";
import type {
    CanvasDrawingRender,
    CanvasDrawingRenderDraft,
    CanvasDrawingSnapshot,
    DrawingKeyStore,
} from "./canvas-drawing-types";

export {
    summarizeCanvasDrawing,
    type CanvasDrawingRender,
    type CanvasDrawingRenderDraft,
    type CanvasDrawingSnapshot,
};

type LegacyEnvelope = {
    version: 3;
    committed?: CanvasDrawingSnapshot;
    draft?: { document?: CanvasDrawingSnapshot };
    removedGeneration?: number;
};

const defaultDrawingStore = localForageInstance(DRAWING_DOCUMENTS_STORE_NAME) as DrawingKeyStore<CanvasDrawingSnapshot | LegacyEnvelope>;
const defaultDrawingPreviewStore = localForageInstance(DRAWING_PREVIEWS_STORE_NAME) as DrawingKeyStore<Blob>;
const defaultDrawingRenderStore = localForageInstance(DRAWING_GENERATION_RENDERS_STORE_NAME) as DrawingKeyStore<CanvasDrawingRender>;

let activeDrawingStore = defaultDrawingStore;
let activeDrawingPreviewStore = defaultDrawingPreviewStore;
let activeDrawingRenderStore = defaultDrawingRenderStore;

const drawingOpChains = new Map<string, Promise<unknown>>();
const lastKnownRecords = new Map<string, CanvasDrawingRecord>();
const drawingSavedAt = new Map<string, number>();
const drawingRemovedAt = new Map<string, number>();
let drawingOpClock = 0;

function drawingKey(projectId: string, drawingId: string, userScope: string) {
    return `${userScope}:${projectId}:${drawingId}`;
}

function enqueueDrawingOp<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = drawingOpChains.get(key) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(job);
    const tail = run.then(() => undefined, () => undefined);
    drawingOpChains.set(key, tail);
    void tail.finally(() => {
        if (drawingOpChains.get(key) === tail) drawingOpChains.delete(key);
    });
    return run;
}

function unwrapBrowserSnapshot(raw: CanvasDrawingSnapshot | LegacyEnvelope | null): CanvasDrawingSnapshot | null {
    if (!raw) return null;
    if ((raw as LegacyEnvelope).version === 3) {
        const legacy = raw as LegacyEnvelope;
        if (legacy.removedGeneration && !legacy.draft) return null;
        const candidate = legacy.draft?.document ?? legacy.committed ?? null;
        return candidate ? documentFields(normalizeCanvasDrawingSnapshot(candidate)!) : null;
    }
    return documentFields(normalizeCanvasDrawingSnapshot(raw as CanvasDrawingSnapshot)!);
}

async function contentDigest(blob: Blob) {
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchDrawingResourceBlob(resourceId: string): Promise<Blob | null> {
    try {
        const response = await http.raw<Blob>({
            method: "get",
            url: `/resources/${encodeURIComponent(resourceId)}/file?proxy=1`,
            responseType: "blob",
        });
        return response.data instanceof Blob ? response.data : new Blob([response.data as BlobPart]);
    } catch {
        return null;
    }
}

async function readCanonicalDrawingRecord(projectId: string, drawingId: string): Promise<CanvasDrawingRecord | null> {
    const key = drawingKey(projectId, drawingId, getActiveUserScope());
    const startedAt = drawingOpClock;
    let remote: { drawing: CanvasDrawingRecord };
    try {
        remote = await getCanvasDrawing(projectId, drawingId);
    } catch (error) {
        if (isNotFoundDrawingError(error)) return null;
        throw error;
    }
    if ((drawingRemovedAt.get(key) || 0) > startedAt) return null;
    const cached = lastKnownRecords.get(key);
    if ((drawingSavedAt.get(key) || 0) > startedAt && cached && cached.revision >= remote.drawing.revision) {
        return cached;
    }
    if (!cached || remote.drawing.revision >= cached.revision) {
        lastKnownRecords.set(key, remote.drawing);
    }
    return remote.drawing;
}

function buildRenderFromRecord(record: CanvasDrawingRecord, blob: Blob): CanvasDrawingRender | null {
    if (!record.render?.resourceId) return null;
    return {
        blob,
        pageId: record.render.pageId || "",
        width: record.render.width || 0,
        height: record.render.height || 0,
        mimeType: record.render.mimeType || blob.type || "image/png",
        background: "white",
        storageKey: record.render.storageKey || resourceStorageKey(record.render.resourceId),
        url: resourceFileUrl(record.render.resourceId),
        version: 1,
        revision: record.revision,
        updatedAt: record.updatedAt,
    };
}

function pickLatestBase(cached?: CanvasDrawingRecord, previous?: CanvasDrawingSnapshot | null): CanvasDrawingSnapshot | null {
    const cachedSnapshot = cached ? snapshotFromRecord(cached) : null;
    if (cachedSnapshot && previous) {
        return cachedSnapshot.revision >= previous.revision ? cachedSnapshot : previous;
    }
    return cachedSnapshot ?? previous ?? null;
}

export async function loadCanvasDrawing(projectId: string, drawingId: string): Promise<CanvasDrawingSnapshot | null> {
    if (!projectId || !drawingId) return null;
    const key = drawingKey(projectId, drawingId, getActiveUserScope());
    if (usesBrowserLocalResourceStore()) {
        const snapshot = unwrapBrowserSnapshot(await activeDrawingStore.getItem(key));
        return snapshot ? { ...snapshot, origin: "browser" } : null;
    }
    const record = await readCanonicalDrawingRecord(projectId, drawingId);
    return record ? { ...snapshotFromRecord(record), origin: "canonical" } : null;
}

export async function saveCanvasDrawing(
    projectId: string,
    drawingId: string,
    engine: CanvasDrawingEngine,
    snapshot: unknown,
    previous?: CanvasDrawingSnapshot | null,
    preview?: Blob | null,
    render?: CanvasDrawingRenderDraft | null,
): Promise<CanvasDrawingSnapshot> {
    const key = drawingKey(projectId, drawingId, getActiveUserScope());
    const summary = summarizeCanvasDrawing(engine, snapshot);

    if (usesBrowserLocalResourceStore()) {
        return enqueueDrawingOp(key, async () => {
            const existing = unwrapBrowserSnapshot(await activeDrawingStore.getItem(key));
            const updatedAt = new Date().toISOString();
            const revision = Math.max(previous?.revision ?? 0, existing?.revision ?? 0) + 1;
            const document: CanvasDrawingSnapshot = {
                version: 2,
                engine,
                snapshot,
                revision,
                updatedAt,
                shapeCount: summary.shapeCount,
                pageCount: Math.min(summary.pageCount, 1),
                previewResourceId: previous?.previewResourceId ?? existing?.previewResourceId,
                renderResourceId: previous?.renderResourceId ?? existing?.renderResourceId,
            };
            const prevPreview = preview !== undefined ? await activeDrawingPreviewStore.getItem(key) : undefined;
            const prevRender = render !== undefined ? await activeDrawingRenderStore.getItem(key) : undefined;
            let previewWritten = false;
            let renderWritten = false;
            try {
                if (preview) {
                    await activeDrawingPreviewStore.setItem(key, preview);
                    previewWritten = true;
                } else if (preview === null) {
                    await activeDrawingPreviewStore.removeItem(key);
                    previewWritten = true;
                }
                if (render) {
                    await activeDrawingRenderStore.setItem(key, {
                        ...liveRenderPublication(render),
                        version: 1,
                        revision,
                        updatedAt,
                    });
                    renderWritten = true;
                } else if (render === null) {
                    await activeDrawingRenderStore.removeItem(key);
                    renderWritten = true;
                }
                await activeDrawingStore.setItem(key, document);
            } catch (error) {
                if (previewWritten) {
                    await (prevPreview ? activeDrawingPreviewStore.setItem(key, prevPreview) : activeDrawingPreviewStore.removeItem(key)).catch(() => undefined);
                }
                if (renderWritten) {
                    await (prevRender ? activeDrawingRenderStore.setItem(key, prevRender) : activeDrawingRenderStore.removeItem(key)).catch(() => undefined);
                }
                throw error;
            }
            return { ...document, origin: "browser" as const };
        });
    }

    return enqueueDrawingOp(key, async () => {
        let uploadedPreviewId: string | undefined;
        if (preview) {
            const digest = await contentDigest(preview);
            uploadedPreviewId = (await uploadResourceFile(preview, "image", {
                fileName: `${drawingId}-preview.png`,
                idempotencyKey: `canvas-drawing-preview:sha256:${digest}`,
            })).id;
        }
        let uploadedRender: {
            resourceId?: string;
            pageId?: string;
            width?: number;
            height?: number;
            mimeType?: string;
            background?: "white";
            storageKey?: string;
        } | undefined;
        if (render) {
            const digest = await contentDigest(render.blob);
            const resource = await uploadResourceFile(render.blob, "image", {
                fileName: `${drawingId}-render.png`,
                width: render.width,
                height: render.height,
                idempotencyKey: `canvas-drawing-render:sha256:${digest}`,
            });
            uploadedRender = {
                resourceId: resource.id,
                pageId: render.pageId,
                width: render.width,
                height: render.height,
                mimeType: render.mimeType,
                background: render.background,
                storageKey: render.storageKey || resourceStorageKey(resource.id),
            };
        } else if (render === null) {
            uploadedRender = { resourceId: "" };
        }

        const putWithBase = (base: CanvasDrawingSnapshot | null) =>
            putCanvasDrawing(projectId, drawingId, {
                drawingId,
                engine,
                revision: base?.revision ?? 0,
                snapshot,
                shapeCount: summary.shapeCount,
                pageCount: Math.min(summary.pageCount, 1),
                previewResourceId: preview === null ? "" : uploadedPreviewId ?? base?.previewResourceId,
                render: uploadedRender,
            });

        const base = pickLatestBase(lastKnownRecords.get(key), previous);
        let saved: { drawing: CanvasDrawingRecord };
        try {
            saved = await putWithBase(base);
        } catch (error) {
            if (!isDrawingRevisionConflict(error)) throw error;
            let latest: { drawing: CanvasDrawingRecord };
            try {
                latest = await getCanvasDrawing(projectId, drawingId);
            } catch {
                throw error;
            }
            saved = await putWithBase(snapshotFromRecord(latest.drawing));
        }

        const storedRecord: CanvasDrawingRecord = { ...saved.drawing, snapshot };
        lastKnownRecords.set(key, storedRecord);
        drawingSavedAt.set(key, ++drawingOpClock);
        drawingRemovedAt.delete(key);
        return { ...snapshotFromRecord(storedRecord, snapshot), origin: "canonical" as const };
    });
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

    let render: CanvasDrawingRenderDraft | undefined;
    try {
        render = await createInitialDrawingRender(dataUrl, width, height, document.pageId);
    } catch {
        // Optional initial render; save the drawing document even if canvas preview rendering fails.
    }
    return saveCanvasDrawing(projectId, drawingId, engine, document.snapshot, null, render?.blob, render);
}

export async function loadCanvasDrawingPreview(projectId: string, drawingId: string): Promise<Blob | null> {
    if (!projectId || !drawingId) return null;
    const key = drawingKey(projectId, drawingId, getActiveUserScope());
    if (usesBrowserLocalResourceStore()) {
        return activeDrawingPreviewStore.getItem(key);
    }
    const startedAt = drawingOpClock;
    const record = await readCanonicalDrawingRecord(projectId, drawingId);
    if (!record?.previewResourceId) return null;
    const blob = await fetchDrawingResourceBlob(record.previewResourceId);
    if ((drawingRemovedAt.get(key) || 0) > startedAt) return null;
    return blob;
}

export async function loadCanvasDrawingRender(projectId: string, drawingId: string): Promise<CanvasDrawingRender | null> {
    if (!projectId || !drawingId) return null;
    const key = drawingKey(projectId, drawingId, getActiveUserScope());
    if (usesBrowserLocalResourceStore()) {
        const cached = await activeDrawingRenderStore.getItem(key);
        return cached ? { ...cached, ...liveRenderPublication(cached) } : null;
    }
    const startedAt = drawingOpClock;
    const record = await readCanonicalDrawingRecord(projectId, drawingId);
    if (!record?.render?.resourceId) return null;
    const blob = await fetchDrawingResourceBlob(record.render.resourceId);
    if (!blob || (drawingRemovedAt.get(key) || 0) > startedAt) return null;
    return buildRenderFromRecord(record, blob);
}

export async function saveCanvasDrawingRenderPublication(
    projectId: string,
    drawingId: string,
    revision: number,
    publication: Pick<CanvasDrawingRenderDraft, "storageKey" | "url">,
): Promise<boolean> {
    if (!usesBrowserLocalResourceStore()) return false;
    const key = drawingKey(projectId, drawingId, getActiveUserScope());
    const render = await activeDrawingRenderStore.getItem(key);
    const doc = unwrapBrowserSnapshot(await activeDrawingStore.getItem(key));
    if (!render || render.revision !== revision) return false;
    if (doc && doc.revision !== revision) return false;
    await activeDrawingRenderStore.setItem(key, { ...render, ...liveRenderPublication({ ...render, ...publication }) });
    return true;
}

export async function removeCanvasDrawing(projectId: string, drawingId: string): Promise<void> {
    if (!projectId || !drawingId) return;
    const key = drawingKey(projectId, drawingId, getActiveUserScope());
    if (usesBrowserLocalResourceStore()) {
        await enqueueDrawingOp(key, async () => {
            await Promise.all([
                activeDrawingPreviewStore.removeItem(key),
                activeDrawingRenderStore.removeItem(key),
                activeDrawingStore.removeItem(key),
            ]);
        });
        return;
    }
    const previousRemovedAt = drawingRemovedAt.get(key);
    const removedClock = ++drawingOpClock;
    drawingRemovedAt.set(key, removedClock);
    await enqueueDrawingOp(key, async () => {
        try {
            await deleteCanvasDrawing(projectId, drawingId);
        } catch (error) {
            if (!isNotFoundDrawingError(error)) {
                if (drawingRemovedAt.get(key) === removedClock) {
                    if (previousRemovedAt === undefined) drawingRemovedAt.delete(key);
                    else drawingRemovedAt.set(key, previousRemovedAt);
                }
                throw error;
            }
        }
        lastKnownRecords.delete(key);
        drawingSavedAt.delete(key);
        drawingRemovedAt.set(key, ++drawingOpClock);
    });
}

export async function cloneCanvasDrawing(projectId: string, sourceDrawingId: string, targetDrawingId: string) {
    if (usesBrowserLocalResourceStore()) {
        const [source, preview, render] = await Promise.all([
            loadCanvasDrawing(projectId, sourceDrawingId),
            loadCanvasDrawingPreview(projectId, sourceDrawingId),
            loadCanvasDrawingRender(projectId, sourceDrawingId),
        ]);
        if (!source) return null;
        return saveCanvasDrawing(projectId, targetDrawingId, source.engine, source.snapshot, null, preview || undefined, render ? renderToDraft(render) : undefined);
    }
    const record = await readCanonicalDrawingRecord(projectId, sourceDrawingId);
    if (!record) return null;
    const source = snapshotFromRecord(record);
    const [preview, renderBlob] = await Promise.all([
        record.previewResourceId ? fetchDrawingResourceBlob(record.previewResourceId) : Promise.resolve(null),
        record.render?.resourceId ? fetchDrawingResourceBlob(record.render.resourceId) : Promise.resolve(null),
    ]);
    const render = renderBlob ? buildRenderFromRecord(record, renderBlob) : null;
    return saveCanvasDrawing(projectId, targetDrawingId, source.engine, source.snapshot, null, preview || undefined, render ? renderToDraft(render) : undefined);
}

function renderToDraft(render: CanvasDrawingRender): CanvasDrawingRenderDraft {
    return {
        blob: render.blob,
        pageId: render.pageId,
        width: render.width,
        height: render.height,
        mimeType: render.mimeType,
        background: render.background,
        storageKey: render.storageKey,
        url: render.url,
    };
}

export function replaceCanvasDrawingStoresForTests(stores?: {
    documents?: DrawingKeyStore<CanvasDrawingSnapshot | LegacyEnvelope>;
    previews?: DrawingKeyStore<Blob>;
    renders?: DrawingKeyStore<CanvasDrawingRender>;
}) {
    activeDrawingStore = stores?.documents ?? defaultDrawingStore;
    activeDrawingPreviewStore = stores?.previews ?? defaultDrawingPreviewStore;
    activeDrawingRenderStore = stores?.renders ?? defaultDrawingRenderStore;
}

export function resetCanvasDrawingStorageForTests() {
    drawingOpChains.clear();
    lastKnownRecords.clear();
    drawingSavedAt.clear();
    drawingRemovedAt.clear();
    drawingOpClock = 0;
    activeDrawingStore = defaultDrawingStore;
    activeDrawingPreviewStore = defaultDrawingPreviewStore;
    activeDrawingRenderStore = defaultDrawingRenderStore;
}
