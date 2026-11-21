import { afterEach, describe, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

import { serializeAssetStorageDocument } from "@/lib/asset-storage-revision";
import { serializeCanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
import { IMAGE_FILES_STORE_NAME, localForageInstance, localForageStorageForScope } from "@/lib/localforage-storage";
import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, scopedStorageKey, setActiveUserScope } from "@/lib/user-scope";
import { applyUserSession } from "@/lib/user-session";
import { apiClient } from "@/services/api/request";
import { getCanvasHydrationHealth, setCanvasHydrationHealth } from "@/services/canvas-hydration-health";
import { deleteStoredMedia, getMediaBlob, setMediaBlob } from "@/services/file-storage";
import {
    loadWorkspaceAssetLibraryPage,
    preserveLegacyCacheOnlyAssetDrafts,
    resetWorkspaceAssetReadStateForTests,
} from "@/services/workspace-asset-read";
import { deleteWorkspaceAsset, persistWorkspaceAssetChanges, persistWorkspaceAssetLink } from "@/services/workspace-asset-repository";
import { usesSingleSourceLocalPersistence } from "@/services/workspace-resource-storage";
import { CANVAS_DRAFTS_KEY } from "@/stores/canvas/canvas-store-persistence";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
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

    test("deleteWorkspaceAsset and cleanupImages reclaim orphaned fallback blobs while protecting pending drafts and canvas references", async () => {
        const scope = "desktop-cleanup-safe";
        const restore = switchScope(scope);
        const previousCanvasHealth = getCanvasHydrationHealth();
        setCanvasHydrationHealth({ error: "", loading: false });
        enterDesktopSingleSourceMode();
        const imageStore = localForageInstance(IMAGE_FILES_STORE_NAME);
        const removedImageKey = `image:${scope}:removed-fallback-1`;
        const draftOnlyImageKey = `image:${scope}:draft-only-fallback-2`;
        const canvasSharedImageKey = `image:${scope}:canvas-shared-fallback-3`;
        const removedVideoKey = `video:${scope}:removed-fallback-vid`;
        const draftOnlyVideoKey = `video:${scope}:draft-only-vid`;
        await imageStore.setItem(removedImageKey, new Blob(["img-a"], { type: "image/png" }));
        await imageStore.setItem(draftOnlyImageKey, new Blob(["img-b"], { type: "image/png" }));
        await imageStore.setItem(canvasSharedImageKey, new Blob(["img-c"], { type: "image/png" }));
        await setMediaBlob(removedVideoKey, new Blob(["vid-a"], { type: "video/mp4" }));
        await setMediaBlob(draftOnlyVideoKey, new Blob(["vid-b"], { type: "video/mp4" }));

        try {
            // Seed a pending draft whose snapshot holds draftOnlyImageKey & draftOnlyVideoKey,
            // then clear in-memory state.assets to simulate paged/unloaded catalog.
            useAssetStore.getState().addAsset({
                kind: "image",
                title: "未加载的图片草稿",
                coverUrl: "blob:http://localhost/draft-img",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                pendingRemoteUpload: true,
                data: { dataUrl: "blob:http://localhost/draft-img", storageKey: draftOnlyImageKey, width: 100, height: 100, bytes: 5, mimeType: "image/png" },
            });
            useAssetStore.getState().addAsset({
                kind: "video",
                title: "未加载的视频草稿",
                coverUrl: "",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                pendingRemoteUpload: true,
                data: { url: "blob:http://localhost/draft-vid", storageKey: draftOnlyVideoKey, width: 1280, height: 720, bytes: 5, mimeType: "video/mp4" },
            });
            await flushAssetStorePersistence();
            // Canvas node still references canvasSharedImageKey.
            useCanvasStore.setState({
                projects: [{
                    id: "proj-ref",
                    title: "画布引用",
                    createdAt: "2026-10-02T00:00:00.000Z",
                    updatedAt: "2026-10-02T00:00:00.000Z",
                    nodes: [{
                        id: "node-1",
                        type: "image" as never,
                        position: { x: 0, y: 0 },
                        width: 200,
                        height: 200,
                        metadata: { storageKey: canvasSharedImageKey },
                    }],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "dots",
                    showImageInfo: false,
                    viewport: { x: 0, y: 0, scale: 1 },
                    directorScenes: [],
                }],
            });

            // Drop the draft-only assets from in-memory state.assets to prove cleanupImages
            // protects ASSET_STORE_DRAFTS_KEY even when state.assets is a partial page!
            useAssetStore.setState({ assets: [] });

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
            const canvasReferencedAssetId = useAssetStore.getState().addAsset({
                kind: "image",
                title: "被画布引用的图片",
                coverUrl: "blob:http://localhost/shared",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                pendingRemoteUpload: true,
                data: { dataUrl: "blob:http://localhost/shared", storageKey: canvasSharedImageKey, width: 100, height: 100, bytes: 5, mimeType: "image/png" },
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
            await flushAssetStorePersistence();

            // Exercise the REAL desktop delete path (deleteWorkspaceAsset) on degraded fallback assets.
            await withAdapter(async () => envelope({ ok: true }), async () => {
                await deleteWorkspaceAsset(removedImgId);
                await deleteWorkspaceAsset(canvasReferencedAssetId);
                await deleteWorkspaceAsset(removedVidId);
            });
            // Orphaned fallback blobs are reclaimed.
            expect(await imageStore.getItem(removedImageKey)).toBeNull();
            expect(await getMediaBlob(removedVideoKey)).toBeNull();
            // Pending draft blobs (unloaded from state.assets) AND canvas-referenced blob survive!
            expect(await imageStore.getItem(draftOnlyImageKey)).not.toBeNull();
            expect(await getMediaBlob(draftOnlyVideoKey)).not.toBeNull();
            expect(await imageStore.getItem(canvasSharedImageKey)).not.toBeNull();
        } finally {
            useCanvasStore.setState({ projects: [] });
            await imageStore.removeItem(removedImageKey);
            await imageStore.removeItem(draftOnlyImageKey);
            await imageStore.removeItem(canvasSharedImageKey);
            await deleteStoredMedia([removedVideoKey, draftOnlyVideoKey]);
            setCanvasHydrationHealth(previousCanvasHealth);
            restore();
        }
    });

    test("legacy ASSET_STORE_KEY tombstones migrate after draft hydration without clobbering existing durable drafts and block resurrection", async () => {
        const scope = "desktop-legacy-tombstone";
        const restore = switchScope(scope);
        enterDesktopSingleSourceMode();
        const memory = new Map<string, string>();
        const legacyKey = scopedStorageKey(ASSET_STORE_KEY, scope);
        const draftsKey = scopedStorageKey(ASSET_STORE_DRAFTS_KEY, scope);

        const effectKeyLegacyDeleted = "task-legacy-tombstone:output:0";
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(effectKeyLegacyDeleted));
        const legacyDeletedId = `generation_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

        // Seed BOTH legacy ASSET_STORE_KEY (with pre-upgrade tombstone) AND an unrelated
        // durable draft in ASSET_STORE_DRAFTS_KEY to prove rehydrate never clobbers drafts!
        memory.set(legacyKey, serializeAssetStorageDocument({
            state: {
                assets: [
                    textAsset(legacyDeletedId, "已删旧生成素材"),
                    textAsset("in-sqlite", "已在库里"),
                ],
            },
            version: 0,
            storageRevision: 4,
            tombstones: { assets: { [legacyDeletedId]: 4 } },
        }));
        memory.set(draftsKey, JSON.stringify({
            drafts: {
                "draft-keep-1": { kind: "upsert", version: 3, asset: textAsset("draft-keep-1", "未提交草稿必须保留") },
            },
            clocks: { "draft-keep-1": 3 },
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
            expect(useAssetStore.getState().assets.map((item) => item.id).sort()).toEqual(["draft-keep-1", "in-sqlite"]);
            expect(peekAssetStoreDraft(scope, "draft-keep-1")?.asset?.title).toBe("未提交草稿必须保留");

            const result = await withAdapter(async () => envelope({
                assets: [{ id: "in-sqlite", title: "已在库里", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }],
            }), async () => preserveLegacyCacheOnlyAssetDrafts());

            expect(result.preservedIds).toEqual([]);
            expect(peekAssetStoreDraft(scope, legacyDeletedId)).toBeUndefined();
            expect(peekAssetStoreDraft(scope, "draft-keep-1")?.asset?.title).toBe("未提交草稿必须保留");
            expect(memory.has(legacyKey)).toBe(false);
            expect(memory.get(draftsKey)).toContain("draft-keep-1");
            expect(memory.get(draftsKey)).toContain(legacyDeletedId);

            // Cold restart after ASSET_STORE_KEY removal: both the unrelated draft AND the
            // migrated tombstone must survive in ASSET_STORE_DRAFTS_KEY.
            unloadAssetStoreDraftsForTests();
            useAssetStore.setState({ assets: [] });
            await hydrateAssetStoreDrafts(scope);
            expect(peekAssetStoreDraft(scope, "draft-keep-1")?.asset?.title).toBe("未提交草稿必须保留");
            expect(useAssetStore.getState().assets.find((item) => item.id === "draft-keep-1")?.title).toBe("未提交草稿必须保留");
            await withAdapter(async () => envelope({ assets: [] }), async () => {
                await expect(useAssetStore.getState().addGenerationAsset(effectKeyLegacyDeleted, {
                    kind: "text",
                    title: "尝试复活旧墓碑",
                    coverUrl: "",
                    tags: ["生成"],
                    status: "confirmed",
                    source: "生成任务",
                    data: { content: "zombie" },
                })).rejects.toThrow("生成素材已被用户删除");
            });
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

            // Case 4: transient SQLite lookup failure saves an unverified draft, and later
            // persistWorkspaceAssetChanges reconciles against SQLite without overwriting user edits.
            const effectKeyOffline = "task-offline:output:0";
            const offlineId = await withAdapter(async () => {
                throw new Error("sqlite busy");
            }, async () => useAssetStore.getState().addGenerationAsset(effectKeyOffline, {
                kind: "text",
                title: "默认离线标题",
                coverUrl: "",
                tags: ["生成"],
                status: "confirmed",
                source: "生成任务",
                data: { content: "offline-output" },
            }));
            await flushAssetStorePersistence();
            expect(useAssetStore.getState().assets.find((item) => item.id === offlineId)?.title).toBe("默认离线标题");
            expect(peekAssetStoreDraft(scope, offlineId)?.asset?.metadata?.generationLookupUnverified).toBe(true);

            // Backend recovers with a pre-existing renamed SQLite row -> commit must adopt it without PUT!
            const putRequests: string[] = [];
            await withAdapter(async (config) => {
                const method = String(config.method || "get").toUpperCase();
                const url = String(config.url || "");
                if (method === "PUT") {
                    putRequests.push(url);
                    throw new Error("should not PUT over existing SQLite generation asset");
                }
                if (url.includes("/assets/batch")) {
                    return envelope({
                        assets: [{
                            ...textAsset(offlineId, "用户早已改过的标题"),
                            tags: ["精选"],
                            metadata: { generationEffectKey: effectKeyOffline },
                        }],
                    });
                }
                throw new Error(`unexpected ${method} ${url}`);
            }, async () => {
                await persistWorkspaceAssetChanges();
            });
            expect(putRequests).toEqual([]);
            expect(useAssetStore.getState().assets.find((item) => item.id === offlineId)?.title).toBe("用户早已改过的标题");
            expect(peekAssetStoreDraft(scope, offlineId)).toBeUndefined();

            // Case 4b: absent on server -> reconcile strips generationLookupUnverified on PUT AND
            // clears it in live state, so a subsequent user rename PUTs cleanly instead of reverting!
            const effectKeyAbsent = "task-offline-absent:output:0";
            const absentId = await withAdapter(async () => {
                throw new Error("sqlite busy");
            }, async () => useAssetStore.getState().addGenerationAsset(effectKeyAbsent, {
                kind: "text",
                title: "初版生成标题",
                coverUrl: "",
                tags: ["生成"],
                status: "confirmed",
                source: "生成任务",
                data: { content: "new-output" },
            }));
            await flushAssetStorePersistence();
            const absentPutBodies: Array<{ title?: string; metadata?: Record<string, unknown> }> = [];
            await withAdapter(async (config) => {
                const method = String(config.method || "get").toUpperCase();
                const url = String(config.url || "");
                if (url.includes("/assets/batch")) return envelope({ assets: [] });
                if (method === "PUT") {
                    const raw = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
                    const body = raw?.asset ?? raw;
                    absentPutBodies.push(body);
                    return envelope({ asset: { id: absentId, title: body.title, updatedAt: "2026-10-02T00:05:00.000Z" } });
                }
                throw new Error(`unexpected ${method} ${url}`);
            }, async () => {
                await persistWorkspaceAssetChanges();
            });
            expect(absentPutBodies).toHaveLength(1);
            expect(absentPutBodies[0]?.title).toBe("初版生成标题");
            expect(absentPutBodies[0]?.metadata?.generationLookupUnverified).toBeUndefined();
            expect(useAssetStore.getState().assets.find((item) => item.id === absentId)?.metadata?.generationLookupUnverified).toBeUndefined();

            // Now user edits the title -> MUST PUT the new title (never revert via reconcile)!
            useAssetStore.getState().updateAsset(absentId, { title: "二次编辑后的标题" });
            await withAdapter(async (config) => {
                const method = String(config.method || "get").toUpperCase();
                const url = String(config.url || "");
                if (url.includes("/assets/batch")) throw new Error("should not reconcile after marker was cleared");
                if (method === "PUT") {
                    const raw = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
                    const body = raw?.asset ?? raw;
                    absentPutBodies.push(body);
                    return envelope({ asset: { id: absentId, title: body.title, updatedAt: "2026-10-02T00:06:00.000Z" } });
                }
                throw new Error(`unexpected ${method} ${url}`);
            }, async () => {
                await persistWorkspaceAssetChanges();
            });
            expect(absentPutBodies).toHaveLength(2);
            expect(absentPutBodies[1]?.title).toBe("二次编辑后的标题");

            // Case 4c: concurrent user edit while reconcile lookup is in flight must not be overwritten!
            const effectKeyRace = "task-offline-race:output:0";
            const raceId = await withAdapter(async () => {
                throw new Error("sqlite busy");
            }, async () => useAssetStore.getState().addGenerationAsset(effectKeyRace, {
                kind: "text",
                title: "竞态初始标题",
                coverUrl: "",
                tags: ["生成"],
                status: "confirmed",
                source: "生成任务",
                data: { content: "race-output" },
            }));
            await flushAssetStorePersistence();
            let releaseLookup!: () => void;
            const lookupStarted = new Promise<void>((resolve) => {
                void withAdapter(async (config) => {
                    const url = String(config.url || "");
                    if (url.includes("/assets/batch")) {
                        resolve();
                        await new Promise<void>((done) => { releaseLookup = done; });
                        return envelope({
                            assets: [{ ...textAsset(raceId, "旧服务端标题"), metadata: { generationEffectKey: effectKeyRace } }],
                        });
                    }
                    throw new Error(`unexpected ${url}`);
                }, async () => {
                    await persistWorkspaceAssetChanges();
                });
            });
            await lookupStarted;
            // User edits while lookup is in flight -> bumps draft version & clears marker!
            useAssetStore.getState().updateAsset(raceId, { title: "用户并发改名" });
            releaseLookup();
            await new Promise((done) => setTimeout(done, 10));
            expect(useAssetStore.getState().assets.find((item) => item.id === raceId)?.title).toBe("用户并发改名");
            expect(peekAssetStoreDraft(scope, raceId)?.asset?.title).toBe("用户并发改名");
            expect(catalogWrites).toEqual([]);
        } finally {
            restore();
        }
    });

    test("addGenerationAsset retry flushes failed draft write before resolving and clearing failures", async () => {
        const scope = "desktop-gen-draft-retry";
        const restore = switchScope(scope);
        enterDesktopSingleSourceMode();
        const memory = new Map<string, string>();
        let remainingDraftWriteFailures = 2;

        spies.push(spyOn(localforage, "getItem").mockImplementation(async (key) => memory.get(String(key)) ?? null));
        spies.push(spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            if (isDraftsKey(key) && remainingDraftWriteFailures > 0) {
                remainingDraftWriteFailures -= 1;
                throw new Error("idb transient write failure");
            }
            memory.set(String(key), String(value));
            return value;
        }));
        spies.push(spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        }));

        const payload = {
            kind: "text" as const,
            title: "重试持久化生成素材",
            coverUrl: "",
            tags: ["生成"],
            status: "confirmed" as const,
            source: "生成任务",
            data: { content: "retry-durable" },
        };
        try {
            const effectKey = "task-draft-retry:output:0";
            // Attempt 1: creates in-memory asset + pending draft, but IndexedDB draft write fails.
            await withAdapter(async () => envelope({ assets: [] }), async () => {
                await expect(useAssetStore.getState().addGenerationAsset(effectKey, payload)).rejects.toThrow("idb transient write failure");
            });
            await expect(flushAssetStorePersistence()).rejects.toThrow("idb transient write failure");
            expect(memory.get(scopedStorageKey(ASSET_STORE_DRAFTS_KEY, scope))).toBeUndefined();

            // Attempt 2: asset is already in memory, IndexedDB still fails -> MUST reject and keep failure recorded.
            await withAdapter(async () => envelope({ assets: [] }), async () => {
                await expect(useAssetStore.getState().addGenerationAsset(effectKey, payload)).rejects.toThrow("idb transient write failure");
            });
            await expect(flushAssetStorePersistence()).rejects.toThrow("idb transient write failure");

            // Attempt 3: IndexedDB recovers -> retry flushes ASSET_STORE_DRAFTS_KEY, resolves, and clears failure.
            const recoveredId = await withAdapter(async () => envelope({ assets: [] }), async () => (
                useAssetStore.getState().addGenerationAsset(effectKey, payload)
            ));
            await flushAssetStorePersistence();
            const persistedRaw = memory.get(scopedStorageKey(ASSET_STORE_DRAFTS_KEY, scope));
            expect(persistedRaw).toBeDefined();
            expect(JSON.parse(persistedRaw!).drafts?.[recoveredId]?.asset?.title).toBe("重试持久化生成素材");
        } finally {
            restore();
        }
    });

    test("persistWorkspaceAssetLink supersedes reconcile when a user edit creates a draft while lookup is in flight without a prior draft", async () => {
        const scope = "desktop-link-reconcile-race";
        const restore = switchScope(scope);
        enterDesktopSingleSourceMode();

        try {
            const unverified: Asset = {
                ...textAsset("generation_unverified_link_race", "未核验初始标题"),
                metadata: { generationEffectKey: "task-link-race:output:0", generationLookupUnverified: true },
            };
            useAssetStore.setState({ assets: [unverified] });
            expect(peekAssetStoreDraft(scope, unverified.id)).toBeUndefined();

            let releaseLookup!: () => void;
            let putOrLinkCalls = 0;
            let linkPromise!: Promise<void>;
            const lookupStarted = new Promise<void>((resolve) => {
                linkPromise = withAdapter(async (config) => {
                    const url = String(config.url || "");
                    if (url.includes("/assets/batch")) {
                        resolve();
                        await new Promise<void>((done) => { releaseLookup = done; });
                        return envelope({
                            assets: [{ ...textAsset(unverified.id, "服务端旧标题"), metadata: { generationEffectKey: "task-link-race:output:0" } }],
                        });
                    }
                    putOrLinkCalls += 1;
                    return envelope({ asset: unverified });
                }, async () => persistWorkspaceAssetLink({ asset: unverified, domainProjectId: "proj-race" }));
            });

            await lookupStarted;
            // User edits while lookup is in flight; no draft existed before lookup (submittedVersion === undefined).
            useAssetStore.getState().updateAsset(unverified.id, { title: "用户并发修改无前置草稿" });
            releaseLookup();
            await linkPromise;

            expect(putOrLinkCalls).toBe(0);
            expect(useAssetStore.getState().assets.find((item) => item.id === unverified.id)?.title).toBe("用户并发修改无前置草稿");
            expect(peekAssetStoreDraft(scope, unverified.id)?.asset?.title).toBe("用户并发修改无前置草稿");
        } finally {
            restore();
        }
    });

    test("cleanupImages protects fallback blobs referenced only by CANVAS_DRAFTS_KEY and reclaims them once removed", async () => {
        const scope = "desktop-canvas-drafts-gc";
        const restore = switchScope(scope);
        const previousCanvasHealth = getCanvasHydrationHealth();
        setCanvasHydrationHealth({ error: "", loading: false });
        enterDesktopSingleSourceMode();
        const imageStore = localForageInstance(IMAGE_FILES_STORE_NAME);
        const scopedStorage = localForageStorageForScope(scope);
        const canvasDraftImageKey = `image:${scope}:canvas-draft-only-1`;
        await imageStore.setItem(canvasDraftImageKey, new Blob(["canvas-draft-img"], { type: "image/png" }));

        try {
            useCanvasStore.setState({ projects: [] });
            useAssetStore.setState({ assets: [] });
            await scopedStorage.setItem(CANVAS_DRAFTS_KEY, serializeCanvasStorageDocument({
                state: {
                    projects: [{
                        id: "proj-draft-only",
                        title: "仅存在于草稿键的画布",
                        createdAt: "2026-10-02T00:00:00.000Z",
                        updatedAt: "2026-10-02T00:00:00.000Z",
                        nodes: [{
                            id: "node-draft-1",
                            type: "image" as never,
                            position: { x: 0, y: 0 },
                            width: 200,
                            height: 200,
                            metadata: { storageKey: canvasDraftImageKey },
                        }],
                        connections: [],
                        chatSessions: [],
                        activeChatId: null,
                        backgroundMode: "dots",
                        showImageInfo: false,
                        viewport: { x: 0, y: 0, scale: 1 },
                        directorScenes: [],
                    }],
                },
                version: 0,
                storageRevision: 1,
                deletedProjectIds: {},
            }));

            await useAssetStore.getState().cleanupImages();
            expect(await imageStore.getItem(canvasDraftImageKey)).not.toBeNull();

            await scopedStorage.removeItem(CANVAS_DRAFTS_KEY);
            await useAssetStore.getState().cleanupImages();
            expect(await imageStore.getItem(canvasDraftImageKey)).toBeNull();
        } finally {
            useCanvasStore.setState({ projects: [] });
            await scopedStorage.removeItem(CANVAS_DRAFTS_KEY);
            await imageStore.removeItem(canvasDraftImageKey);
            setCanvasHydrationHealth(previousCanvasHealth);
            restore();
        }
    });
});
