import { afterEach, describe, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

import { serializeAssetStorageDocument } from "@/lib/asset-storage-revision";
import { IMAGE_FILES_STORE_NAME, localForageInstance } from "@/lib/localforage-storage";
import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, scopedStorageKey, setActiveUserScope } from "@/lib/user-scope";
import { applyUserSession } from "@/lib/user-session";
import { apiClient } from "@/services/api/request";
import { deleteStoredMedia, getMediaBlob, setMediaBlob } from "@/services/file-storage";
import {
    loadWorkspaceAssetLibraryPage,
    preserveLegacyCacheOnlyAssetDrafts,
    resetWorkspaceAssetReadStateForTests,
} from "@/services/workspace-asset-read";
import { usesSingleSourceLocalPersistence } from "@/services/workspace-resource-storage";
import {
    ASSET_STORE_DRAFTS_KEY,
    ASSET_STORE_KEY,
    ackAssetStoreDraft,
    flushAssetStorePersistence,
    hydrateAssetStoreDrafts,
    peekAssetStoreDraft,
    recordAssetStoreDraft,
    resetAssetStoreDraftsForTests,
    unloadAssetStoreDraftsForTests,
    useAssetStore,
    type Asset,
} from "@/stores/use-asset-store";

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function textAsset(id: string, title = "素材"): Asset {
    return {
        id,
        kind: "text",
        title,
        coverUrl: "",
        tags: [],
        category: "other",
        status: "confirmed",
        source: "手动添加",
        data: { content: "hello" },
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
    };
}

function envelope(data: unknown, status = 200) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers: {}, config: {} as never };
}

function isCatalogKey(key: unknown) {
    const value = String(key);
    return value.includes("asset_store") && !value.includes("asset_store_drafts");
}

function isDraftsKey(key: unknown) {
    return String(key).includes("asset_store_drafts");
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
const originalWindow = globalThis.window;

function enterDesktopSingleSourceMode() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
    const ls = new Map<string, string>();
    Object.assign(globalThis, {
        window: {
            location: { protocol: "wails:", hostname: "wails.localhost", host: "wails.localhost" },
            localStorage: {
                getItem: (k: string) => ls.get(k) ?? null,
                setItem: (k: string, v: string) => { ls.set(k, v); },
                removeItem: (k: string) => { ls.delete(k); },
            },
            setTimeout: globalThis.setTimeout.bind(globalThis),
            clearTimeout: globalThis.clearTimeout.bind(globalThis),
        },
    });
}

afterEach(async () => {
    while (spies.length) spies.pop()?.mockRestore();
    Object.assign(globalThis, { window: originalWindow });
    useAssetStore.setState({ assets: [] });
    resetWorkspaceAssetReadStateForTests();
    await resetAssetStoreDraftsForTests();
});

