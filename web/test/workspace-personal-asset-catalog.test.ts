import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { apiClient } from "@/services/api/request";
import { loadWorkspacePersonalAssetCatalog } from "@/services/workspace-asset-read";
import { resetAssetStoreDraftsForTests, useAssetStore } from "@/stores/use-asset-store";

let previousScope: string;
let native: ReturnType<typeof spyOn>;
let local: ReturnType<typeof spyOn>;
const originalAdapter = apiClient.defaults.adapter;

beforeEach(async () => {
    previousScope = getActiveUserScope();
    setActiveUserScope("personal-catalog-test");
    native = spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true);
    local = spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true);
    useAssetStore.setState({ assets: [] });
    await resetAssetStoreDraftsForTests();
});

afterEach(async () => {
    apiClient.defaults.adapter = originalAdapter;
    native.mockRestore();
    local.mockRestore();
    useAssetStore.setState({ assets: [] });
    await resetAssetStoreDraftsForTests();
    setActiveUserScope(previousScope);
});

function image(id: string, generated = false, saved = false) {
    return {
        id,
        title: id,
        kind: "image",
        status: "confirmed",
        category: "material",
        tags: [],
        coverUrl: "",
        source: generated ? "生成任务" : "上传",
        metadata: generated ? { generationEffectKey: id, savedToLibrary: saved } : {},
        data: { dataUrl: "/api/resources/res-1/file", storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
        createdAt: "2026-10-02T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
    };
}

function envelope(assets: unknown[], page: number, total: number, hasMore: boolean, generatedTotal = 0) {
    return { data: { code: 0, data: { assets, page, pageSize: 120, total, hasMore, generatedTotal } }, status: 200, statusText: "OK", headers: {}, config: {} as never };
}

test("catalog reads all metadata batches before deriving personal totals and keeps saved generations", async () => {
    const catalog = [...Array.from({ length: 37 }, (_, i) => image(`history-${i}`, true)), ...Array.from({ length: 123 }, (_, i) => image(`upload-${i}`)), image("saved-generation", true, true)];
    const pages: number[] = [];
    apiClient.defaults.adapter = async (config) => {
        const page = Number(config.params.page);
        expect(config.params.pageSize).toBe(120);
        expect(config.params.status).toBe("active");
        pages.push(page);
        return envelope(catalog.slice((page - 1) * 120, page * 120), page, catalog.length, page * 120 < catalog.length, 38);
    };
    const result = await loadWorkspacePersonalAssetCatalog();
    expect(pages).toEqual([1, 2]);
    expect(result.assets).toHaveLength(124);
    expect(result.assets.some((asset) => asset.id === "saved-generation")).toBe(true);
    expect(result.assets.some((asset) => asset.id.startsWith("history-"))).toBe(false);
    expect(result.total).toBe(124);
    expect(result.kindCounts).toEqual({ image: 124 });
    expect(result.generatedTotal).toBe(38);
});

test("a later page failure rejects instead of exposing an incomplete personal catalog", async () => {
    apiClient.defaults.adapter = async (config) => {
        if (config.params.page === 2) throw new Error("catalog-offline");
        return envelope(
            Array.from({ length: 120 }, (_, i) => image(`asset-${i}`)),
            1,
            121,
            true,
        );
    };
    await expect(loadWorkspacePersonalAssetCatalog()).rejects.toThrow("catalog-offline");
    expect(useAssetStore.getState().assets).toHaveLength(0);
});

test("aborting a catalog read prevents subsequent batches and cache projection", async () => {
    const controller = new AbortController();
    let calls = 0;
    apiClient.defaults.adapter = async () => {
        calls += 1;
        controller.abort();
        return envelope([image("first")], 1, 121, true);
    };
    await expect(loadWorkspacePersonalAssetCatalog({ signal: controller.signal })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(useAssetStore.getState().assets).toHaveLength(0);
});

test("quarantined metadata does not hide valid assets on a later page", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
        apiClient.defaults.adapter = async (config) =>
            config.params.page === 1
                ? envelope(
                      Array.from({ length: 120 }, (_, i) => ({ ...image(`invalid-${i}`), coverUrl: undefined })),
                      1,
                      121,
                      true,
                  )
                : envelope([image("valid-last")], 2, 121, false);
        const result = await loadWorkspacePersonalAssetCatalog();
        expect(result.assets.map((asset) => asset.id)).toEqual(["valid-last"]);
        expect(result.total).toBe(1);
    } finally {
        warning.mockRestore();
    }
});

test("repeated backend records cannot cause an unbounded catalog traversal", async () => {
    let calls = 0;
    apiClient.defaults.adapter = async (config) => {
        calls += 1;
        return envelope([image("repeated")], Number(config.params.page), 300, true);
    };
    await expect(loadWorkspacePersonalAssetCatalog()).rejects.toThrow("未返回新的记录");
    expect(calls).toBe(2);
});
