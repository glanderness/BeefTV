import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

mock.module("@/lib/canvas/canvas-drawing-excalidraw-document", () => ({
    createExcalidrawDrawingFromImage: (source: { dataUrl: string }) => ({
        snapshot: { elements: [{ id: "from-image", isDeleted: false }], files: { img: { dataURL: source.dataUrl } } },
        pageId: "page",
    }),
}));

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import {
    cloneCanvasDrawing,
    createCanvasDrawingFromImage,
    loadCanvasDrawing,
    loadCanvasDrawingPreview,
    loadCanvasDrawingRender,
    removeCanvasDrawing,
    replaceCanvasDrawingStoresForTests,
    resetCanvasDrawingStorageForTests,
    saveCanvasDrawing,
    saveCanvasDrawingRenderPublication,
    type CanvasDrawingSnapshot,
} from "@/lib/canvas/canvas-drawing-storage";
import { apiClient } from "@/services/api/request";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function memoryStore<T>(values: Map<string, T>, hooks?: { beforeSet?: (key: string, value: T) => Promise<void> | void }) {
    return {
        async getItem(key: string) {
            return values.get(key) ?? null;
        },
        async setItem(key: string, value: T) {
            await hooks?.beforeSet?.(key, value);
            values.set(key, value);
            return value;
        },
        async removeItem(key: string) {
            values.delete(key);
        },
    };
}

function envelope(data: unknown, status = 200) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers: {}, config: {} as never };
}

function failure(status: number, msg: string, reason?: string) {
    return { data: { code: status, msg, data: null, reason }, status, statusText: "ERR", headers: {}, config: {} as never };
}

function requestBody(config: { data?: unknown }) {
    const data = config.data;
    if (typeof data === "string") {
        try { return JSON.parse(data) as Record<string, unknown>; } catch { return {}; }
    }
    return data && typeof data === "object" ? data as Record<string, unknown> : {};
}

function snapshotOf(text: string) {
    return { elements: [{ id: text, isDeleted: false }] };
}

function drawingRecord(snapshot: unknown, revision: number, extras: Record<string, unknown> = {}) {
    return {
        drawing: {
            drawingId: "d1",
            engine: "excalidraw",
            revision,
            snapshot,
            shapeCount: 1,
            pageCount: 1,
            createdAt: "2026-10-02T00:00:00.000Z",
            updatedAt: "2026-10-02T00:00:00.000Z",
            ...extras,
        },
    };
}

async function withAdapter<T>(adapter: NonNullable<typeof apiClient.defaults.adapter>, run: () => Promise<T>) {
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
        return await run();
    } finally {
        apiClient.defaults.adapter = previous;
    }
}

const spies: Array<{ mockRestore: () => void }> = [];
const documents = new Map<string, unknown>();
const previews = new Map<string, Blob>();
const renders = new Map<string, unknown>();

function desktopBackend() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

function browserLocalMode() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(false));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

function installStores(hooks?: {
    docBeforeSet?: (key: string, value: unknown) => Promise<void> | void;
    previewBeforeSet?: (key: string, value: Blob) => Promise<void> | void;
}) {
    documents.clear();
    previews.clear();
    renders.clear();
    replaceCanvasDrawingStoresForTests({
        documents: memoryStore(documents as Map<string, never>, { beforeSet: hooks?.docBeforeSet }),
        previews: memoryStore(previews, { beforeSet: hooks?.previewBeforeSet }),
        renders: memoryStore(renders as Map<string, never>),
    });
}

afterEach(() => {
    while (spies.length) spies.pop()?.mockRestore();
    resetCanvasDrawingStorageForTests();
    documents.clear();
    previews.clear();
    renders.clear();
});