describe("asset store single-source persistence", () => {
    test("usesSingleSourceLocalPersistence matches desktop Wails, embedded Harness, and browser-local matrix", () => {
        const nativeSpy = spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true);
        const localSpy = spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true);
        spies.push(nativeSpy, localSpy);

        // Desktop Wails shell -> true
        Object.assign(globalThis, {
            window: { location: { protocol: "wails:", hostname: "wails.localhost", host: "wails.localhost" } },
        });
        expect(usesSingleSourceLocalPersistence()).toBe(true);

        // Embedded Harness (non-wails origin + __BEEFTV_HARNESS__) -> true
        nativeSpy.mockReturnValue(false);
        Object.assign(globalThis, {
            window: {
                location: { protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1:4173" },
                __BEEFTV_HARNESS__: { embedded: true, apiBase: "/beeftv/app/api" },
            },
        });
        expect(usesSingleSourceLocalPersistence()).toBe(true);

        // Browser-local (no native desktop, no embedded harness) -> false
        Object.assign(globalThis, {
            window: { location: { protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1:4173" } },
        });
        expect(usesSingleSourceLocalPersistence()).toBe(false);
    });

    test("skips full ASSET_STORE_KEY writes during SQLite page reads and mutations, and survives applyUserSession restart without unloading draft hydration marker", async () => {
        const scope = "desktop-single-source-1";
        const restore = switchScope(scope);
        enterDesktopSingleSourceMode();
        const memory = new Map<string, string>();
        const catalogWrites: string[] = [];
        const draftWrites: string[] = [];
        spies.push(spyOn(localforage, "getItem").mockImplementation(async (key) => memory.get(String(key)) ?? null));
        spies.push(spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            const strKey = String(key);
            if (isCatalogKey(strKey)) catalogWrites.push(strKey);
            if (isDraftsKey(strKey)) draftWrites.push(strKey);
            memory.set(strKey, String(value));
            return value;
        }));
        spies.push(spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        }));

        try {
            await withAdapter(async (config) => {
                const url = String(config.url || "");
                if (url.startsWith("/assets") && config.params?.page != null) {
                    return envelope({
                        assets: [textAsset("srv-1", "后端素材")],
                        kindCounts: { text: 1 },
                        categoryCounts: { other: 1 },
                        folderCounts: {},
                        favoriteTotal: 0,
                        recentTotal: 1,
                        projectCounts: {},
                        generatedTotal: 0,
                        generatedKindCounts: {},
                        page: 1,
                        pageSize: 40,
                        total: 1,
                        hasMore: false,
                    });
                }
                return envelope({ assets: [{ id: "srv-1", title: "后端素材", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }] });
            }, async () => {
                const page = await loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 });
                expect(page.assets.map((item) => item.id)).toEqual(["srv-1"]);
            });
            expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["srv-1"]);

            const id = useAssetStore.getState().addAsset({
                kind: "text",
                title: "新建草稿",
                coverUrl: "",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                data: { content: "draft" },
            });
            useAssetStore.getState().updateAsset(id, { title: "更新后草稿" });
            await flushAssetStorePersistence();

            expect(catalogWrites).toEqual([]);
            expect(draftWrites.length).toBeGreaterThan(0);
            expect(peekAssetStoreDraft(scope, id)?.asset?.title).toBe("更新后草稿");

            // Production restart ordering: scope is ALREADY marked hydrated in hydratedAssetDraftScopes,
            // ASSET_STORE_KEY is absent, and applyUserSession resets stale assets before rehydrating.
            // Without calling unloadAssetStoreDraftsForTests(), the draft must still project back into state.assets!
            await withAdapter(async () => envelope({
                assets: [{ id: "srv-1", title: "后端素材", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }],
            }), async () => {
                await applyUserSession({
                    contractVersion: "local-v1",
                    workspace: { id: scope, name: "本地工作区" },
                    user: { id: scope, username: "local", role: "owner", email: "", createdAt: "2026-10-02T00:00:00.000Z" },
                    runtimeLimits: { maxUploadMB: 256, maxStructuredDataMB: 256 },
                    features: {},
                    capabilities: { workspaceMode: "local" },
                } as never);
            });

            expect(catalogWrites).toEqual([]);
            expect(useAssetStore.getState().assets.find((item) => item.id === id)?.title).toBe("更新后草稿");
        } finally {
            restore();
        }
    });

    test("single-source cleanupImages skips full-store sweeps while removeAsset reclaims only the deleted asset's fallback blobs", async () => {
        const scope = "desktop-cleanup-safe";
        const restore = switchScope(scope);
        enterDesktopSingleSourceMode();
        const imageStore = localForageInstance(IMAGE_FILES_STORE_NAME);
        const removedImageKey = `image:${scope}:removed-fallback-1`;
        const retainedImageKey = `image:${scope}:other-draft-fallback-2`;
        const removedVideoKey = `video:${scope}:removed-fallback-vid`;
        const retainedVideoKey = `video:${scope}:other-draft-vid`;
        await imageStore.setItem(removedImageKey, new Blob(["img-a"], { type: "image/png" }));
        await imageStore.setItem(retainedImageKey, new Blob(["img-b"], { type: "image/png" }));
        await setMediaBlob(removedVideoKey, new Blob(["vid-a"], { type: "video/mp4" }));
        await setMediaBlob(retainedVideoKey, new Blob(["vid-b"], { type: "video/mp4" }));

        try {
            const removedImgId = useAssetStore.getState().addAsset({
                kind: "image",
                title: "待删图片草稿",
                coverUrl: "blob:http://localhost/removed",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                pendingRemoteUpload: true,
                data: { dataUrl: "blob:http://localhost/removed", storageKey: removedImageKey, width: 100, height: 100, bytes: 5, mimeType: "image/png" },
            });
            const removedVidId = useAssetStore.getState().addAsset({
                kind: "video",
                title: "待删视频草稿",
                coverUrl: "",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                pendingRemoteUpload: true,
                data: { url: "blob:http://localhost/vid", storageKey: removedVideoKey, width: 1280, height: 720, bytes: 5, mimeType: "video/mp4" },
            });

            await useAssetStore.getState().removeAsset(removedImgId);
            await useAssetStore.getState().removeAsset(removedVidId);
            expect(await imageStore.getItem(removedImageKey)).toBeNull();
            expect(await getMediaBlob(removedVideoKey)).toBeNull();
            // Other unloaded/surviving draft blobs must NOT be touched.
            expect(await imageStore.getItem(retainedImageKey)).not.toBeNull();
            expect(await getMediaBlob(retainedVideoKey)).not.toBeNull();

            // Direct cleanupImages call still skips full-store IndexedDB sweep.
            useAssetStore.setState({ assets: [] });
            await useAssetStore.getState().cleanupImages();
            expect(await imageStore.getItem(retainedImageKey)).not.toBeNull();
            expect(await getMediaBlob(retainedVideoKey)).not.toBeNull();
        } finally {
            await imageStore.removeItem(removedImageKey);
            await imageStore.removeItem(retainedImageKey);
            await deleteStoredMedia([removedVideoKey, retainedVideoKey]);
            restore();
        }
    });

    test("legacy ASSET_STORE_KEY entries covered by deletedGenerationIds tombstone stay filtered and allow legacy cache cleanup", async () => {
        const scope = "desktop-legacy-tombstone";
        const restore = switchScope(scope);
        enterDesktopSingleSourceMode();
        const memory = new Map<string, string>();
        const legacyKey = scopedStorageKey(ASSET_STORE_KEY, scope);
        const draftsKey = scopedStorageKey(ASSET_STORE_DRAFTS_KEY, scope);

        memory.set(legacyKey, serializeAssetStorageDocument({
            state: {
                assets: [
                    textAsset("generation_deleted_1", "已删旧生成素材"),
                    textAsset("in-sqlite", "已在库里"),
                ],
            },
            version: 0,
            storageRevision: 4,
            tombstones: { assets: {} },
        }));
        memory.set(draftsKey, JSON.stringify({
            drafts: {},
            clocks: { generation_deleted_1: 2 },
            deletedGenerationIds: ["generation_deleted_1"],
        }));

        spies.push(spyOn(localforage, "getItem").mockImplementation(async (key) => memory.get(String(key)) ?? null));
        spies.push(spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            memory.set(String(key), String(value));
            return value;
        }));
        spies.push(spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        }));

        try {
            await useAssetStore.persist.rehydrate();
            await hydrateAssetStoreDrafts(scope, { reproject: true });
            expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["in-sqlite"]);

            const result = await withAdapter(async () => envelope({
                assets: [{ id: "in-sqlite", title: "已在库里", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }],
            }), async () => preserveLegacyCacheOnlyAssetDrafts());

            expect(result.preservedIds).toEqual([]);
            expect(peekAssetStoreDraft(scope, "generation_deleted_1")).toBeUndefined();
            expect(memory.has(legacyKey)).toBe(false);
        } finally {
            restore();
        }
    });

    test("batch-promotes legacy cache-only assets in one write, preserves legacy cache on failure or invalid records, and cleans up once covered", async () => {
        const scope = "desktop-legacy-cleanup";
        const restore = switchScope(scope);
        enterDesktopSingleSourceMode();
        const memory = new Map<string, string>();
        const legacyKey = scopedStorageKey(ASSET_STORE_KEY, scope);

        // Case A: legacy cache contains an invalid/quarantined record -> MUST NOT delete ASSET_STORE_KEY.
        memory.set(legacyKey, JSON.stringify({
            state: { assets: [textAsset("in-sqlite", "已在库里"), { id: "corrupt-1", kind: "image", title: "坏记录" }] },
            version: 0,
            storageRevision: 2,
            tombstones: { assets: {} },
        }));

        let failDraftWrite = false;
        let draftWriteCount = 0;
        spies.push(spyOn(localforage, "getItem").mockImplementation(async (key) => memory.get(String(key)) ?? null));
        spies.push(spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            if (isDraftsKey(key)) {
                draftWriteCount += 1;
                if (failDraftWrite) throw new Error("disk full");
            }
            memory.set(String(key), String(value));
            return value;
        }));
        spies.push(spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        }));

        try {
            await useAssetStore.persist.rehydrate();
            await withAdapter(async () => envelope({
                assets: [{ id: "in-sqlite", title: "已在库里", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }],
            }), async () => {
                await preserveLegacyCacheOnlyAssetDrafts();
            });
            expect(memory.has(legacyKey)).toBe(true);

            // Case B: clean legacy cache with 3 cache-only assets + 1 SQLite asset -> single batch draft write!
            resetWorkspaceAssetReadStateForTests();
            unloadAssetStoreDraftsForTests();
            memory.clear();
            draftWriteCount = 0;
            memory.set(legacyKey, serializeAssetStorageDocument({
                state: {
                    assets: [
                        textAsset("legacy-1", "旧缓存1"),
                        textAsset("legacy-2", "旧缓存2"),
                        textAsset("legacy-3", "旧缓存3"),
                        textAsset("in-sqlite", "已在库里"),
                    ],
                },
                version: 0,
                storageRevision: 3,
                tombstones: { assets: {} },
            }));

            failDraftWrite = true;
            await useAssetStore.persist.rehydrate();
            await withAdapter(async () => envelope({
                assets: [{ id: "in-sqlite", title: "已在库里", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }],
            }), async () => {
                await expect(preserveLegacyCacheOnlyAssetDrafts()).rejects.toThrow("disk full");
            });
            // Single batch write attempted (O(N), not 3 writes), and legacy key kept because draft flush failed!
            expect(draftWriteCount).toBe(1);
            expect(memory.has(legacyKey)).toBe(true);

            // Disk recovers -> retry flushes failed drafts and removes obsolete ASSET_STORE_KEY cleanly.
            failDraftWrite = false;
            await withAdapter(async () => envelope({
                assets: [{ id: "in-sqlite", title: "已在库里", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }],
            }), async () => {
                await preserveLegacyCacheOnlyAssetDrafts();
            });
            expect(draftWriteCount).toBe(2);
            expect(memory.has(legacyKey)).toBe(false);
            const storedDrafts = memory.get(scopedStorageKey(ASSET_STORE_DRAFTS_KEY, scope)) ?? "";
            expect(storedDrafts).toContain("legacy-1");
            expect(storedDrafts).toContain("legacy-2");
            expect(storedDrafts).toContain("legacy-3");
        } finally {
            restore();
        }
    });

    test("addGenerationAsset checks authoritative SQLite for unloaded assets and blocks resurrection even after delete draft is acked", async () => {
        const scope = "desktop-gen-asset";
        const restore = switchScope(scope);
        enterDesktopSingleSourceMode();
        const memory = new Map<string, string>();
        const catalogWrites: string[] = [];
        spies.push(spyOn(localforage, "getItem").mockImplementation(async (key) => memory.get(String(key)) ?? null));
        spies.push(spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            const strKey = String(key);
            if (isCatalogKey(strKey)) catalogWrites.push(strKey);
            memory.set(strKey, String(value));
            return value;
        }));
        spies.push(spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        }));

        try {
            // Case 1: generation asset exists in SQLite (with user-renamed title) but is not loaded in memory.
            const effectKeyExisting = "task-existing:output:0";
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(effectKeyExisting));
            const existingId = `generation_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
            const sqliteRow: Asset = {
                ...textAsset(existingId, "用户已重命名"),
                tags: ["重要"],
                metadata: { generationEffectKey: effectKeyExisting },
            };

            const returnedId = await withAdapter(async (config) => {
                const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
                expect(body?.ids).toEqual([existingId]);
                return envelope({ assets: [sqliteRow] });
            }, async () => useAssetStore.getState().addGenerationAsset(effectKeyExisting, {
                kind: "text",
                title: "默认标题不应覆盖",
                coverUrl: "",
                tags: ["生成"],
                status: "confirmed",
                source: "生成任务",
                data: { content: "new" },
            }));
            expect(returnedId).toBe(existingId);
            expect(useAssetStore.getState().assets.find((item) => item.id === existingId)?.title).toBe("用户已重命名");
            expect(peekAssetStoreDraft(scope, existingId)).toBeUndefined();
            expect(catalogWrites).toEqual([]);

            // Case 2: newly materialized generation asset -> deleted -> delete draft ACKED -> restart -> must NOT resurrect!
            const effectKeyDeleted = "task-deleted:output:0";
            const createdId = await withAdapter(async () => envelope({ assets: [] }), async () =>
                useAssetStore.getState().addGenerationAsset(effectKeyDeleted, {
                    kind: "text",
                    title: "稍后删除",
                    coverUrl: "",
                    tags: ["生成"],
                    status: "confirmed",
                    source: "生成任务",
                    data: { content: "temp" },
                }),
            );
            recordAssetStoreDraft(createdId, "delete");
            const deleteVersion = peekAssetStoreDraft(scope, createdId)!.version;
            ackAssetStoreDraft(createdId, deleteVersion);
            await flushAssetStorePersistence();
            expect(peekAssetStoreDraft(scope, createdId)).toBeUndefined();

            // Simulate full cold restart from IndexedDB draft store (no ASSET_STORE_KEY).
            unloadAssetStoreDraftsForTests();
            useAssetStore.setState({ assets: [] });
            await hydrateAssetStoreDrafts(scope);

            await withAdapter(async () => envelope({ assets: [] }), async () => {
                await expect(useAssetStore.getState().addGenerationAsset(effectKeyDeleted, {
                    kind: "text",
                    title: "尝试复活",
                    coverUrl: "",
                    tags: ["生成"],
                    status: "confirmed",
                    source: "生成任务",
                    data: { content: "zombie" },
                })).rejects.toThrow("生成素材已被用户删除");
            });
            expect(catalogWrites).toEqual([]);

            // Case 3: SQLite media row with stale blob: URLs + sibling corrupt row -> full resource URL normalization & row isolation.
            const effectKeyMedia = "task-media:output:0";
            const mediaDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(effectKeyMedia));
            const mediaId = `generation_${Array.from(new Uint8Array(mediaDigest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
            const returnedMediaId = await withAdapter(async () => envelope({
                assets: [
                    { id: "corrupt-sibling", kind: "image" },
                    {
                        id: mediaId,
                        kind: "image",
                        title: "远端图片素材",
                        coverUrl: "blob:http://stale/cover",
                        tags: ["生成"],
                        category: "other",
                        status: "confirmed",
                        source: "生成任务",
                        data: {
                            storageKey: "resource:res-img-1",
                            dataUrl: "blob:http://stale/img",
                            width: 1024,
                            height: 1024,
                            bytes: 4096,
                            mimeType: "image/png",
                        },
                        createdAt: "2026-10-02T00:00:00.000Z",
                        updatedAt: "2026-10-02T00:00:00.000Z",
                        metadata: { generationEffectKey: effectKeyMedia },
                    },
                ],
            }), async () => useAssetStore.getState().addGenerationAsset(effectKeyMedia, {
                kind: "image",
                title: "默认图片标题",
                coverUrl: "",
                tags: ["生成"],
                status: "confirmed",
                source: "生成任务",
                data: { dataUrl: "https://example.com/fallback.png", width: 1024, height: 1024, bytes: 4096, mimeType: "image/png" },
            }));
            expect(returnedMediaId).toBe(mediaId);
            const normalizedMedia = useAssetStore.getState().assets.find((item) => item.id === mediaId);
            expect(normalizedMedia?.kind).toBe("image");
            expect(normalizedMedia?.coverUrl).toBe("/api/resources/res-img-1/file");
            if (normalizedMedia?.kind === "image") {
                expect(normalizedMedia.data.dataUrl).toBe("/api/resources/res-img-1/file");
            }

            // Case 4: transient SQLite lookup failure degrades gracefully to local pending draft instead of losing output.
            const effectKeyOffline = "task-offline:output:0";
            const offlineId = await withAdapter(async () => {
                throw new Error("sqlite busy");
            }, async () => useAssetStore.getState().addGenerationAsset(effectKeyOffline, {
                kind: "text",
                title: "离线降级草稿",
                coverUrl: "",
                tags: ["生成"],
                status: "confirmed",
                source: "生成任务",
                data: { content: "offline-output" },
            }));
            await flushAssetStorePersistence();
            expect(useAssetStore.getState().assets.find((item) => item.id === offlineId)?.title).toBe("离线降级草稿");
            expect(peekAssetStoreDraft(scope, offlineId)?.kind).toBe("upsert");
            expect(catalogWrites).toEqual([]);
        } finally {
            restore();
        }
    });
});
