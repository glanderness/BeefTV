import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    APP_STATE_STORE_NAME,
    IMAGE_FILES_STORE_NAME,
    installLocalForageStoreFactoryForTests,
    localForageInstance,
    MEDIA_FILES_STORE_NAME,
    resetLocalForageDatabaseForTests,
} from "@/lib/localforage-storage";
import { getActiveUserScope, scopedStorageKey, setActiveUserScope } from "@/lib/user-scope";
import {
    beginCanvasHydration,
    finishCanvasHydration,
    setCanvasHydrationHealth,
} from "@/services/canvas-hydration-health";
import {
    resetCanvasOperationJournalMemory,
    updateCanvasOperationJournal,
} from "@/services/canvas-operation-journal";
import { collectMediaStorageKeys, setMediaBlob } from "@/services/file-storage";
import { collectImageStorageKeys, getImageBlob, setImageBlob } from "@/services/image-storage";
import { prepareRestoredDeletedCanvas } from "@/services/workspace-project-repository";
import { CANVAS_DRAFTS_KEY, CANVAS_HISTORY_STORE_KEY } from "@/stores/canvas/canvas-store-persistence";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { flushCanvasStorePersistence, useCanvasStore, withCanvasStorePersistenceSuppressed, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { ASSET_STORE_DRAFTS_KEY, unloadAssetStoreDraftsForTests, useAssetStore } from "@/stores/use-asset-store";

function createMemoryForageFactory(hooks?: {
    onIterate?: (storeName: string) => void | Promise<void>;
    beforeRemove?: (storeName: string, key: string) => void | Promise<void>;
    onRemove?: (storeName: string, key: string) => void | Promise<void>;
}) {
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
                await hooks?.beforeRemove?.(storeName, key);
                map!.delete(key);
                await hooks?.onRemove?.(storeName, key);
            },
            keys: async () => [...map!.keys()],
            clear: async () => {
                map!.clear();
            },
            length: async () => map!.size,
            iterate: async <T, U>(iteratee: (value: T, key: string, index: number) => U) => {
                await hooks?.onIterate?.(storeName);
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

    it("aborts a stale GC sweep without blocking writers when open/adopt/restore, delete-history, or journal commit mutates mid-sweep", async () => {
        const scenarios: Array<{ name: string; mutate: (key: string) => void | Promise<void> }> = [
            {
                name: "concurrent canvas store write (open/adopt/restore)",
                mutate: (key) => {
                    withCanvasStorePersistenceSuppressed(() => {
                        useCanvasStore.setState({
                            projects: [
                                makeCanvas("concurrent-open", {
                                    nodes: [{ id: "n1", type: "image", title: "新打开", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: key } } as never],
                                }),
                            ],
                        });
                    });
                },
            },
            {
                name: "concurrent recycle-bin history write (delete)",
                mutate: (key) => {
                    useCanvasHistoryStore.getState().recordDeletedProjects([
                        makeCanvas("concurrent-del", {
                            nodes: [{ id: "n2", type: "image", title: "新删入回收站", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: key } } as never],
                        }),
                    ]);
                },
            },
            {
                name: "concurrent operation journal write (save timer)",
                mutate: async (key) => {
                    await updateCanvasOperationJournal("concurrent-save", scope, (current) => ({
                        ...current,
                        confirmedRevision: 1,
                        inFlight: {
                            operationId: "op-concurrent-save",
                            expectedRevision: 1,
                            payload: {
                                canvasId: "concurrent-save",
                                expectedRevision: 1,
                                document: makeCanvas("concurrent-save", {
                                    nodes: [{ id: "n3", type: "image", title: "定时保存", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: key } } as never],
                                }),
                            },
                        },
                    }));
                },
            },
        ];

        for (const [index, scenario] of scenarios.entries()) {
            const imgKey = `image:${scope}:mid-sweep-${index}`;
            let mutatedOnce = false;
            installLocalForageStoreFactoryForTests(
                createMemoryForageFactory({
                    onIterate: async (storeName) => {
                        if (storeName === IMAGE_FILES_STORE_NAME && !mutatedOnce) {
                            mutatedOnce = true;
                            await scenario.mutate(imgKey);
                        }
                    },
                }),
            );
            withCanvasStorePersistenceSuppressed(() => {
                useCanvasStore.setState({ projects: [] });
            });
            useCanvasHistoryStore.setState({ deletedProjects: [] });
            resetCanvasOperationJournalMemory();

            const imageStore = localForageInstance(IMAGE_FILES_STORE_NAME);
            await imageStore.setItem(imgKey, new Blob([scenario.name]));

            const attempt = beginCanvasHydration();
            finishCanvasHydration(attempt, "");
            await useAssetStore.getState().cleanupImages();

            // Sweep must detect the concurrent mutation and abort before deleting imgKey.
            expect(mutatedOnce).toBe(true);
            expect(await imageStore.getItem(imgKey)).not.toBeNull();
        }
    });

    it("aborts remaining per-key deletions inside the delete loop on single-tab asset/image/media writes and never clobbers a same-key rewrite", async () => {
        // 1. Same-key rewrite during sweep must abort and keep the rewritten bytes intact (no stale rollback).
        const rewrittenKey = `image:${scope}:same-key-rewrite`;
        let rewroteOnce = false;
        installLocalForageStoreFactoryForTests(
            createMemoryForageFactory({
                onIterate: async (storeName) => {
                    if (storeName === IMAGE_FILES_STORE_NAME && !rewroteOnce) {
                        rewroteOnce = true;
                        await setImageBlob(rewrittenKey, new Blob(["fresh-rewritten-bytes"]));
                    }
                },
            }),
        );
        const rewriteStore = localForageInstance(IMAGE_FILES_STORE_NAME);
        await rewriteStore.setItem(rewrittenKey, new Blob(["old-bytes"]));
        let attempt = beginCanvasHydration();
        finishCanvasHydration(attempt, "");
        await useAssetStore.getState().cleanupImages();
        expect(rewroteOnce).toBe(true);
        const survivingBlob = await getImageBlob(rewrittenKey);
        expect(survivingBlob).not.toBeNull();
        expect(await survivingBlob!.text()).toBe("fresh-rewritten-bytes");

        // 2. Per-key pre-delete check aborts remaining keys after an intervening single-tab mutation.
        const deleteLoopScenarios: Array<{ name: string; mutateAfterFirstDelete: (secondKey: string) => void | Promise<void> }> = [
            {
                name: "useAssetStore.addAsset mid-delete",
                mutateAfterFirstDelete: (secondKey) => {
                    useAssetStore.getState().addAsset({
                        kind: "image",
                        title: "并发新增素材",
                        coverUrl: "",
                        tags: [],
                        category: "other",
                        status: "confirmed",
                        source: "手动添加",
                        data: { dataUrl: "", storageKey: secondKey, width: 100, height: 100, bytes: 4, mimeType: "image/png" },
                    });
                },
            },
            {
                name: "direct setImageBlob write mid-delete",
                mutateAfterFirstDelete: async () => {
                    await setImageBlob(`image:${scope}:direct-upload`, new Blob(["upload"]));
                },
            },
            {
                name: "direct setMediaBlob write mid-delete",
                mutateAfterFirstDelete: async () => {
                    await setMediaBlob(`audio:${scope}:direct-audio`, new Blob(["audio"]));
                },
            },
        ];

        for (const [index, scenario] of deleteLoopScenarios.entries()) {
            const firstKey = `image:${scope}:delete-loop-${index}-a`;
            const secondKey = `image:${scope}:delete-loop-${index}-b`;
            let triggered = false;
            installLocalForageStoreFactoryForTests(
                createMemoryForageFactory({
                    onRemove: async (storeName, key) => {
                        if (storeName === IMAGE_FILES_STORE_NAME && key === firstKey && !triggered) {
                            triggered = true;
                            await scenario.mutateAfterFirstDelete(secondKey);
                        }
                    },
                }),
            );
            withCanvasStorePersistenceSuppressed(() => {
                useCanvasStore.setState({ projects: [] });
            });
            useCanvasHistoryStore.setState({ deletedProjects: [] });
            useAssetStore.setState({ assets: [] });
            resetCanvasOperationJournalMemory();

            const imageStore = localForageInstance(IMAGE_FILES_STORE_NAME);
            await imageStore.setItem(firstKey, new Blob(["first"]));
            await imageStore.setItem(secondKey, new Blob([scenario.name]));

            attempt = beginCanvasHydration();
            finishCanvasHydration(attempt, "");
            await useAssetStore.getState().cleanupImages();

            expect(triggered).toBe(true);
            expect(await imageStore.getItem(firstKey)).toBeNull();
            expect(await imageStore.getItem(secondKey)).not.toBeNull();
        }
    });

    it("fails closed and deletes zero blobs when persisted Recycle Bin history or an operation journal is corrupt", async () => {
        const appState = localForageInstance(APP_STATE_STORE_NAME);
        const imageStore = localForageInstance(IMAGE_FILES_STORE_NAME);
        const keptImg = `image:${scope}:kept-on-corrupt-refs`;
        await imageStore.setItem(keptImg, new Blob(["kept"]));

        const attempt = beginCanvasHydration();
        finishCanvasHydration(attempt, "");

        // 1. Corrupt Recycle Bin JSON -> cleanupImages rejects and deletes zero blobs.
        await appState.setItem(scopedStorageKey(CANVAS_HISTORY_STORE_KEY, scope), "{corrupt-history-json");
        await expect(useAssetStore.getState().cleanupImages()).rejects.toThrow();
        expect(await imageStore.getItem(keptImg)).not.toBeNull();
        await appState.removeItem(scopedStorageKey(CANVAS_HISTORY_STORE_KEY, scope));

        // 2. Corrupt operation journal in app_state -> cleanupImages rejects and deletes zero blobs.
        await appState.setItem(scopedStorageKey("canvas-document-journal:corrupt-canvas", scope), "{corrupt-journal");
        resetCanvasOperationJournalMemory();
        await expect(useAssetStore.getState().cleanupImages()).rejects.toThrow();
        expect(await imageStore.getItem(keptImg)).not.toBeNull();
        await appState.removeItem(scopedStorageKey("canvas-document-journal:corrupt-canvas", scope));
    });

    it("completes GC without self-aborting when cold hydrateAssetStoreDrafts projects persisted asset drafts during sweep", async () => {
        const appState = localForageInstance(APP_STATE_STORE_NAME);
        const imageStore = localForageInstance(IMAGE_FILES_STORE_NAME);
        const draftImg = `image:${scope}:cold-asset-draft-img`;
        const orphanImg = `image:${scope}:cold-asset-orphan-img`;
        await imageStore.setItem(draftImg, new Blob(["draft-img"]));
        await imageStore.setItem(orphanImg, new Blob(["orphan-img"]));

        // Seed persisted ASSET_STORE_DRAFTS_KEY and unload in-memory draft state so cleanupImages'
        // own hydrateAssetStoreDrafts(scope) must project the draft into useAssetStore.
        unloadAssetStoreDraftsForTests(scope);
        useAssetStore.setState({ assets: [] });
        await appState.setItem(
            scopedStorageKey(ASSET_STORE_DRAFTS_KEY, scope),
            JSON.stringify({
                drafts: {
                    "cold-draft-1": {
                        kind: "upsert",
                        version: 1,
                        asset: {
                            id: "cold-draft-1",
                            kind: "image",
                            title: "未提交冷启动素材草稿",
                            coverUrl: "",
                            tags: [],
                            category: "other",
                            status: "confirmed",
                            source: "手动添加",
                            createdAt: "2026-04-01T00:00:00.000Z",
                            updatedAt: "2026-04-01T00:00:00.000Z",
                            data: { dataUrl: "", storageKey: draftImg, width: 100, height: 100, bytes: 9, mimeType: "image/png" },
                        },
                    },
                },
                clocks: { "cold-draft-1": 1 },
            }),
        );

        const attempt = beginCanvasHydration();
        finishCanvasHydration(attempt, "");
        await useAssetStore.getState().cleanupImages();

        // Draft-referenced blob is protected AND orphan blob is genuinely reclaimed (no self-abort!).
        expect(await imageStore.getItem(draftImg)).not.toBeNull();
        expect(await imageStore.getItem(orphanImg)).toBeNull();
        unloadAssetStoreDraftsForTests(scope);
    });

    it("serializes a same-key rewrite started during removeItem via per-key lock, returns false on skipped sweeps, and decouples removeAsset from corrupt-GC rejection", async () => {
        // 1. Same-key rewrite launched inside beforeRemove (while removeItem is mid-flight) queues behind
        // withMediaKeyLock and writes fresh bytes after removal so the rewrite is NEVER lost.
        const racingKey = `image:${scope}:before-remove-race`;
        let concurrentRewrite: Promise<unknown> | null = null;
        installLocalForageStoreFactoryForTests(
            createMemoryForageFactory({
                beforeRemove: (storeName, key) => {
                    if (storeName === IMAGE_FILES_STORE_NAME && key === racingKey && !concurrentRewrite) {
                        concurrentRewrite = setImageBlob(racingKey, new Blob(["fresh-during-remove"]));
                    }
                },
            }),
        );
        const imageStore = localForageInstance(IMAGE_FILES_STORE_NAME);
        await imageStore.setItem(racingKey, new Blob(["old-bytes"]));

        const loadingAttempt = beginCanvasHydration();
        expect(await useAssetStore.getState().cleanupImages()).toBe(false);
        finishCanvasHydration(loadingAttempt, "");

        // Interrupted by concurrent same-key rewrite -> returns false AND preserves fresh rewritten bytes!
        expect(await useAssetStore.getState().cleanupImages()).toBe(false);
        expect(concurrentRewrite).not.toBeNull();
        await concurrentRewrite;
        const surviving = await getImageBlob(racingKey);
        expect(surviving).not.toBeNull();
        expect(await surviving!.text()).toBe("fresh-during-remove");

        // Quiet sweep with no concurrent mutations completes and returns true.
        expect(await useAssetStore.getState().cleanupImages()).toBe(true);

        // 2. removeAsset succeeds cleanly even when corrupt history causes fail-closed GC to reject.
        const appState = localForageInstance(APP_STATE_STORE_NAME);
        const localAssetKey = `image:${scope}:asset-remove-corrupt-gc`;
        await imageStore.setItem(localAssetKey, new Blob(["asset-img"]));
        await appState.setItem(scopedStorageKey(CANVAS_HISTORY_STORE_KEY, scope), "{corrupt-json");
        const assetId = useAssetStore.getState().addAsset({
            kind: "image",
            title: "待删本地素材",
            coverUrl: "",
            tags: [],
            category: "other",
            status: "confirmed",
            source: "手动添加",
            data: { dataUrl: "", storageKey: localAssetKey, width: 100, height: 100, bytes: 9, mimeType: "image/png" },
        });
        await expect(useAssetStore.getState().removeAsset(assetId)).resolves.toBeUndefined();
        expect(useAssetStore.getState().assets.some((item) => item.id === assetId)).toBe(false);
        expect(await imageStore.getItem(localAssetKey)).not.toBeNull();
        await appState.removeItem(scopedStorageKey(CANVAS_HISTORY_STORE_KEY, scope));
    });

    it("matches the shared Go/TS cross-language localMediaKeys fixture contract", () => {
        const fixturePath = resolve(import.meta.dir, "../../backend/internal/canvas/testdata/local_media_keys_contract.json");
        const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as Array<{
            name: string;
            payload: unknown;
            expectedLocalMediaKeys: string[];
            expectedImageKeys: string[];
        }>;
        expect(cases.length).toBeGreaterThanOrEqual(2);
        for (const tc of cases) {
            const tsMediaKeys = [...collectMediaStorageKeys(tc.payload)]
                .filter((key) => !key.startsWith("resource:"))
                .sort();
            const tsImageKeys = [...collectImageStorageKeys(tc.payload)]
                .filter((key) => !key.startsWith("resource:"))
                .sort();
            expect(tsMediaKeys).toEqual(tc.expectedLocalMediaKeys);
            expect(tsImageKeys).toEqual(tc.expectedImageKeys);
        }
    });
});
