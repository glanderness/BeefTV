import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    APP_STATE_STORE_NAME,
    IMAGE_FILES_STORE_NAME,
    installLocalForageStoreFactoryForTests,
    localForageInstance,
    MEDIA_FILES_STORE_NAME,
    resetLocalForageDatabaseForTests,
} from "@/lib/localforage-storage";
import { getActiveUserScope, scopedStorageKey, setActiveUserScope } from "@/lib/user-scope";
import { prepareRestoredDeletedCanvas } from "@/components/canvas/recycle-bin-dialog";
import {
    beginCanvasHydration,
    finishCanvasHydration,
    setCanvasHydrationHealth,
} from "@/services/canvas-hydration-health";
import {
    resetCanvasOperationJournalMemory,
    updateCanvasOperationJournal,
} from "@/services/canvas-operation-journal";
import { withCanvasSaveGcBarrier } from "@/services/local-workspace-state";
import { CANVAS_DRAFTS_KEY } from "@/stores/canvas/canvas-store-persistence";
import { CANVAS_HISTORY_STORE_KEY, useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { flushCanvasStorePersistence, useCanvasStore, withCanvasStorePersistenceSuppressed, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";

function createMemoryForageFactory() {
    const stores = new Map<string, Map<string, unknown>>();
    return (storeName: string) => {
        let map = stores.get(storeName);
        if (!map) {
            map = new Map<string, unknown>();
            stores.set(storeName, map);
        }
        return {
            ready: async () => undefined,
            driver: () => "memory",
            getItem: async <T>(key: string) => (map!.has(key) ? (map!.get(key) as T) : null),
            setItem: async <T>(key: string, value: T) => {
                map!.set(key, value);
                return value;
            },
            removeItem: async (key: string) => {
                map!.delete(key);
            },
            keys: async () => [...map!.keys()],
            clear: async () => {
                map!.clear();
            },
            length: async () => map!.size,
            iterate: async <T, U>(iteratee: (value: T, key: string, index: number) => U) => {
                let index = 1;
                for (const [key, value] of [...map!.entries()]) {
                    iteratee(value as T, key, index);
                    index += 1;
                }
                return undefined as U;
            },
        } as unknown as LocalForage;
    };
}

function makeCanvas(id: string, overrides: Partial<CanvasProject> = {}): CanvasProject {
    return {
        id,
        title: id,
        revision: 2,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
        ...overrides,
    };
}

describe("lazy hydration GC reference completeness", () => {
    const scope = "gc-lazy-scope";
    let previousScope = "";
    const originalWindow = (globalThis as { window?: unknown }).window;

    beforeEach(() => {
        previousScope = getActiveUserScope();
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                setTimeout: globalThis.setTimeout.bind(globalThis),
                clearTimeout: globalThis.clearTimeout.bind(globalThis),
                location: { protocol: "http:", host: "127.0.0.1:8080", pathname: "/", hash: "" },
            },
        });
        installLocalForageStoreFactoryForTests(createMemoryForageFactory());
        resetCanvasOperationJournalMemory();
        setActiveUserScope(scope);
        withCanvasStorePersistenceSuppressed(() => {
            useCanvasStore.setState({ projects: [] });
        });
        useCanvasHistoryStore.setState({ deletedProjects: [] });
        useAssetStore.setState({ assets: [] });
        setCanvasHydrationHealth({ error: "", loading: false });
    });

    afterEach(() => {
        resetCanvasOperationJournalMemory();
        withCanvasStorePersistenceSuppressed(() => {
            useCanvasStore.setState({ projects: [] });
        });
        useCanvasHistoryStore.setState({ deletedProjects: [] });
        setCanvasHydrationHealth({ error: "", loading: true });
        setActiveUserScope(previousScope);
        installLocalForageStoreFactoryForTests(undefined);
        resetLocalForageDatabaseForTests();
        if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
        else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    });

    it("skips local media GC before hydration begins, while loading, or when backend hydration failed", async () => {
        const imageStore = localForageInstance(IMAGE_FILES_STORE_NAME);
        const mediaStore = localForageInstance(MEDIA_FILES_STORE_NAME);
        const imgKey = `image:${scope}:kept-on-error`;
        const audioKey = `audio:${scope}:kept-on-error`;
        await imageStore.setItem(imgKey, new Blob(["img"]));
        await mediaStore.setItem(audioKey, new Blob(["aud"]));

        // Initial boot state before beginCanvasHydration() has ever run must still block GC.
        setCanvasHydrationHealth({ error: "", loading: true });
        await useAssetStore.getState().cleanupImages();
        expect(await imageStore.getItem(imgKey)).not.toBeNull();
        expect(await mediaStore.getItem(audioKey)).not.toBeNull();

        const attempt = beginCanvasHydration();
        await useAssetStore.getState().cleanupImages();
        expect(await imageStore.getItem(imgKey)).not.toBeNull();
        expect(await mediaStore.getItem(audioKey)).not.toBeNull();

        finishCanvasHydration(attempt, "列表 500 失败");
        await useAssetStore.getState().cleanupImages();
        expect(await imageStore.getItem(imgKey)).not.toBeNull();
        expect(await mediaStore.getItem(audioKey)).not.toBeNull();
    });

    it("protects summaryMediaKeys, confirmedSnapshot, and in-flight journal media keys across cold reload while reclaiming orphaned blobs", async () => {
        const imageStore = localForageInstance(IMAGE_FILES_STORE_NAME);
        const mediaStore = localForageInstance(MEDIA_FILES_STORE_NAME);
        const summaryImg = `image:${scope}:referenced-by-summary`;
        const summaryAudio = `audio:${scope}:referenced-by-summary`;
        const journalInFlightImg = `image:${scope}:referenced-by-journal-inflight`;
        const journalConfirmedImg = `image:${scope}:referenced-by-journal-confirmed`;
        const orphanImg = `image:${scope}:orphan`;
        const orphanAudio = `audio:${scope}:orphan`;

        await imageStore.setItem(summaryImg, new Blob(["summary-img"]));
        await imageStore.setItem(journalInFlightImg, new Blob(["journal-inflight-img"]));
        await imageStore.setItem(journalConfirmedImg, new Blob(["journal-confirmed-img"]));
        await imageStore.setItem(orphanImg, new Blob(["orphan-img"]));
        await mediaStore.setItem(summaryAudio, new Blob(["summary-aud"]));
        await mediaStore.setItem(orphanAudio, new Blob(["orphan-aud"]));

        withCanvasStorePersistenceSuppressed(() => {
            useCanvasStore.setState({
                projects: [
                    makeCanvas("canvas-summary", {
                        summaryOnly: true,
                        summaryNodeCount: 5,
                        summaryMediaKeys: [summaryImg, summaryAudio],
                    }),
                ],
            });
        });

        await updateCanvasOperationJournal("canvas-journal", scope, (current) => ({
            ...current,
            confirmedRevision: 1,
            confirmedSnapshot: makeCanvas("canvas-journal", {
                revision: 1,
                nodes: [
                    {
                        id: "n-confirmed",
                        type: "image",
                        title: "confirmed",
                        position: { x: 0, y: 0 },
                        width: 100,
                        height: 100,
                        metadata: { storageKey: journalConfirmedImg },
                    } as never,
                ],
            }),
            inFlight: {
                operationId: "op-gc-1",
                expectedRevision: 1,
                payload: {
                    canvasId: "canvas-journal",
                    expectedRevision: 1,
                    document: makeCanvas("canvas-journal", {
                        nodes: [
                            {
                                id: "n-journal",
                                type: "image",
                                title: "journal",
                                position: { x: 0, y: 0 },
                                width: 100,
                                height: 100,
                                metadata: { storageKey: journalInFlightImg },
                            } as never,
                        ],
                    }),
                },
            },
        }));

        // Clear in-memory journal cache to simulate a fresh page reload before GC runs.
        resetCanvasOperationJournalMemory();

        const attempt = beginCanvasHydration();
        finishCanvasHydration(attempt, "");
        await useAssetStore.getState().cleanupImages();

        expect(await imageStore.getItem(summaryImg)).not.toBeNull();
        expect(await mediaStore.getItem(summaryAudio)).not.toBeNull();
        expect(await imageStore.getItem(journalInFlightImg)).not.toBeNull();
        expect(await imageStore.getItem(journalConfirmedImg)).not.toBeNull();
        expect(await imageStore.getItem(orphanImg)).toBeNull();
        expect(await mediaStore.getItem(orphanAudio)).toBeNull();
    });

    it("persists a restored deleted canvas into desktop CANVAS_DRAFTS_KEY so it survives reload", async () => {
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                setTimeout: globalThis.setTimeout.bind(globalThis),
                clearTimeout: globalThis.clearTimeout.bind(globalThis),
                location: { protocol: "wails:", host: "wails", pathname: "/index.html", hash: "" },
            },
        });
        const deletedFull = makeCanvas("restored-from-bin", {
            revision: 3,
            remoteContentHash: "stale-hash",
            nodes: [{ id: "n1", type: "text", title: "恢复节点", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "保留正文" } } as never],
        });
        const restored = prepareRestoredDeletedCanvas(deletedFull);
        expect(restored.revision).toBe(0);
        expect(restored.remoteContentHash).toBeUndefined();

        useCanvasStore.getState().restoreProject(restored);
        await flushCanvasStorePersistence();

        const appState = localForageInstance(APP_STATE_STORE_NAME);
        const persistedRaw = await appState.getItem<string>(scopedStorageKey(CANVAS_DRAFTS_KEY, scope));
        expect(persistedRaw).not.toBeNull();
        const persisted = JSON.parse(persistedRaw!) as { state: { projects: CanvasProject[] } };
        expect(persisted.state.projects.map((p) => p.id)).toContain("restored-from-bin");
        expect(persisted.state.projects.find((p) => p.id === "restored-from-bin")?.nodes).toHaveLength(1);
    });

    it("protects local media referenced by Recycle Bin deleted snapshots during cleanupImages so restore keeps media readable", async () => {
        const imageStore = localForageInstance(IMAGE_FILES_STORE_NAME);
        const mediaStore = localForageInstance(MEDIA_FILES_STORE_NAME);
        const appState = localForageInstance(APP_STATE_STORE_NAME);
        const binImg = `image:${scope}:bin-only-img`;
        const binAudio = `audio:${scope}:bin-only-audio`;
        const orphanImg = `image:${scope}:bin-orphan`;
        await imageStore.setItem(binImg, new Blob(["bin-img"]));
        await mediaStore.setItem(binAudio, new Blob(["bin-audio"]));
        await imageStore.setItem(orphanImg, new Blob(["orphan"]));

        const deletedCanvas = makeCanvas("deleted-with-media", {
            nodes: [
                {
                    id: "n-img",
                    type: "image",
                    title: "回收站图",
                    position: { x: 0, y: 0 },
                    width: 100,
                    height: 100,
                    metadata: { storageKey: binImg },
                } as never,
                {
                    id: "n-aud",
                    type: "audio",
                    title: "回收站音频",
                    position: { x: 10, y: 0 },
                    width: 100,
                    height: 100,
                    metadata: { storageKey: binAudio },
                } as never,
            ],
        });

        // Simulate deleted canvas moved to Recycle Bin (removed from live projects, persisted in CANVAS_HISTORY_STORE_KEY).
        useCanvasHistoryStore.getState().recordDeletedProjects([deletedCanvas]);
        await appState.setItem(
            scopedStorageKey(CANVAS_HISTORY_STORE_KEY, scope),
            JSON.stringify({ state: { deletedProjects: useCanvasHistoryStore.getState().deletedProjects }, version: 0 }),
        );

        const attempt = beginCanvasHydration();
        finishCanvasHydration(attempt, "");
        await useAssetStore.getState().cleanupImages();

        // Both live and persisted Recycle Bin media survive GC while genuine orphans are reclaimed.
        expect(await imageStore.getItem(binImg)).not.toBeNull();
        expect(await mediaStore.getItem(binAudio)).not.toBeNull();
        expect(await imageStore.getItem(orphanImg)).toBeNull();

        // Simulate cold reload where in-memory history store is empty but IndexedDB still holds CANVAS_HISTORY_STORE_KEY.
        const persistedHistorySnapshot = JSON.stringify({
            state: { deletedProjects: useCanvasHistoryStore.getState().deletedProjects },
            version: 0,
        });
        useCanvasHistoryStore.setState({ deletedProjects: [] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await appState.setItem(scopedStorageKey(CANVAS_HISTORY_STORE_KEY, scope), persistedHistorySnapshot);
        await useAssetStore.getState().cleanupImages();
        expect(await imageStore.getItem(binImg)).not.toBeNull();
        expect(await mediaStore.getItem(binAudio)).not.toBeNull();

        // Once permanently removed from Recycle Bin (both memory & storage), GC reclaims them.
        await appState.removeItem(scopedStorageKey(CANVAS_HISTORY_STORE_KEY, scope));
        await useAssetStore.getState().cleanupImages();
        expect(await imageStore.getItem(binImg)).toBeNull();
        expect(await mediaStore.getItem(binAudio)).toBeNull();
    });

    it("holds new canvas saves behind the GC barrier and resumes them after GC finishes while protecting edited media", async () => {
        const { waitForCanvasSaveGcBarrier } = await import("@/services/local-workspace-state");
        const order: string[] = [];
        let releaseBarrierInner!: () => void;
        const barrierHolding = new Promise<void>((resolve) => {
            releaseBarrierInner = resolve;
        });

        const gcRun = withCanvasSaveGcBarrier(scope, async () => {
            order.push("gc:start");
            await barrierHolding;
            order.push("gc:end");
        });

        // Wait one tick so the barrier is active, then simulate a firing 500ms save timer hitting the barrier.
        await Promise.resolve();
        const timerSave = (async () => {
            order.push("save:queued");
            await waitForCanvasSaveGcBarrier(scope);
            order.push("save:started");
        })();

        await Promise.resolve();
        await Promise.resolve();
        expect(order).toEqual(["gc:start", "save:queued"]);

        releaseBarrierInner();
        await Promise.all([gcRun, timerSave]);
        expect(order).toEqual(["gc:start", "save:queued", "gc:end", "save:started"]);
    });
});
