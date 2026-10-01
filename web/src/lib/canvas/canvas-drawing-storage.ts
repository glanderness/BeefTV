import localforage from "localforage";

import type { CanvasDrawingEngine } from "@/lib/canvas/canvas-drawing-engine";
import { readImageMeta } from "@/lib/image-utils";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { deleteCanvasDrawing, getCanvasDrawing, putCanvasDrawing, type CanvasDrawingRecord } from "@/services/api/workspace-data";
import { ApiError, http } from "@/services/api/request";
import { resourceFileUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
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
    origin?: "canonical" | "draft" | "browser";
    canonicalMissing?: boolean;
    draftGeneration?: number;
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

export class CanvasDrawingCanonicalMissingError extends Error {
    constructor() {
        super("画板在工作区中不存在或已删除，本地草稿已保留");
        this.name = "CanvasDrawingCanonicalMissingError";
    }
}

type DrawingDraftState = {
    document: CanvasDrawingSnapshot;
    generation: number;
    canonicalMissing?: boolean;
    conflict?: boolean;
};

type DrawingCacheEnvelope = {
    version: 3;
    committed?: CanvasDrawingSnapshot;
    draft?: DrawingDraftState;
    removedGeneration?: number;
};

type DrawingKeyStore<T> = {
    getItem(key: string): Promise<T | null>;
    setItem(key: string, value: T): Promise<T>;
    removeItem(key: string): Promise<void>;
};

const defaultDrawingStore = localforage.createInstance({ name: "infinite-canvas", storeName: "drawing_documents" });
const defaultDrawingPreviewStore = localforage.createInstance({ name: "infinite-canvas", storeName: "drawing_previews" });
const defaultDrawingRenderStore = localforage.createInstance({ name: "infinite-canvas", storeName: "drawing_generation_renders" });

let drawingStore: DrawingKeyStore<DrawingCacheEnvelope | CanvasDrawingSnapshot> = defaultDrawingStore;
let drawingPreviewStore: DrawingKeyStore<Blob> = defaultDrawingPreviewStore;
let drawingRenderStore: DrawingKeyStore<CanvasDrawingRender> = defaultDrawingRenderStore;
const drawingCommitChains = new Map<string, Promise<unknown>>();
const envelopeLocks = new Map<string, Promise<unknown>>();
let digestDelayForTests: (() => Promise<void>) | undefined;

const INITIAL_DRAWING_RENDER_MAX_DIMENSION = 2048;
const INITIAL_DRAWING_RENDER_PADDING = 24;

function drawingKey(projectId: string, drawingId: string, userScope: string) {
    return `${userScope}:${projectId}:${drawingId}`;
}

function captureScope(expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    return expected;
}

function enqueueDrawingCommit<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = drawingCommitChains.get(key) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(job);
    drawingCommitChains.set(key, run.then(() => undefined, () => undefined));
    return run;
}

function withEnvelopeLock<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = envelopeLocks.get(key) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(job);
    envelopeLocks.set(key, run.then(() => undefined, () => undefined));
    return run;
}

function documentFields(snapshot: CanvasDrawingSnapshot): CanvasDrawingSnapshot {
    return {
        version: 2,
        engine: snapshot.engine,
        snapshot: snapshot.snapshot,
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
        shapeCount: snapshot.shapeCount,
        pageCount: snapshot.pageCount,
        previewResourceId: snapshot.previewResourceId,
        renderResourceId: snapshot.renderResourceId,
    };
}

function emptyEnvelope(): DrawingCacheEnvelope {
    return { version: 3 };
}

function parseEnvelope(raw: DrawingCacheEnvelope | CanvasDrawingSnapshot | null): DrawingCacheEnvelope {
    if (!raw) return emptyEnvelope();
    if ((raw as DrawingCacheEnvelope).version === 3) {
        const envelope = raw as DrawingCacheEnvelope;
        return {
            version: 3,
            committed: envelope.committed ? documentFields(normalizeCanvasDrawingSnapshot(envelope.committed)!) : undefined,
            draft: envelope.draft?.document
                ? {
                    document: documentFields(normalizeCanvasDrawingSnapshot(envelope.draft.document)!),
                    generation: Number(envelope.draft.generation) || 0,
                    canonicalMissing: envelope.draft.canonicalMissing === true,
                    conflict: envelope.draft.conflict === true,
                }
                : undefined,
            removedGeneration: Number(envelope.removedGeneration) || undefined,
        };
    }
    const legacy = normalizeCanvasDrawingSnapshot(raw as CanvasDrawingSnapshot);
    if (!legacy) return emptyEnvelope();
    return { version: 3, draft: { document: documentFields(legacy), generation: 1 } };
}

