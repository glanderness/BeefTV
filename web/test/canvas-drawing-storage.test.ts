import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
import {
    CanvasDrawingCanonicalMissingError,
    loadCanvasDrawing,
    loadCanvasDrawingPreview,
    peekCanvasDrawingCacheForTests,
    removeCanvasDrawing,
    replaceCanvasDrawingStoresForTests,
    resetCanvasDrawingStorageForTests,
    saveCanvasDrawing,
    setCanvasDrawingDigestDelayForTests,
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

function installStores(hooks?: { beforeSet?: (key: string, value: unknown) => Promise<void> | void }) {
    documents.clear();
    previews.clear();
    renders.clear();
    replaceCanvasDrawingStoresForTests({
        documents: memoryStore(documents, hooks),
        previews: memoryStore(previews),
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
    test("pending save failure then restart retains actual snapshot and blobs", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const preview = new Blob(["preview-v1"], { type: "image/png" });
        const renderBlob = new Blob(["render-v1"], { type: "image/png" });
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources") && String(config.method).toLowerCase() === "post") {
                    return envelope({ resource: { id: "res-preview", status: "ready" } });
                }
                return failure(500, "工作区暂时无法保存");
            }, async () => {
                await expect(saveCanvasDrawing(
                    "p1",
                    "d1",
                    "excalidraw",
                    snapshotOf("keep-me"),
                    null,
                    preview,
                    { blob: renderBlob, pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" },
                    captureUserScope(),
                )).rejects.toThrow(/工作区暂时无法保存/);
            });

            const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot } };
            expect(cached?.draft?.document.snapshot).toEqual(snapshotOf("keep-me"));
            expect(await previews.get("owner-a:p1:d1")?.text()).toBe("preview-v1");
            expect(await (renders.get("owner-a:p1:d1") as { blob: Blob } | undefined)?.blob.text()).toBe("render-v1");

            const loaded = await withAdapter(async () => failure(500, "读失败"), async () => loadCanvasDrawing("p1", "d1", captureUserScope()).catch((error) => error));
            expect(loaded).toBeInstanceOf(Error);
            expect((loaded as Error).message).toMatch(/读失败/);

            const recovered = await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/drawings/")) return failure(404, "画板不存在");
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => loadCanvasDrawing("p1", "d1", captureUserScope()));
            expect(recovered?.origin).toBe("draft");
            expect(recovered?.snapshot).toEqual(snapshotOf("keep-me"));
            expect(recovered?.canonicalMissing).toBe(true);
            expect(await loadCanvasDrawingPreview("p1", "d1", captureUserScope()).then((blob) => blob?.text())).toBe("preview-v1");
        } finally {
            restore();
        }
    });

    test("later edit during delayed reply is not lost", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const gate = deferred();
        let drawingPuts = 0;
        const snapshots: unknown[] = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put" && String(config.url).includes("/drawings/")) {
                    const body = requestBody(config) as { drawing: { revision: number; snapshot: unknown } };
                    drawingPuts += 1;
                    snapshots.push(body.drawing.snapshot);
                    await gate.promise;
                    return envelope(drawingRecord(body.drawing.snapshot, (body.drawing.revision || 0) + 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const first = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("first"), null, new Blob(["a"]), undefined, captureUserScope());
                const deadline = Date.now() + 2000;
                while (Date.now() < deadline) {
                    const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot } };
                    if (cached?.draft?.document.snapshot) break;
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                const second = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("second"), null, new Blob(["b"]), undefined, captureUserScope());
                while (Date.now() < deadline) {
                    const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot } };
                    if (JSON.stringify(cached?.draft?.document.snapshot) === JSON.stringify(snapshotOf("second"))) break;
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                gate.resolve();
                await first;
                const saved = await second;
                expect(saved.snapshot).toEqual(snapshotOf("second"));
                const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { committed?: CanvasDrawingSnapshot; draft?: { document: CanvasDrawingSnapshot } };
                expect(cached.draft?.document.snapshot ?? cached.committed?.snapshot).toEqual(snapshotOf("second"));
                expect(snapshots.at(-1)).toEqual(snapshotOf("second"));
                expect(drawingPuts).toBeGreaterThan(0);
            });
        } finally {
            restore();
        }
    });

    test("A-B-A during hash prevents the old epoch from publishing", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const digest = deferred();
        const puts: string[] = [];
        let delayedOnce = false;
        setCanvasDrawingDigestDelayForTests(async () => {
            if (delayedOnce) return;
            delayedOnce = true;
            await digest.promise;
        });
        try {
            const firstEpoch = captureUserScope();
            await withAdapter(async (config) => {
                puts.push(`${(config as { expectedScope?: { epoch: number } }).expectedScope?.epoch ?? "none"} ${String(config.method)} ${String(config.url)}`);
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-new", status: "ready" } });
                return failure(500, "新纪元保存失败");
            }, async () => {
                const pending = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("old"), null, new Blob(["old"]), undefined, firstEpoch);
                await new Promise((resolve) => setTimeout(resolve, 10));
                setActiveUserScope("owner-b");
                setActiveUserScope("owner-a");
                const secondEpoch = captureUserScope();
                expect(secondEpoch.epoch).not.toBe(firstEpoch.epoch);
                const second = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("new"), null, new Blob(["new"]), undefined, secondEpoch);
                const settled = Promise.allSettled([pending, second]);
                const deadline = Date.now() + 2000;
                while (Date.now() < deadline) {
                    const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot } };
                    if (JSON.stringify(cached?.draft?.document.snapshot) === JSON.stringify(snapshotOf("new"))) break;
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                digest.resolve();
                const [firstResult, secondResult] = await settled;
                expect(firstResult.status).toBe("rejected");
                expect(firstResult.status === "rejected" && firstResult.reason).toBeInstanceOf(UserScopeAbandonedError);
                expect(secondResult.status).toBe("rejected");
                expect(String(secondResult.status === "rejected" ? secondResult.reason : "")).toMatch(/新纪元保存失败/);
                expect(puts.filter((item) => item.startsWith(`${firstEpoch.epoch} `))).toEqual([]);
                const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot } };
                expect(cached.draft?.document.snapshot).toEqual(snapshotOf("new"));
            });
        } finally {
            setCanvasDrawingDigestDelayForTests();
            restore();
        }
    });

    test("native preview does not keep stale media after canonical change", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        documents.set("owner-a:p1:d1", {
            version: 3,
            committed: {
                version: 2,
                engine: "excalidraw",
                snapshot: snapshotOf("old"),
                revision: 2,
                updatedAt: "2026-10-01T00:00:00.000Z",
                shapeCount: 1,
                pageCount: 1,
                previewResourceId: "pv-old",
            },
        });
        previews.set("owner-a:p1:d1", new Blob(["old-preview"], { type: "image/png" }));
        try {
            const blob = await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/drawings/d1")) {
                    return envelope(drawingRecord(snapshotOf("remote"), 4, { previewResourceId: "pv-new" }));
                }
                if (String(config.url).includes("/resources/pv-new/file")) {
                    return { data: new Blob(["new-preview"], { type: "image/png" }), status: 200, statusText: "OK", headers: {}, config: {} as never };
                }
                if (String(config.url).includes("/resources/pv-old/file")) {
                    throw new Error("stale preview must not be read");
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => loadCanvasDrawingPreview("p1", "d1", captureUserScope()));
            expect(await blob?.text()).toBe("new-preview");
        } finally {
            restore();
        }
    });

    test("native empty cache reads actual remote", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        try {
            const loaded = await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/drawings/d1")) {
                    return envelope(drawingRecord(snapshotOf("remote"), 4, { previewResourceId: "pv-1" }));
                }
                if (String(config.url).includes("/resources/pv-1/file")) {
                    return { data: new Blob(["remote-preview"], { type: "image/png" }), status: 200, statusText: "OK", headers: {}, config: {} as never };
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const document = await loadCanvasDrawing("p1", "d1", captureUserScope());
                const preview = await loadCanvasDrawingPreview("p1", "d1", captureUserScope());
                return { document, preview };
            });
            expect(loaded.document?.origin).toBe("canonical");
            expect(loaded.document?.revision).toBe(4);
            expect(loaded.document?.snapshot).toEqual(snapshotOf("remote"));
            expect(await loaded.preview?.text()).toBe("remote-preview");
        } finally {
            restore();
        }
    });

    test("real read error is not treated as success", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        documents.set("owner-a:p1:d1", { version: 2, engine: "excalidraw", snapshot: snapshotOf("stale"), revision: 9, updatedAt: "2026-10-01T00:00:00.000Z", shapeCount: 1, pageCount: 1 });
        try {
            await withAdapter(async () => failure(503, "服务暂时不可用，请稍后重试"), async () => {
                await expect(loadCanvasDrawing("p1", "d1", captureUserScope())).rejects.toThrow(/服务暂时不可用/);
            });
        } finally {
            restore();
        }
    });

    test("CAS conflict preserves the editor draft", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put" && String(config.url).includes("/drawings/")) {
                    return failure(409, "画板已有更新，已停止覆盖；请保留本地草稿并加载最新版本", "conflict");
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("mine"), null, new Blob(["p"]), undefined, captureUserScope()))
                    .rejects.toThrow(/画板已有更新/);
            });
            const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot; conflict?: boolean } };
            expect(cached.draft?.document.snapshot).toEqual(snapshotOf("mine"));
            expect(cached.draft?.conflict).toBe(true);
        } finally {
            restore();
        }
    });

    test("failed_precondition keeps the actual draft and blocks reimport of the old id", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const puts: number[] = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    puts.push(1);
                    return failure(409, "画板已删除，不能重新导入", "failed_precondition");
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("keep"), null, new Blob(["p"]), undefined, captureUserScope()))
                    .rejects.toBeInstanceOf(CanvasDrawingCanonicalMissingError);
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("keep-2"), null, new Blob(["q"]), undefined, captureUserScope()))
                    .rejects.toBeInstanceOf(CanvasDrawingCanonicalMissingError);
            });
            expect(puts).toEqual([1]);
            const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot; blockedReimport?: boolean } };
            expect(cached.draft?.document.snapshot).toEqual(snapshotOf("keep-2"));
            expect(cached.draft?.blockedReimport).toBe(true);
        } finally {
            restore();
        }
    });

    test("failed_precondition survives GET 404 and still blocks reimport", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const puts: number[] = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    puts.push(1);
                    return failure(409, "画板已删除，不能重新导入", "failed_precondition");
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("keep"), null, new Blob(["p"]), undefined, captureUserScope()))
                    .rejects.toBeInstanceOf(CanvasDrawingCanonicalMissingError);
            });

            const loaded = await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get") return failure(404, "画板不存在");
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => loadCanvasDrawing("p1", "d1", captureUserScope()));
            expect(loaded?.snapshot).toEqual(snapshotOf("keep"));
            expect(loaded?.canonicalMissing).toBe(true);

            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-2", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    puts.push(1);
                    return envelope(drawingRecord(snapshotOf("resurrected"), 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("keep-3"), loaded, new Blob(["q"]), undefined, captureUserScope()))
                    .rejects.toBeInstanceOf(CanvasDrawingCanonicalMissingError);
            });
            expect(puts).toEqual([1]);
            const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot; blockedReimport?: boolean } };
            expect(cached.draft?.document.snapshot).toEqual(snapshotOf("keep-3"));
            expect(cached.draft?.blockedReimport).toBe(true);
        } finally {
            restore();
        }
    });

    test("404 keeps recoverable draft and does not PUT deleted committed data", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        documents.set("owner-a:p1:d1", {
            version: 3,
            committed: { version: 2, engine: "excalidraw", snapshot: snapshotOf("was-saved"), revision: 3, updatedAt: "2026-10-01T00:00:00.000Z", shapeCount: 1, pageCount: 1 },
        });
        const puts: number[] = [];
        try {
            const loaded = await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get") return failure(404, "画板不存在");
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => loadCanvasDrawing("p1", "d1", captureUserScope()));
            expect(loaded?.canonicalMissing).toBe(true);
            expect(loaded?.snapshot).toEqual(snapshotOf("was-saved"));
            expect(loaded?.revision).toBe(3);

            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "put") {
                    puts.push(1);
                    return envelope(drawingRecord(snapshotOf("resurrected"), 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("edit"), loaded, undefined, undefined, captureUserScope()))
                    .rejects.toBeInstanceOf(CanvasDrawingCanonicalMissingError);
            });
            expect(puts).toEqual([]);
        } finally {
            restore();
        }
    });

    test("delete prevents a stale GET from restoring the drawing", async () => {
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
                const loading = loadCanvasDrawing("p1", "d1", captureUserScope());
                await staleGet.promise;
                await removeCanvasDrawing("p1", "d1", captureUserScope());
                gate.resolve();
                expect(await loading).toBeNull();
                expect(await loadCanvasDrawingPreview("p1", "d1", captureUserScope())).toBeNull();
            });
        } finally {
            restore();
        }
    });
});
