import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
import { apiClient } from "@/services/api/request";
import { resourceFileUrl } from "@/services/api/resources";
import { loadAssetLibraryPage } from "@/services/local-workspace-sync";
import {
    isUnsavedWorkspaceAsset,
    loadWorkspaceAssetLibraryPage,
    loadWorkspaceAssetsForUse,
    preserveLegacyCacheOnlyAssetDrafts,
    resetWorkspaceAssetReadStateForTests,
    usesWorkspaceAssetLibraryApi,
    WORKSPACE_ASSET_BATCH_LIMIT,
    WORKSPACE_ASSET_TOMBSTONE_SEAM,
} from "@/services/workspace-asset-read";
import { recordAssetStoreDraft, resetAssetStoreDraftsForTests, useAssetStore, type Asset } from "@/stores/use-asset-store";

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

function sampleAsset(id: string, title = "缓存素材"): Asset {
    return {
        id,
        kind: "image",
        title,
        coverUrl: "/api/resources/res-1/file",
        tags: ["生成"],
        category: "material",
        status: "confirmed",
        source: "Canvas",
        metadata: { canvasId: "canvas-1", nodeId: "node-1" },
        data: { dataUrl: "/api/resources/res-1/file", storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
    };
}

function sampleClientAsset(id: string, title = "SQLite 素材", extra: Record<string, unknown> = {}) {
    return {
        id,
        kind: "image",
        title,
        coverUrl: "/api/resources/res-1/file",
        tags: ["生成"],
        category: "material",
        status: "confirmed",
        source: "Canvas",
        data: { dataUrl: "/api/resources/res-1/file", storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        ...extra,
    };
}

function pageResponse(assets: unknown[], extra: { total?: number; page?: number; pageSize?: number; hasMore?: boolean } = {}) {
    return {
        assets,
        kindCounts: { image: assets.length },
        categoryCounts: { material: assets.length },
        folderCounts: {},
        page: extra.page ?? 1,
        pageSize: extra.pageSize ?? 40,
        total: extra.total ?? assets.length,
        hasMore: extra.hasMore ?? false,
    };
}

function envelope(data: unknown, status = 200) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers: {}, config: {} as never };
}

function requestKey(config: { method?: string; url?: string }) {
    return `${String(config.method || "get").toLowerCase()} ${String(config.url || "")}`;
}

function isAssetCollection(url: string) {
    return url === "/assets" || /\/assets$/u.test(url);
}

function isAssetBatch(url: string) {
    return url.includes("/assets/batch");
}

function requestParams(config: { params?: unknown }) {
    return (config.params || {}) as Record<string, unknown>;
}

function requestBody(config: { data?: unknown }) {
    const data = config.data;
    if (typeof data === "string") {
        try {
            return JSON.parse(data) as unknown;
        } catch {
            return data;
        }
    }
    return data;
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

function desktopBackend() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

function browserLocal() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(false));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

function hostedSession() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(false));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(false));
}

afterEach(async () => {
    while (spies.length) spies.pop()?.mockRestore();
    useAssetStore.setState({ assets: [] });
    resetWorkspaceAssetReadStateForTests();
    await resetAssetStoreDraftsForTests();
});

