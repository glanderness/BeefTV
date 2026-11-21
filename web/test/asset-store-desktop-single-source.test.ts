import { afterEach, describe, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

import { serializeAssetStorageDocument } from "@/lib/asset-storage-revision";
import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { apiClient } from "@/services/api/request";
import {
    loadWorkspaceAssetLibraryPage,
    preserveLegacyCacheOnlyAssetDrafts,
    resetWorkspaceAssetReadStateForTests,
} from "@/services/workspace-asset-read";
import {
    ASSET_STORE_KEY,
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
    Object.assign(globalThis, {
        window: {
            location: { protocol: "wails:", hostname: "wails.localhost", host: "wails.localhost" },
            localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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

describe("asset store desktop single-source persistence", () => {
    test("skips full ASSET_STORE_KEY IndexedDB writes during reads and mutations while persisting uncommitted drafts", async () => {
        const restore = switchScope("desktop-single-source-1");
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
            await withAdapter(async () => envelope({
                assets: [{ id: "srv-1", payload: textAsset("srv-1", "后端素材") }],
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
            }), async () => {
                await loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 });
            });

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
            expect(peekAssetStoreDraft("desktop-single-source-1", id)?.asset?.title).toBe("更新后草稿");

            // Restart with empty ASSET_STORE_KEY recovers the uncommitted draft from ASSET_STORE_DRAFTS_KEY.
            unloadAssetStoreDraftsForTests();
            useAssetStore.setState({ assets: [] });
            await useAssetStore.persist.rehydrate();
            await hydrateAssetStoreDrafts("desktop-single-source-1");
            expect(useAssetStore.getState().assets.find((item) => item.id === id)?.title).toBe("更新后草稿");
        } finally {
            restore();
        }
    });

    test("promotes legacy cache-only assets to drafts and removes obsolete ASSET_STORE_KEY only after drafts are durable", async () => {
        const restore = switchScope("desktop-legacy-cleanup");
        enterDesktopSingleSourceMode();
        const memory = new Map<string, string>();
        const legacyKey = `${ASSET_STORE_KEY}:user:desktop-legacy-cleanup`;
        memory.set(legacyKey, serializeAssetStorageDocument({
            state: { assets: [textAsset("legacy-only", "旧缓存独有"), textAsset("in-sqlite", "已在库里")] },
            version: 0,
            storageRevision: 3,
            tombstones: { assets: {} },
        }));

        let failDraftWrite = true;
        spies.push(spyOn(localforage, "getItem").mockImplementation(async (key) => memory.get(String(key)) ?? null));
        spies.push(spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            if (isDraftsKey(key) && failDraftWrite) throw new Error("disk full");
            memory.set(String(key), String(value));
            return value;
        }));
        spies.push(spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        }));

        try {
            await useAssetStore.persist.rehydrate();
            expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["legacy-only", "in-sqlite"]);

            // First attempt fails writing promoted draft -> obsolete ASSET_STORE_KEY must NOT be deleted!
            await withAdapter(async () => envelope({
                assets: [{ id: "in-sqlite", title: "已在库里", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }],
            }), async () => {
                await expect(preserveLegacyCacheOnlyAssetDrafts()).rejects.toThrow("disk full");
            });
            expect(memory.has(legacyKey)).toBe(true);

            // Second attempt succeeds after disk recovers -> promoted draft is durable and obsolete ASSET_STORE_KEY is removed.
            failDraftWrite = false;
            useAssetStore.getState().updateAsset("legacy-only", { title: "旧缓存独有" });
            await withAdapter(async () => envelope({
                assets: [{ id: "in-sqlite", title: "已在库里", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }],
            }), async () => {
                await preserveLegacyCacheOnlyAssetDrafts();
            });
            expect(memory.has(legacyKey)).toBe(false);
            const storedDrafts = [...memory.entries()].find(([key]) => isDraftsKey(key))?.[1] ?? "";
            expect(storedDrafts).toContain("legacy-only");
        } finally {
            restore();
        }
    });

    test("addGenerationAsset in desktop single-source mode deduplicates, respects delete drafts, and never writes ASSET_STORE_KEY", async () => {
        const restore = switchScope("desktop-gen-asset");
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
            const id1 = await useAssetStore.getState().addGenerationAsset("task-1:output:0", {
                kind: "text",
                title: "生成结果",
                coverUrl: "",
                tags: ["生成"],
                status: "confirmed",
                source: "生成任务",
                data: { content: "generated" },
            });
            const id2 = await useAssetStore.getState().addGenerationAsset("task-1:output:0", {
                kind: "text",
                title: "重复生成",
                coverUrl: "",
                tags: ["生成"],
                status: "confirmed",
                source: "生成任务",
                data: { content: "duplicate" },
            });
            expect(id2).toBe(id1);
            expect(useAssetStore.getState().assets.filter((item) => item.id === id1)).toHaveLength(1);
            expect(catalogWrites).toEqual([]);
            expect(peekAssetStoreDraft("desktop-gen-asset", id1)?.kind).toBe("upsert");

            // Tombstoned asset rejects re-creation under the same effectKey.
            recordAssetStoreDraft(id1, "delete");
            await expect(useAssetStore.getState().addGenerationAsset("task-1:output:0", {
                kind: "text",
                title: "删除后复活",
                coverUrl: "",
                tags: ["生成"],
                status: "confirmed",
                source: "生成任务",
                data: { content: "zombie" },
            })).rejects.toThrow("生成素材已被用户删除");
            expect(catalogWrites).toEqual([]);
        } finally {
            restore();
        }
    });
});