async function readEnvelope(key: string) {
    return parseEnvelope(await drawingStore.getItem(key));
}

async function writeEnvelope(key: string, envelope: DrawingCacheEnvelope, expected: CapturedUserScope, ackDraftGeneration = envelope.draft?.generation || 0) {
    return withEnvelopeLock(key, async () => {
        assertUserScope(expected);
        const live = await readEnvelope(key);
        assertUserScope(expected);
        const liveDraftGeneration = live.draft?.generation || 0;
        if (liveDraftGeneration > ackDraftGeneration) {
            envelope = { ...envelope, draft: live.draft };
        }
        if ((live.removedGeneration || 0) > (envelope.removedGeneration || 0) && !envelope.draft) {
            envelope = { ...envelope, removedGeneration: live.removedGeneration };
        }
        await drawingStore.setItem(key, envelope);
        assertUserScope(expected);
    });
}

function nextDraftGeneration(envelope: DrawingCacheEnvelope) {
    return Math.max(envelope.draft?.generation || 0, envelope.removedGeneration || 0) + 1;
}

function publishSnapshot(envelope: DrawingCacheEnvelope, origin: CanvasDrawingSnapshot["origin"]): CanvasDrawingSnapshot | null {
    if (envelope.removedGeneration && !envelope.draft) return null;
    if (envelope.draft) {
        const casRevision = envelope.committed?.revision ?? 0;
        return {
            ...envelope.draft.document,
            revision: casRevision,
            origin: origin || "draft",
            canonicalMissing: envelope.draft.canonicalMissing || !envelope.committed,
            draftGeneration: envelope.draft.generation,
            previewResourceId: envelope.committed?.previewResourceId ?? envelope.draft.document.previewResourceId,
            renderResourceId: envelope.committed?.renderResourceId ?? envelope.draft.document.renderResourceId,
        };
    }
    if (envelope.committed) return { ...envelope.committed, origin: origin || "canonical" };
    return null;
}

async function writeDraftBlobs(
    key: string,
    generation: number,
    preview: Blob | null | undefined,
    render: CanvasDrawingRenderDraft | null | undefined,
    meta: Pick<CanvasDrawingSnapshot, "revision" | "updatedAt">,
    expected: CapturedUserScope,
) {
    assertUserScope(expected);
    if (preview) await drawingPreviewStore.setItem(key, preview);
    else if (preview === null) await drawingPreviewStore.removeItem(key);
    if (render) {
        await drawingRenderStore.setItem(key, {
            ...liveRenderPublication(render),
            version: 1,
            revision: meta.revision,
            updatedAt: meta.updatedAt,
        });
    } else if (render === null) await drawingRenderStore.removeItem(key);
    assertUserScope(expected);
    const live = await readEnvelope(key);
    if ((live.draft?.generation || 0) !== generation && (live.removedGeneration || 0) !== generation) {
        return;
    }
}

function liveRenderPublication(render: CanvasDrawingRenderDraft): CanvasDrawingRenderDraft {
    const resourceId = resourceIdFromRender(render);
    return {
        ...render,
        storageKey: render.storageKey || (resourceId ? resourceStorageKey(resourceId) : render.storageKey),
        url: resourceId ? resourceFileUrl(resourceId) : staleProcessUrl(render.url) ? undefined : render.url,
    };
}