describe("workspace asset canonical reads", () => {
    test("desktop empty cache still lists and selects a SQLite asset", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        expect(usesWorkspaceAssetLibraryApi()).toBe(true);
        expect(useAssetStore.getState().assets).toEqual([]);
        const urls: string[] = [];
        try {
            const page = await withAdapter(async (config) => {
                urls.push(requestKey(config));
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get" && isAssetCollection(url) && requestParams(config).page != null) {
                    expect(requestParams(config)).toEqual({ page: 1, pageSize: 40, status: "active" });
                    return envelope(pageResponse([sampleClientAsset("sqlite-1")]));
                }
                if (method === "post" && isAssetBatch(url)) {
                    expect(requestBody(config)).toEqual({ ids: ["sqlite-1"] });
                    return envelope({ assets: [sampleClientAsset("sqlite-1")] });
                }
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => {
                const result = await loadAssetLibraryPage({ page: 1, pageSize: 40, status: "active" });
                expect(result.assets.map((asset) => asset.id)).toEqual(["sqlite-1"]);
                expect(result.total).toBe(1);
                expect(result.assets[0]?.title).toBe("SQLite 素材");
                await loadWorkspaceAssetsForUse(["sqlite-1"]);
                return result;
            });
            expect(page.assets).toHaveLength(1);
            expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual(["sqlite-1"]);
            expect(urls.filter((url) => url.startsWith("get ")).length).toBe(1);
            expect(urls.some((url) => url.includes("/assets/sqlite-1"))).toBe(false);
        } finally {
            restore();
        }
    });

    test("hosted reads use the same SQLite library API as desktop", async () => {
        const restore = switchScope("owner-a");
        hostedSession();
        expect(usesWorkspaceAssetLibraryApi()).toBe(true);
        try {
            const page = await withAdapter(async (config) => {
                if (String(config.method || "get").toLowerCase() === "get" && isAssetCollection(String(config.url || ""))) {
                    return envelope(pageResponse([sampleClientAsset("hosted-1", "Hosted 素材")]));
                }
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["hosted-1"]);
        } finally {
            restore();
        }
    });

    test("stale confirmed cache does not resurrect a server deletion as saved", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("stale-deleted"), sampleAsset("live", "仍在库里")] });
        try {
            const page = await withAdapter(async (config) => {
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get" && isAssetCollection(url) && requestParams(config).page != null) {
                    return envelope(pageResponse([sampleClientAsset("live", "仍在库里")]));
                }
                if (method === "post" && isAssetBatch(url)) {
                    const ids = (requestBody(config) as { ids?: string[] }).ids || [];
                    return envelope({ assets: ids.filter((id) => id === "live").map((id) => sampleClientAsset(id, "仍在库里")) });
                }
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => {
                const result = await loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" });
                expect(result.assets.map((asset) => asset.id)).toEqual(["live"]);
                expect(result.assets.every((asset) => !isUnsavedWorkspaceAsset(asset))).toBe(true);
                await expect(loadWorkspaceAssetsForUse(["stale-deleted"])).rejects.toThrow("部分本地素材不存在，请重新选择素材");
                await loadWorkspaceAssetsForUse(["live"]);
                return result;
            });
            expect(page.assets.map((asset) => asset.id)).toEqual(["live"]);
            expect(useAssetStore.getState().assets.find((asset) => asset.id === "stale-deleted")?.status).toBe("confirmed");
        } finally {
            restore();
        }
    });

    test("query failure stays a failure and does not become an empty saved library", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("stale")] });
        try {
            await expect(withAdapter(async () => {
                throw new Error("素材服务不可用");
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }))).rejects.toThrow("素材服务不可用");
            expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual(["stale"]);
            expect(useAssetStore.getState().assets[0]?.status).toBe("confirmed");
        } finally {
            restore();
        }
    });

    test("pending delete draft hides a backend row and is not projected back into the store", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [] });
        recordAssetStoreDraft("live", "delete");
        try {
            const page = await withAdapter(async (config) => {
                if (String(config.method || "get").toLowerCase() === "get" && isAssetCollection(String(config.url || ""))) {
                    return envelope(pageResponse([sampleClientAsset("live", "仍在库里")]));
                }
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets).toEqual([]);
            expect(page.total).toBe(0);
            expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual([]);
        } finally {
            restore();
        }
    });

    test("explicit newer draft is retained over the backend payload", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("live", "服务端旧标题")] });
        useAssetStore.getState().updateAsset("live", { title: "本地新标题" });
        try {
            const page = await withAdapter(async (config) => {
                if (String(config.method || "get").toLowerCase() === "get" && isAssetCollection(String(config.url || ""))) {
                    return envelope(pageResponse([sampleClientAsset("live", "服务端旧标题")]));
                }
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets).toHaveLength(1);
            expect(page.assets[0]?.title).toBe("本地新标题");
            expect(isUnsavedWorkspaceAsset(page.assets[0]!)).toBe(true);
            expect(useAssetStore.getState().assets.find((asset) => asset.id === "live")?.title).toBe("本地新标题");
        } finally {
            restore();
        }
    });

    test("A→B→A after a pending read abandons the original expectedScope", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const expected = captureUserScope();
        const entered = deferred();
        const gate = deferred();
        try {
            const pending = withAdapter(async () => {
                entered.resolve();
                await gate.promise;
                return envelope(pageResponse([sampleClientAsset("sqlite-1")]));
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, expectedScope: expected }));
            await entered.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
            expect(useAssetStore.getState().assets).toEqual([]);
        } finally {
            restore();
        }
    });

    test("cache-only rows become recoverable unsaved drafts and report the tombstone seam", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("cache-only"), sampleAsset("live", "仍在库里")] });
        const urls: string[] = [];
        try {
            const preserved = await withAdapter(async (config) => {
                urls.push(requestKey(config));
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get" && isAssetCollection(url) && requestParams(config).page == null) {
                    return envelope({ assets: [{ id: "live", title: "仍在库里", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }] });
                }
                if (method === "put") throw new Error("preserve must not write cache over SQLite");
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => preserveLegacyCacheOnlyAssetDrafts());
            expect(preserved.preservedIds).toEqual(["cache-only"]);
            expect(preserved.tombstoneSeam).toBe(WORKSPACE_ASSET_TOMBSTONE_SEAM);
            const cacheOnly = useAssetStore.getState().assets.find((asset) => asset.id === "cache-only");
            expect(cacheOnly?.status).toBe("draft");
            expect(cacheOnly?.metadata?.recoverableLocalDraft).toBe(true);
            expect(isUnsavedWorkspaceAsset(cacheOnly!)).toBe(true);
            expect(urls.some((url) => url.startsWith("put "))).toBe(false);

            const page = await withAdapter(async (config) => {
                if (String(config.method || "get").toLowerCase() === "get" && requestParams(config).page != null) {
                    return envelope(pageResponse([sampleClientAsset("live", "仍在库里")]));
                }
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets.map((asset) => asset.id).sort()).toEqual(["cache-only", "live"]);
            expect(page.assets.find((asset) => asset.id === "cache-only")?.metadata?.unsaved).toBe(true);
        } finally {
            restore();
        }
    });

    test("browser-local pages filter the store and never call the library API", async () => {
        const restore = switchScope("owner-a");
        browserLocal();
        expect(usesWorkspaceAssetLibraryApi()).toBe(false);
        useAssetStore.setState({ assets: [sampleAsset("local-1"), sampleAsset("local-2", "其他")] });
        const urls: string[] = [];
        try {
            const page = await withAdapter(async (config) => {
                urls.push(requestKey(config));
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, query: "缓存" }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["local-1"]);
            expect(urls).toEqual([]);
            await preserveLegacyCacheOnlyAssetDrafts();
            expect(useAssetStore.getState().assets.every((asset) => asset.status === "confirmed")).toBe(true);
        } finally {
            restore();
        }
    });

    test("favorite extra filters reuse one bounded page and do not fetch each asset", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        const assets = [
            sampleClientAsset("fav-1", "收藏一", { metadata: { favorite: true } }),
            sampleClientAsset("plain-1", "普通"),
            sampleClientAsset("fav-2", "收藏二", { metadata: { favorite: true } }),
        ];
        try {
            const page = await withAdapter(async (config) => {
                urls.push(requestKey(config));
                expect(requestParams(config).page).toBe(1);
                expect(Number(requestParams(config).pageSize)).toBeGreaterThanOrEqual(120);
                expect(requestParams(config).favorite).toBeUndefined();
                return envelope(pageResponse(assets, { pageSize: 120, total: 3 }));
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, favorite: true }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["fav-1", "fav-2"]);
            expect(page.total).toBe(2);
            expect(urls).toEqual(["get /assets"]);
            expect(urls.some((url) => url.includes("/assets/fav-"))).toBe(false);
        } finally {
            restore();
        }
    });

    test("batch lookup chunks at 100 and rejects missing ids", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const ids = Array.from({ length: WORKSPACE_ASSET_BATCH_LIMIT + 1 }, (_, index) => `asset-${index + 1}`);
        const calls: string[][] = [];
        try {
            await expect(withAdapter(async (config) => {
                if (!isAssetBatch(String(config.url || ""))) throw new Error(`unexpected ${requestKey(config)}`);
                const chunk = ((requestBody(config) as { ids?: string[] }).ids || []);
                calls.push(chunk);
                return envelope({ assets: chunk.slice(0, Math.min(chunk.length, 50)).map((id) => sampleClientAsset(id)) });
            }, async () => loadWorkspaceAssetsForUse(ids))).rejects.toThrow("部分本地素材不存在，请重新选择素材");
            expect(calls).toHaveLength(2);
            expect(calls[0]).toHaveLength(100);
            expect(calls[1]).toEqual(["asset-101"]);
        } finally {
            restore();
        }
    });

    test("assets page and session hydrate through the workspace library API", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        const session = readFileSync(resolve(import.meta.dir, "../src/lib/user-session.ts"), "utf8");
        expect(page).toContain("usesWorkspaceAssetLibraryApi()");
        expect(page).toContain("canonicalReads");
        expect(page).toContain("未保存");
        expect(page).toContain("素材读取失败");
        expect(page).not.toContain("preferLocalUnsynced");
        expect(page).not.toContain("isLocalWorkspaceMode");
        expect(session).toContain("preserveLegacyCacheOnlyAssetDrafts");
        expect(session).not.toMatch(/auth\/session|remote user|cloud/i);
    });

    test("blob display URLs are replaced from the resource storage key", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        try {
            const page = await withAdapter(async () => envelope(pageResponse([sampleClientAsset("blob-1", "带资源", {
                coverUrl: "blob:http://localhost/old",
                data: { dataUrl: "blob:http://localhost/old", storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
            })])), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            const asset = page.assets[0];
            expect(asset && "data" in asset && "dataUrl" in asset.data ? asset.data.dataUrl : "").toBe(resourceFileUrl("res-1"));
            expect(asset?.coverUrl).toBe(resourceFileUrl("res-1"));
        } finally {
            restore();
        }
    });
});
