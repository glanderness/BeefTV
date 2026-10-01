import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { UserScopeAbandonedError } from "@/lib/user-scope-guard";
import { apiClient } from "@/services/api/request";
import {
    clearWorkspaceArchivedAssets,
    resetWorkspaceAssetCommitStateForTests,
    WORKSPACE_ASSET_CLEAR_TRASH_PAGE_SIZE,
    workspaceClearTrashMessage,
} from "@/services/workspace-asset-repository";
import { peekAssetStoreDraft, recordAssetStoreDraft, resetAssetStoreDraftsForTests, useAssetStore, type Asset } from "@/stores/use-asset-store";

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function sampleAsset(id: string, status: Asset["status"] = "confirmed"): Asset {
    return {
        id,
        kind: "text",
        title: id,
        coverUrl: "",
        tags: [],
        category: "other",
        status,
        source: "Canvas",
        data: { content: id },
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
    };
}

function archivedPayload(id: string) {
    return {
        id,
        kind: "image",
        title: id,
        coverUrl: "/api/resources/res-1/file",
        tags: [],
        category: "material",
        status: "archived",
        data: { dataUrl: "/api/resources/res-1/file", storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
    };
}

function envelope(data: unknown, status = 200, code = 0, msg = "") {
    return { data: { code, msg, data }, status, statusText: "OK", headers: {}, config: {} as never };
}

function requestParams(config: { params?: unknown }) {
    return (config.params || {}) as Record<string, unknown>;
}

function requestPath(config: { url?: unknown }) {
    return String(config.url || "").split("?")[0];
}

function requestAssetId(config: { url?: unknown }) {
    return requestPath(config).split("/").pop() || "";
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
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

afterEach(async () => {
    while (spies.length) spies.pop()?.mockRestore();
    useAssetStore.setState({ assets: [] });
    resetWorkspaceAssetCommitStateForTests();
    await resetAssetStoreDraftsForTests();
});

describe("clear workspace archived assets", () => {
    test("pages canonical archived ids until empty and leaves active rows", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const archived = Array.from({ length: 125 }, (_, index) => `arch-${String(125 - index).padStart(3, "0")}`);
        const remaining = [...archived];
        const deleted: string[] = [];
        const pages: number[] = [];
        useAssetStore.setState({
            assets: [sampleAsset("live-1"), sampleAsset("live-2"), sampleAsset("arch-001", "archived")],
        });
        try {
            const result = await withAdapter(async (config) => {
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get" && url.includes("/assets")) {
                    const params = requestParams(config);
                    expect(params.status).toBe("archived");
                    expect(Number(params.page)).toBe(1);
                    pages.push(Number(params.pageSize));
                    const size = Number(params.pageSize) || WORKSPACE_ASSET_CLEAR_TRASH_PAGE_SIZE;
                    return envelope({
                        assets: remaining.slice(0, size).map(archivedPayload),
                        page: 1,
                        pageSize: size,
                        total: remaining.length,
                        hasMore: remaining.length > size,
                    });
                }
                if (method === "delete") {
                    const id = requestAssetId(config);
                    expect(requestParams(config).expectedStatus).toBe("archived");
                    expect(id.startsWith("arch-")).toBe(true);
                    expect(id.startsWith("live-")).toBe(false);
                    const index = remaining.indexOf(id);
                    if (index >= 0) remaining.splice(index, 1);
                    deleted.push(id);
                    return envelope({ id });
                }
                throw new Error(`unexpected ${method} ${url}`);
            }, async () => clearWorkspaceArchivedAssets());
            expect(result.deleted).toBe(125);
            expect(result.remaining).toBe(0);
            expect(result.error).toBeUndefined();
            expect(deleted).toHaveLength(125);
            expect(new Set(deleted).size).toBe(125);
            expect(deleted.some((id) => id.startsWith("live-"))).toBe(false);
            expect(pages.every((size) => size <= 120)).toBe(true);
            expect(useAssetStore.getState().assets.map((asset) => asset.id).sort()).toEqual(["live-1", "live-2"]);
            expect(workspaceClearTrashMessage(result)).toEqual({ type: "success", text: "已彻底清空回收站 125 个素材" });
        } finally {
            restore();
        }
    });

    test("stops on referenced deletion and reports remaining archived total", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const remaining = Array.from({ length: 125 }, (_, index) => `arch-${String(125 - index).padStart(3, "0")}`);
        try {
            const result = await withAdapter(async (config) => {
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get") {
                    const params = requestParams(config);
                    expect(params.status).toBe("archived");
                    const size = Number(params.pageSize) || 40;
                    return envelope({
                        assets: remaining.slice(0, size).map(archivedPayload),
                        page: 1,
                        pageSize: size,
                        total: remaining.length,
                        hasMore: remaining.length > size,
                    });
                }
                if (method === "delete") {
                    const id = requestAssetId(config);
                    expect(requestParams(config).expectedStatus).toBe("archived");
                    if (id === "arch-080") {
                        return envelope(null, 200, 400, "素材仍被引用，请先在对应画布、任务或业务记录中解除引用后再删除");
                    }
                    const index = remaining.indexOf(id);
                    if (index >= 0) remaining.splice(index, 1);
                    return envelope({ id });
                }
                throw new Error(`unexpected ${method} ${url}`);
            }, async () => clearWorkspaceArchivedAssets());
            expect(result.deleted).toBe(45);
            expect(result.remaining).toBe(80);
            expect(result.error?.message).toContain("素材仍被引用");
            expect(remaining).toHaveLength(80);
            expect(remaining[0]).toBe("arch-080");
            expect(peekAssetStoreDraft("owner-a", "arch-080")?.kind).not.toBe("delete");
            expect(workspaceClearTrashMessage(result).type).toBe("error");
            expect(workspaceClearTrashMessage(result).text).toContain("已删除 45 个素材，回收站还剩 80 个。");
            expect(workspaceClearTrashMessage(result).text).toContain("素材仍被引用");
        } finally {
            restore();
        }
    });

    test("abandons the run when the user session changes", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const remaining = ["arch-002", "arch-001"];
        try {
            await expect(withAdapter(async (config) => {
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get") {
                    return envelope({
                        assets: remaining.map(archivedPayload),
                        page: 1,
                        pageSize: 40,
                        total: remaining.length,
                        hasMore: false,
                    });
                }
                if (method === "delete") {
                    expect(requestParams(config).expectedStatus).toBe("archived");
                    setActiveUserScope("owner-b");
                    return envelope({ id: requestAssetId(config) });
                }
                throw new Error(`unexpected ${method} ${url}`);
            }, async () => clearWorkspaceArchivedAssets())).rejects.toBeInstanceOf(UserScopeAbandonedError);
            expect(peekAssetStoreDraft("owner-a", "arch-002")?.kind).toBe("delete");
        } finally {
            restore();
        }
    });

    test("failed clear-trash ack keeps a newer delete recorded during the request", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const remaining = ["arch-002", "arch-001"];
        const hold = deferred<ReturnType<typeof envelope>>();
        let markStarted!: () => void;
        const deleteStarted = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        try {
            const run = withAdapter(async (config) => {
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get") {
                    return envelope({
                        assets: remaining.map(archivedPayload),
                        page: 1,
                        pageSize: 40,
                        total: remaining.length,
                        hasMore: false,
                    });
                }
                if (method === "delete") {
                    const id = requestAssetId(config);
                    expect(requestParams(config).expectedStatus).toBe("archived");
                    if (id === "arch-002") {
                        markStarted();
                        return hold.promise;
                    }
                    throw new Error(`unexpected ${method} ${url}`);
                }
                throw new Error(`unexpected ${method} ${url}`);
            }, async () => clearWorkspaceArchivedAssets());
            await deleteStarted;
            const attempt = peekAssetStoreDraft("owner-a", "arch-002");
            expect(attempt?.kind).toBe("delete");
            const attemptVersion = attempt?.version ?? 0;
            recordAssetStoreDraft("arch-002", "delete");
            hold.resolve(envelope(null, 200, 400, "素材仍被引用，请先在对应画布、任务或业务记录中解除引用后再删除"));
            const result = await run;
            expect(result.deleted).toBe(0);
            expect(result.error?.message).toContain("素材仍被引用");
            expect(peekAssetStoreDraft("owner-a", "arch-002")).toEqual({ kind: "delete", version: attemptVersion + 1 });
        } finally {
            restore();
        }
    });

    test("failed clear-trash ack keeps a newer upsert recorded during the request", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const remaining = ["arch-002", "arch-001"];
        const hold = deferred<ReturnType<typeof envelope>>();
        let markStarted!: () => void;
        const deleteStarted = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        try {
            const run = withAdapter(async (config) => {
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get") {
                    return envelope({
                        assets: remaining.map(archivedPayload),
                        page: 1,
                        pageSize: 40,
                        total: remaining.length,
                        hasMore: false,
                    });
                }
                if (method === "delete") {
                    expect(requestParams(config).expectedStatus).toBe("archived");
                    markStarted();
                    return hold.promise;
                }
                throw new Error(`unexpected ${method} ${url}`);
            }, async () => clearWorkspaceArchivedAssets());
            await deleteStarted;
            const attempt = peekAssetStoreDraft("owner-a", "arch-002");
            expect(attempt?.kind).toBe("delete");
            const attemptVersion = attempt?.version ?? 0;
            recordAssetStoreDraft("arch-002", "upsert");
            hold.resolve(envelope(null, 200, 400, "素材仍被引用，请先在对应画布、任务或业务记录中解除引用后再删除"));
            const result = await run;
            expect(result.deleted).toBe(0);
            expect(result.error?.message).toContain("素材仍被引用");
            expect(peekAssetStoreDraft("owner-a", "arch-002")).toEqual({ kind: "upsert", version: attemptVersion + 1 });
        } finally {
            restore();
        }
    });

    test("browser-local only removes archived rows from the store", async () => {
        const restore = switchScope("owner-a");
        browserLocal();
        useAssetStore.setState({
            assets: [
                sampleAsset("live-1"),
                sampleAsset("arch-1", "archived"),
                sampleAsset("arch-2", "archived"),
            ],
        });
        try {
            const result = await withAdapter(async () => {
                throw new Error("browser-local must not call the library API");
            }, async () => clearWorkspaceArchivedAssets());
            expect(result).toEqual({ deleted: 2, remaining: 0 });
            expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual(["live-1"]);
        } finally {
            restore();
        }
    });
});