function resourceIdFromRender(render: Pick<CanvasDrawingRenderDraft, "storageKey" | "url">) {
    const fromKey = render.storageKey?.startsWith("resource:") ? render.storageKey.slice("resource:".length) : "";
    if (fromKey) return fromKey;
    const url = render.url || "";
    const match = url.match(/\/resources\/([^/?#]+)\/file/);
    if (!match) return "";
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return "";
    }
}

function staleProcessUrl(url?: string) {
    if (!url) return false;
    if (url.startsWith("blob:")) return true;
    try {
        const parsed = new URL(url, "http://127.0.0.1");
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
            && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    } catch {
        return false;
    }
}

function isNotFoundDrawingError(error: unknown) {
    return error instanceof ApiError && (error.status === 404 || error.code === 404);
}

function isDrawingRevisionConflict(error: unknown) {
    return error instanceof ApiError && (error.status === 409 || error.code === 409);
}

export async function loadCanvasDrawing(projectId: string, drawingId: string, expectedScope?: CapturedUserScope) {
    if (!projectId || !drawingId) return null;
    const expected = captureScope(expectedScope);
    const key = drawingKey(projectId, drawingId, expected.userScope);
    if (usesBrowserLocalResourceStore()) {
        const envelope = await readEnvelope(key);
        assertUserScope(expected);
        return publishSnapshot(envelope, "browser");
    }

    let remote: { drawing: CanvasDrawingRecord } | undefined;
    let remoteError: unknown;
    try {
        remote = await getCanvasDrawing(projectId, drawingId, { expectedScope: expected });
    } catch (error) {
        remoteError = error;
    }
    assertUserScope(expected);
    const envelope = await readEnvelope(key);
    assertUserScope(expected);

    if (envelope.removedGeneration && !envelope.draft) return null;

    if (remoteError) {
        if (!isNotFoundDrawingError(remoteError)) throw remoteError;
        if (envelope.draft || envelope.committed) {
            const next: DrawingCacheEnvelope = {
                version: 3,
                committed: envelope.committed,
                draft: {
                    document: documentFields((envelope.draft?.document || envelope.committed)!),
                    generation: envelope.draft?.generation || 1,
                    canonicalMissing: true,
                    conflict: envelope.draft?.conflict,
                },
                removedGeneration: envelope.removedGeneration,
            };
            await writeEnvelope(key, next, expected);
            return publishSnapshot(next, "draft");
        }
        return null;
    }

    const record = remote!.drawing;
    if ((envelope.committed?.revision || 0) > record.revision) {
        return publishSnapshot(envelope, envelope.draft ? "draft" : "canonical");
    }
    const committed = snapshotFromRecord(record);
    const next: DrawingCacheEnvelope = {
        version: 3,
        committed,
        draft: envelope.draft,
        removedGeneration: undefined,
    };
    await writeEnvelope(key, next, expected);
    if (!next.draft) await cacheDrawingResources(key, record, expected);
    return publishSnapshot(next, next.draft ? "draft" : "canonical");
}

export async function saveCanvasDrawing(
    projectId: string,
    drawingId: string,
    engine: CanvasDrawingEngine,
    snapshot: unknown,
    previous?: CanvasDrawingSnapshot | null,
    preview?: Blob | null,
    render?: CanvasDrawingRenderDraft | null,
    expectedScope?: CapturedUserScope,
) {
    const expected = captureScope(expectedScope);
    const key = drawingKey(projectId, drawingId, expected.userScope);
    const summary = summarizeCanvasDrawing(engine, snapshot);
    const envelope = await readEnvelope(key);
    assertUserScope(expected);
    const generation = nextDraftGeneration(envelope);
    const updatedAt = new Date().toISOString();
    const casRevision = envelope.committed?.revision ?? 0;
    const draftDocument: CanvasDrawingSnapshot = {
        version: 2,
        engine,
        snapshot,
        revision: usesBrowserLocalResourceStore() ? (previous?.revision || envelope.draft?.document.revision || envelope.committed?.revision || 0) + 1 : casRevision,
        updatedAt,
        shapeCount: summary.shapeCount,
        pageCount: Math.min(summary.pageCount, 1),
        previewResourceId: previous?.previewResourceId ?? envelope.committed?.previewResourceId,
        renderResourceId: previous?.renderResourceId ?? envelope.committed?.renderResourceId,
    };
    const next: DrawingCacheEnvelope = {
        version: 3,
        committed: envelope.committed,
        draft: {
            document: draftDocument,
            generation,
            canonicalMissing: envelope.draft?.canonicalMissing,
            conflict: false,
        },
    };
    await writeEnvelope(key, next, expected);
    await writeDraftBlobs(key, generation, preview, render, draftDocument, expected);

    if (usesBrowserLocalResourceStore()) {
        await writeEnvelope(key, { version: 3, committed: draftDocument }, expected, generation);
        return { ...draftDocument, origin: "browser" as const };
    }

    return enqueueDrawingCommit(key, () => commitDrawingDraft(projectId, drawingId, key, generation, preview, render, expected));
}

async function commitDrawingDraft(
    projectId: string,
    drawingId: string,
    key: string,
    generation: number,
    preview: Blob | null | undefined,
    render: CanvasDrawingRenderDraft | null | undefined,
    expected: CapturedUserScope,
) {
    assertUserScope(expected);
    const envelope = await readEnvelope(key);
    const draft = envelope.draft;
    if (!draft || draft.generation < generation) return publishSnapshot(envelope, envelope.draft ? "draft" : "canonical")!;
    if (draft.canonicalMissing && envelope.committed) {
        throw new CanvasDrawingCanonicalMissingError();
    }

    try {
        const saved = await persistCanvasDrawingToBackend(projectId, drawingId, draft.document, envelope.committed, preview, render, expected);
        assertUserScope(expected);
        const live = await readEnvelope(key);
        assertUserScope(expected);
        const keepDraft = (live.draft?.generation || 0) > generation;
        const acked: DrawingCacheEnvelope = {
            version: 3,
            committed: saved,
            draft: keepDraft ? live.draft : undefined,
            removedGeneration: keepDraft ? live.removedGeneration : undefined,
        };
        await writeEnvelope(key, acked, expected, generation);
        if (!keepDraft && (preview || render)) {
            await writeDraftBlobs(key, generation, preview, render, saved, expected);
        }
        return publishSnapshot(acked, keepDraft ? "draft" : "canonical")!;
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        const live = await readEnvelope(key);
        if ((live.draft?.generation || 0) === generation) {
            await writeEnvelope(key, {
                ...live,
                draft: {
                    ...live.draft!,
                    conflict: isDrawingRevisionConflict(error),
                    canonicalMissing: live.draft!.canonicalMissing || isNotFoundDrawingError(error),
                },
            }, expected, generation);
        }
        if (isNotFoundDrawingError(error) && envelope.committed) throw new CanvasDrawingCanonicalMissingError();
        throw error;
    }
}

export async function createCanvasDrawingFromImage(
    projectId: string,
    drawingId: string,
    engine: CanvasDrawingEngine,
    image: { url: string; storageKey?: string; name: string; mimeType?: string },
    expectedScope?: CapturedUserScope,
) {
    const expected = captureScope(expectedScope);
    const dataUrl = await imageToDataUrl({ url: image.url, storageKey: image.storageKey, name: image.name, mimeType: image.mimeType });
    assertUserScope(expected);
    if (!dataUrl?.startsWith("data:image/")) throw new Error("无法读取来源图片");

    const { width, height, mimeType } = await readImageMeta(dataUrl);
    const source = { dataUrl, width, height, mimeType: mimeType || image.mimeType || "image/png", name: image.name || "来源图片" };
    const document = (await import("@/lib/canvas/canvas-drawing-excalidraw-document")).createExcalidrawDrawingFromImage(source);
    assertUserScope(expected);

    try {
        const render = await createInitialDrawingRender(dataUrl, width, height, document.pageId);
        assertUserScope(expected);
        return await saveCanvasDrawing(projectId, drawingId, engine, document.snapshot, null, render.blob, render, expected);
    } catch (error) {
        await removeCanvasDrawing(projectId, drawingId, expected).catch((cleanupError) => console.warn("清理失败的绘图初始化数据失败", cleanupError));
        throw error;
    }
}

export async function loadCanvasDrawingPreview(projectId: string, drawingId: string, expectedScope?: CapturedUserScope) {
    if (!projectId || !drawingId) return null;
    const expected = captureScope(expectedScope);
    const key = drawingKey(projectId, drawingId, expected.userScope);
    const envelope = await readEnvelope(key);
    assertUserScope(expected);
    if (envelope.removedGeneration && !envelope.draft) return null;
    if (envelope.draft) {
        return drawingPreviewStore.getItem(key);
    }
    if (usesBrowserLocalResourceStore()) return drawingPreviewStore.getItem(key);
    const saved = await loadCanvasDrawing(projectId, drawingId, expected);
    if (!saved) return null;
    assertUserScope(expected);
    return drawingPreviewStore.getItem(key);
}

export async function loadCanvasDrawingRender(projectId: string, drawingId: string, expectedScope?: CapturedUserScope) {
    if (!projectId || !drawingId) return null;
    const expected = captureScope(expectedScope);
    const key = drawingKey(projectId, drawingId, expected.userScope);
    const envelope = await readEnvelope(key);
    assertUserScope(expected);
    if (envelope.removedGeneration && !envelope.draft) return null;
    if (envelope.draft) {
        const cached = await drawingRenderStore.getItem(key);
        return cached ? { ...cached, ...liveRenderPublication(cached) } : null;
    }
    if (usesBrowserLocalResourceStore()) {
        const cached = await drawingRenderStore.getItem(key);
        return cached ? { ...cached, ...liveRenderPublication(cached) } : null;
    }
    const saved = await loadCanvasDrawing(projectId, drawingId, expected);
    if (!saved) return null;
    assertUserScope(expected);
    const next = await drawingRenderStore.getItem(key);
    return next ? { ...next, ...liveRenderPublication(next) } : null;
}

export async function saveCanvasDrawingRenderPublication(
    projectId: string,
    drawingId: string,
    revision: number,
    publication: Pick<CanvasDrawingRenderDraft, "storageKey" | "url">,
    expectedScope?: CapturedUserScope,
) {
    const expected = captureScope(expectedScope);
    const key = drawingKey(projectId, drawingId, expected.userScope);
    const render = await drawingRenderStore.getItem(key);
    const envelope = await readEnvelope(key);
    assertUserScope(expected);
    if (!render || render.revision !== revision) return false;
    if (envelope.draft && envelope.draft.document.revision !== revision && envelope.committed?.revision !== revision) return false;
    await drawingRenderStore.setItem(key, { ...render, ...liveRenderPublication({ ...render, ...publication }) });
    assertUserScope(expected);
    return true;
}

export async function removeCanvasDrawing(projectId: string, drawingId: string, expectedScope?: CapturedUserScope) {
    if (!projectId || !drawingId) return;
    const expected = captureScope(expectedScope);
    const key = drawingKey(projectId, drawingId, expected.userScope);
    const envelope = await readEnvelope(key);
    const generation = nextDraftGeneration(envelope);
    await writeEnvelope(key, { version: 3, removedGeneration: generation }, expected, generation);
    await Promise.all([
        drawingPreviewStore.removeItem(key),
        drawingRenderStore.removeItem(key),
    ]);
    if (usesBrowserLocalResourceStore()) {
        await drawingStore.removeItem(key);
        return;
    }
    try {
        await deleteCanvasDrawing(projectId, drawingId, { expectedScope: expected });
    } catch (error) {
        if (!isNotFoundDrawingError(error)) throw error;
    }
    assertUserScope(expected);
    const live = await readEnvelope(key);
    if ((live.draft?.generation || 0) > generation) return;
    await writeEnvelope(key, { version: 3, removedGeneration: generation }, expected, generation);
}

export async function cloneCanvasDrawing(projectId: string, sourceDrawingId: string, targetDrawingId: string, expectedScope?: CapturedUserScope) {
    const expected = captureScope(expectedScope);
    const [source, preview, render] = await Promise.all([
        loadCanvasDrawing(projectId, sourceDrawingId, expected),
        loadCanvasDrawingPreview(projectId, sourceDrawingId, expected),
        loadCanvasDrawingRender(projectId, sourceDrawingId, expected),
    ]);
    assertUserScope(expected);
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
    return saveCanvasDrawing(projectId, targetDrawingId, source.engine, source.snapshot, null, preview || undefined, renderDraft, expected);
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
    document: CanvasDrawingSnapshot,
    committed: CanvasDrawingSnapshot | undefined,
    preview: Blob | null | undefined,
    render: CanvasDrawingRenderDraft | null | undefined,
    expected: CapturedUserScope,
) {
    assertUserScope(expected);
    let previewResourceId = committed?.previewResourceId;
    if (preview) {
        if (digestDelayForTests) await digestDelayForTests();
        assertUserScope(expected);
        const digest = await contentDigest(preview);
        assertUserScope(expected);
        previewResourceId = (await uploadResourceFile(preview, "image", {
            fileName: `${drawingId}-preview.png`,
            idempotencyKey: `canvas-drawing-preview:sha256:${digest}`,
            expectedScope: expected,
        })).id;
    } else if (preview === null) {
        previewResourceId = "";
    }
    assertUserScope(expected);
    let renderRecord: { resourceId?: string; pageId?: string; width?: number; height?: number; mimeType?: string; background?: "white"; storageKey?: string } | undefined;
    if (render) {
        if (digestDelayForTests) await digestDelayForTests();
        assertUserScope(expected);
        const digest = await contentDigest(render.blob);
        assertUserScope(expected);
        const resource = await uploadResourceFile(render.blob, "image", {
            fileName: `${drawingId}-render.png`,
            width: render.width,
            height: render.height,
            idempotencyKey: `canvas-drawing-render:sha256:${digest}`,
            expectedScope: expected,
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
    assertUserScope(expected);
    const saved = await putCanvasDrawing(projectId, drawingId, {
        drawingId,
        engine: document.engine,
        revision: committed?.revision ?? 0,
        snapshot: document.snapshot,
        shapeCount: document.shapeCount,
        pageCount: Math.min(document.pageCount, 1),
        previewResourceId,
        render: renderRecord,
    }, { expectedScope: expected });
    assertUserScope(expected);
    return snapshotFromRecord(saved.drawing, document.snapshot);
}

async function fetchDrawingResourceBlob(resourceId: string, expected: CapturedUserScope) {
    assertUserScope(expected);
    try {
        const response = await http.raw<Blob>({
            method: "get",
            url: `/resources/${encodeURIComponent(resourceId)}/file?proxy=1`,
            responseType: "blob",
            expectedScope: expected,
        });
        assertUserScope(expected);
        return response.data instanceof Blob ? response.data : new Blob([response.data as BlobPart]);
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        return null;
    }
}

async function cacheDrawingResources(key: string, record: CanvasDrawingRecord, expected: CapturedUserScope) {
    assertUserScope(expected);
    const blocked = async () => {
        const live = await readEnvelope(key);
        return Boolean(live.draft || (live.removedGeneration && !live.draft));
    };
    if (await blocked()) return;
    if (record.previewResourceId) {
        const blob = await fetchDrawingResourceBlob(record.previewResourceId, expected);
        assertUserScope(expected);
        if (await blocked()) return;
        if (blob) await drawingPreviewStore.setItem(key, blob);
    }
    if (record.render?.resourceId) {
        const blob = await fetchDrawingResourceBlob(record.render.resourceId, expected);
        assertUserScope(expected);
        if (await blocked()) return;
        if (!blob) return;
        const previous = await drawingRenderStore.getItem(key);
        await drawingRenderStore.setItem(key, {
            blob,
            pageId: record.render.pageId || previous?.pageId || "",
            width: record.render.width || previous?.width || 0,
            height: record.render.height || previous?.height || 0,
            mimeType: record.render.mimeType || previous?.mimeType || blob.type || "image/png",
            background: "white",
            storageKey: record.render.storageKey || resourceStorageKey(record.render.resourceId),
            url: resourceFileUrl(record.render.resourceId),
            version: 1,
            revision: record.revision,
            updatedAt: record.updatedAt,
        });
    }
}

function snapshotFromRecord(record: CanvasDrawingRecord, snapshot: unknown = record.snapshot): CanvasDrawingSnapshot {
    return documentFields(normalizeCanvasDrawingSnapshot({
        version: 2,
        engine: record.engine,
        snapshot,
        revision: record.revision,
        updatedAt: record.updatedAt,
        shapeCount: record.shapeCount,
        pageCount: record.pageCount,
        previewResourceId: record.previewResourceId,
        renderResourceId: record.render?.resourceId,
    })!);
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

export function peekCanvasDrawingCacheForTests(projectId: string, drawingId: string, userScope: string) {
    return drawingStore.getItem(drawingKey(projectId, drawingId, userScope));
}

export function setCanvasDrawingDigestDelayForTests(delay?: () => Promise<void>) {
    digestDelayForTests = delay;
}

export function replaceCanvasDrawingStoresForTests(stores?: {
    documents?: DrawingKeyStore<DrawingCacheEnvelope | CanvasDrawingSnapshot>;
    previews?: DrawingKeyStore<Blob>;
    renders?: DrawingKeyStore<CanvasDrawingRender>;
}) {
    drawingStore = stores?.documents ?? defaultDrawingStore;
    drawingPreviewStore = stores?.previews ?? defaultDrawingPreviewStore;
    drawingRenderStore = stores?.renders ?? defaultDrawingRenderStore;
}

export function resetCanvasDrawingStorageForTests() {
    drawingCommitChains.clear();
    envelopeLocks.clear();
    digestDelayForTests = undefined;
    drawingStore = defaultDrawingStore;
    drawingPreviewStore = defaultDrawingPreviewStore;
    drawingRenderStore = defaultDrawingRenderStore;
}