describe("canvas drawing storage", () => {
    test("SQLite mode reads drawing, preview, and render directly from backend without touching IndexedDB", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        try {
            const loaded = await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/drawings/d1")) {
                    return envelope(drawingRecord(snapshotOf("remote"), 4, {
                        previewResourceId: "pv-1",
                        render: { resourceId: "rd-1", pageId: "p1", width: 100, height: 80, mimeType: "image/png", background: "white" },
                    }));
                }
                if (String(config.url).includes("/resources/pv-1/file")) {
                    return { data: new Blob(["remote-preview"], { type: "image/png" }), status: 200, statusText: "OK", headers: {}, config: {} as never };
                }
                if (String(config.url).includes("/resources/rd-1/file")) {
                    return { data: new Blob(["remote-render"], { type: "image/png" }), status: 200, statusText: "OK", headers: {}, config: {} as never };
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => ({
                document: await loadCanvasDrawing("p1", "d1"),
                preview: await loadCanvasDrawingPreview("p1", "d1"),
                render: await loadCanvasDrawingRender("p1", "d1"),
            }));

            expect(loaded.document?.origin).toBe("canonical");
            expect(loaded.document?.revision).toBe(4);
            expect(loaded.document?.snapshot).toEqual(snapshotOf("remote"));
            expect(await loaded.preview?.text()).toBe("remote-preview");
            expect(await loaded.render?.blob.text()).toBe("remote-render");
            expect(loaded.render?.storageKey).toBe("resource:rd-1");
            expect(loaded.render?.url).toContain("/resources/rd-1/file");
            expect(documents.size).toBe(0);
            expect(previews.size).toBe(0);
            expect(renders.size).toBe(0);
        } finally {
            restore();
        }
    });

    test("SQLite mode returns null on 404 and propagates real read errors", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        try {
            await withAdapter(async () => failure(404, "画板不存在"), async () => {
                expect(await loadCanvasDrawing("p1", "d1")).toBeNull();
                expect(await loadCanvasDrawingPreview("p1", "d1")).toBeNull();
                expect(await loadCanvasDrawingRender("p1", "d1")).toBeNull();
            });
            await withAdapter(async () => failure(503, "服务暂时不可用，请稍后重试"), async () => {
                await expect(loadCanvasDrawing("p1", "d1")).rejects.toThrow(/服务暂时不可用/);
            });
        } finally {
            restore();
        }
    });

    test("SQLite mode serializes concurrent saves with monotonic revisions and skips IndexedDB", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const enteredFirst = deferred();
        const releaseFirst = deferred();
        const sent: Array<{ revision: number; snapshot: unknown }> = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: `res-${sent.length + 1}`, status: "ready" } });
                if (String(config.method).toLowerCase() === "put" && String(config.url).includes("/drawings/d1")) {
                    const body = requestBody(config) as { drawing: { revision: number; snapshot: unknown; previewResourceId?: string } };
                    sent.push({ revision: body.drawing.revision, snapshot: body.drawing.snapshot });
                    if (sent.length === 1) {
                        enteredFirst.resolve();
                        await releaseFirst.promise;
                    }
                    return envelope(drawingRecord(body.drawing.snapshot, body.drawing.revision + 1, { previewResourceId: body.drawing.previewResourceId }));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const first = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("first"), null, new Blob(["a"]));
                await enteredFirst.promise;
                const second = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("second"), null, new Blob(["b"]));
                releaseFirst.resolve();
                const firstSaved = await first;
                const secondSaved = await second;
                expect(firstSaved.revision).toBe(1);
                expect(secondSaved.revision).toBe(2);
                expect(secondSaved.snapshot).toEqual(snapshotOf("second"));
                expect(sent).toEqual([
                    { revision: 0, snapshot: snapshotOf("first") },
                    { revision: 1, snapshot: snapshotOf("second") },
                ]);
                expect(documents.size).toBe(0);
                expect(previews.size).toBe(0);
                expect(renders.size).toBe(0);
            });
        } finally {
            restore();
        }
    });

    test("SQLite mode auto-rebases once on 409 revision conflict without re-uploading blobs", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        let resourceUploads = 0;
        const putRevisions: number[] = [];
        let preservedPreviewOnRetry = "";
        try {
            const saved = await withAdapter(async (config) => {
                if (String(config.url).includes("/resources") && String(config.method).toLowerCase() === "post") {
                    resourceUploads += 1;
                    return envelope({ resource: { id: "res-new", status: "ready" } });
                }
                if (String(config.method).toLowerCase() === "put" && String(config.url).includes("/drawings/d1")) {
                    const body = requestBody(config) as { drawing: { revision: number; snapshot: unknown; previewResourceId?: string } };
                    putRevisions.push(body.drawing.revision);
                    if (body.drawing.revision === 0) {
                        return failure(409, "画板已有更新", "conflict");
                    }
                    preservedPreviewOnRetry = body.drawing.previewResourceId || "";
                    return envelope(drawingRecord(body.drawing.snapshot, body.drawing.revision + 1, { previewResourceId: body.drawing.previewResourceId }));
                }
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/drawings/d1")) {
                    return envelope(drawingRecord(snapshotOf("server"), 5, { previewResourceId: "pv-existing" }));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("mine"), null, new Blob(["new-preview"])));

            expect(resourceUploads).toBe(1);
            expect(putRevisions).toEqual([0, 5]);
            expect(preservedPreviewOnRetry).toBe("res-new");
            expect(saved.revision).toBe(6);
            expect(saved.snapshot).toEqual(snapshotOf("mine"));
        } finally {
            restore();
        }
    });

    test("SQLite mode does not retry 409 failed_precondition for deleted drawings", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        let puts = 0;
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    puts += 1;
                    return failure(409, "画板已删除，不能重新导入", "failed_precondition");
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("keep"), null, new Blob(["p"])))
                    .rejects.toThrow(/画板已删除/);
            });
            expect(puts).toBe(1);
        } finally {
            restore();
        }
    });

    test("delete prevents a stale in-flight GET from resurrecting the drawing", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const staleGet = deferred();
        const gate = deferred();
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get") {
                    staleGet.resolve();
                    await gate.promise;
                    return envelope(drawingRecord(snapshotOf("stale"), 2));
                }
                if (String(config.method).toLowerCase() === "delete") return envelope({ id: "d1" });
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const loading = loadCanvasDrawing("p1", "d1");
                await staleGet.promise;
                await removeCanvasDrawing("p1", "d1");
                gate.resolve();
                expect(await loading).toBeNull();
            });
        } finally {
            restore();
        }
    });

    test("stale GET finishing after a newer save returns the newer saved drawing", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const enteredGet = deferred();
        const releaseGet = deferred();
        try {
            const loading = withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/drawings/")) {
                    enteredGet.resolve();
                    await releaseGet.promise;
                    return envelope(drawingRecord(snapshotOf("stale"), 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => loadCanvasDrawing("p1", "d1"));

            await enteredGet.promise;
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-new", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") return envelope(drawingRecord(snapshotOf("fresh"), 4));
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("fresh"), null, new Blob(["fresh"])));

            releaseGet.resolve();
            const loaded = await loading;
            expect(loaded?.snapshot).toEqual(snapshotOf("fresh"));
            expect(loaded?.revision).toBe(4);
        } finally {
            restore();
        }
    });

    test("cloneCanvasDrawing reads source once and saves snapshot with preview and render", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        let sourceGets = 0;
        let clonedPutPayload: Record<string, unknown> | undefined;
        try {
            const cloned = await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/drawings/d-src")) {
                    sourceGets += 1;
                    return envelope(drawingRecord(snapshotOf("source-art"), 3, {
                        drawingId: "d-src",
                        previewResourceId: "pv-src",
                        render: { resourceId: "rd-src", pageId: "p1", width: 64, height: 64, mimeType: "image/png", background: "white" },
                    }));
                }
                if (String(config.url).includes("/resources/pv-src/file")) {
                    return { data: new Blob(["src-preview"], { type: "image/png" }), status: 200, statusText: "OK", headers: {}, config: {} as never };
                }
                if (String(config.url).includes("/resources/rd-src/file")) {
                    return { data: new Blob(["src-render"], { type: "image/png" }), status: 200, statusText: "OK", headers: {}, config: {} as never };
                }
                if (String(config.method).toLowerCase() === "post" && String(config.url).includes("/resources")) {
                    return envelope({ resource: { id: "res-cloned", status: "ready" } });
                }
                if (String(config.method).toLowerCase() === "put" && String(config.url).includes("/drawings/d-dst")) {
                    const body = requestBody(config) as { drawing: Record<string, unknown> };
                    clonedPutPayload = body.drawing;
                    return envelope(drawingRecord(body.drawing.snapshot, 1, {
                        drawingId: "d-dst",
                        previewResourceId: body.drawing.previewResourceId,
                        render: body.drawing.render,
                    }));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => cloneCanvasDrawing("p1", "d-src", "d-dst"));

            expect(sourceGets).toBe(1);
            expect(cloned?.revision).toBe(1);
            expect(cloned?.snapshot).toEqual(snapshotOf("source-art"));
            expect(clonedPutPayload?.previewResourceId).toBe("res-cloned");
            expect((clonedPutPayload?.render as { resourceId?: string } | undefined)?.resourceId).toBe("res-cloned");
        } finally {
            restore();
        }
    });

    test("failing createCanvasDrawingFromImage propagates error and does not DELETE", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const methods: string[] = [];
        const originalImage = globalThis.Image;
        const originalDocument = globalThis.document;
        const originalWindow = globalThis.window;
        class FakeImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            naturalWidth = 8;
            naturalHeight = 8;
            width = 8;
            height = 8;
            set src(_value: string) {
                this.onload?.();
            }
        }
        (globalThis as { Image: typeof Image }).Image = FakeImage as unknown as typeof Image;
        globalThis.document = {
            createElement: (tag: string) => {
                if (tag !== "canvas") throw new Error(`unexpected element ${tag}`);
                return {
                    width: 0,
                    height: 0,
                    getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
                    toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(["from-image"], { type: "image/png" })),
                };
            },
        } as never;
        globalThis.window = {
            document: globalThis.document,
            location: { protocol: "http:" },
            Image: FakeImage,
        } as never;
        const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        try {
            await withAdapter(async (config) => {
                methods.push(`${String(config.method).toLowerCase()} ${String(config.url)}`);
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") return failure(500, "工作区暂时无法保存");
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(createCanvasDrawingFromImage("p1", "d1", "excalidraw", { url: png, name: "来源.png" }))
                    .rejects.toThrow(/工作区暂时无法保存/);
            });
            expect(methods.some((item) => item.startsWith("delete "))).toBe(false);
        } finally {
            (globalThis as { Image: typeof Image }).Image = originalImage;
            if (originalDocument) globalThis.document = originalDocument;
            else delete (globalThis as { document?: unknown }).document;
            if (originalWindow) globalThis.window = originalWindow;
            else delete (globalThis as { window?: unknown }).window;
            restore();
        }
    });

    test("SQLite mode handles render upload, omission, and explicit clear, and refuses fake publication", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const bodies: Array<Record<string, unknown>> = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "post" && String(config.url).includes("/resources")) {
                    return envelope({ resource: { id: "res-render-1", status: "ready" } });
                }
                if (String(config.method).toLowerCase() === "put" && String(config.url).includes("/drawings/d1")) {
                    const body = requestBody(config) as { drawing: Record<string, unknown> };
                    bodies.push(body.drawing);
                    return envelope(drawingRecord(body.drawing.snapshot, Number(body.drawing.revision || 0) + 1, {
                        render: body.drawing.render && (body.drawing.render as { resourceId?: string }).resourceId ? body.drawing.render : undefined,
                    }));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const first = await saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("with-render"), null, undefined, {
                    blob: new Blob(["rd"]),
                    pageId: "page",
                    width: 32,
                    height: 32,
                    mimeType: "image/png",
                    background: "white",
                });
                const second = await saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("keep-render"), first, undefined, undefined);
                await saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("clear-render"), second, undefined, null);
                expect(await saveCanvasDrawingRenderPublication("p1", "d1", 3, { storageKey: "resource:x", url: "/api/resources/x/file" })).toBe(false);
            });
            expect((bodies[0]?.render as { resourceId?: string; storageKey?: string } | undefined)).toMatchObject({
                resourceId: "res-render-1",
                storageKey: "resource:res-render-1",
            });
            expect("render" in (bodies[1] || {})).toBe(false);
            expect(bodies[2]?.render).toEqual({ resourceId: "" });
        } finally {
            restore();
        }
    });

    test("browser-local mode commits blobs before document, rolls back on write error, and keeps revisions monotonic", async () => {
        const restore = switchScope("browser-only");
        browserLocalMode();
        let failPreview = false;
        let failDoc = false;
        installStores({
            previewBeforeSet: async () => {
                if (failPreview) throw new Error("quota exceeded");
            },
            docBeforeSet: async () => {
                if (failDoc) throw new Error("doc write failed");
            },
        });
        try {
            const first = await saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("v1"), null, new Blob(["pv-v1"]));
            expect(first.revision).toBe(1);

            failPreview = true;
            await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("v2-fail"), first, new Blob(["pv-v2"]))).rejects.toThrow(/quota exceeded/);
            failPreview = false;
            expect((await loadCanvasDrawing("p1", "d1"))?.revision).toBe(1);
            expect(await loadCanvasDrawingPreview("p1", "d1").then((blob) => blob?.text())).toBe("pv-v1");

            failDoc = true;
            await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("v2-doc-fail"), first, new Blob(["pv-rollback"]))).rejects.toThrow(/doc write failed/);
            failDoc = false;
            expect((await loadCanvasDrawing("p1", "d1"))?.revision).toBe(1);
            expect(await loadCanvasDrawingPreview("p1", "d1").then((blob) => blob?.text())).toBe("pv-v1");

            // Concurrent double-save with the same stale `previous` must advance revisions strictly monotonically.
            const [a, b] = await Promise.all([
                saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("v2"), first, new Blob(["pv-2"])),
                saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("v3"), first, new Blob(["pv-3"])),
            ]);
            expect(a.revision).toBe(2);
            expect(b.revision).toBe(3);
            expect((await loadCanvasDrawing("p1", "d1"))?.snapshot).toEqual(snapshotOf("v3"));
        } finally {
            restore();
        }
    });

    test("browser-local mode saves, loads, publishes render, unwraps legacy v3 envelopes, and removes cleanly", async () => {
        const restore = switchScope("browser-only");
        browserLocalMode();
        installStores();
        try {
            const saved = await saveCanvasDrawing(
                "p1",
                "d1",
                "excalidraw",
                snapshotOf("browser-art"),
                null,
                new Blob(["pv"]),
                { blob: new Blob(["rd"]), pageId: "page", width: 16, height: 16, mimeType: "image/png", background: "white" },
            );
            expect(saved.origin).toBe("browser");
            expect(saved.revision).toBe(1);

            const published = await saveCanvasDrawingRenderPublication("p1", "d1", 1, {
                storageKey: "resource:pub-1",
                url: "/api/resources/pub-1/file",
            });
            expect(published).toBe(true);
            const loadedRender = await loadCanvasDrawingRender("p1", "d1");
            expect(loadedRender?.storageKey).toBe("resource:pub-1");
            expect(await loadedRender?.blob.text()).toBe("rd");
            expect(await loadCanvasDrawingPreview("p1", "d1").then((blob) => blob?.text())).toBe("pv");

            // Legacy v3 envelope in browser-local IndexedDB stays readable.
            documents.set("browser-only:p1:d-legacy", {
                version: 3,
                committed: {
                    version: 2,
                    engine: "excalidraw",
                    snapshot: snapshotOf("legacy-v3"),
                    revision: 3,
                    updatedAt: "2026-10-01T00:00:00.000Z",
                    shapeCount: 1,
                    pageCount: 1,
                } satisfies CanvasDrawingSnapshot,
            });
            const legacy = await loadCanvasDrawing("p1", "d-legacy");
            expect(legacy?.snapshot).toEqual(snapshotOf("legacy-v3"));
            expect(legacy?.revision).toBe(3);

            await removeCanvasDrawing("p1", "d1");
            expect(await loadCanvasDrawing("p1", "d1")).toBeNull();
            expect(await loadCanvasDrawingPreview("p1", "d1")).toBeNull();
            expect(await loadCanvasDrawingRender("p1", "d1")).toBeNull();
        } finally {
            restore();
        }
    });
});
