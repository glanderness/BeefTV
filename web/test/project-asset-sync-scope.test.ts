import { afterEach, describe, expect, spyOn, test } from "bun:test";
import axios from "axios";

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { UserScopeAbandonedError, captureUserScope } from "@/lib/user-scope-guard";
import { apiClient, ApiError } from "@/services/api/request";
import { ensureCanvasNodeAsset, retryCanvasAssetSyncAfterRateLimit } from "@/services/project-asset-sync";
import { persistWorkspaceAssetLink } from "@/services/workspace-asset-repository";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

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

function imageNode(id = "node-1"): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: "图片",
        position: { x: 0, y: 0 },
        width: 8,
        height: 8,
        metadata: {
            content: "/api/resources/res-1/file",
            storageKey: "resource:res-1",
            mimeType: "image/png",
            naturalWidth: 8,
            naturalHeight: 8,
            bytes: 4,
        },
    };
}

function envelope(data: unknown, status = 200, headers: Record<string, string> = {}) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers, config: {} as never };
}

function httpError(config: { url?: string }, status: number, msg: string) {
    return new axios.AxiosError(msg, "ERR_BAD_REQUEST", config as never, undefined, {
        data: { code: status, data: null, msg },
        status,
        statusText: "Error",
        headers: status === 429 ? { "retry-after": "1" } : {},
        config: config as never,
    });
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

afterEach(() => {
    while (spies.length) spies.pop()?.mockRestore();
    useAssetStore.setState({ assets: [] });
});

function requestKey(config: { method?: string; url?: string }) {
    return `${String(config.method || "get").toLowerCase()} ${String(config.url || "")}`;
}

describe("ensureCanvasNodeAsset scope and canonical writes", () => {
    test("desktop ensure puts the asset then links the project", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                if (String(config.method).toLowerCase() === "put") {
                    return envelope({ asset: { id: "ignored", title: "图片", category: "material", status: "confirmed", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
                }
                if (String(config.method).toLowerCase() === "post") {
                    return envelope({ asset: { id: "ignored", title: "图片", category: "material", status: "confirmed", mediaType: "image", versionCount: 1, usages: [], position: 0, updatedAt: "2026-10-02T00:00:00.000Z" } });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const result = await ensureCanvasNodeAsset({
                    canvasId: "canvas-1",
                    domainProjectId: "project-1",
                    node: imageNode(),
                    source: "canvas-manual",
                });
                expect(result.created).toBe(true);
                expect(result.linkedToProject).toBe(true);
                expect(urls[0]?.startsWith("put /assets/")).toBe(true);
                expect(urls[1]).toBe("post /projects/project-1/assets");
            });
        } finally {
            restore();
        }
    });

    test("same-scope concurrent ensure shares the in-flight promise", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const entered = deferred();
        const gate = deferred();
        let puts = 0;
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "put") {
                    puts += 1;
                    entered.resolve();
                    await gate.promise;
                    return envelope({ asset: { id: "x", title: "图片", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
                }
                return envelope({ asset: { id: "x", title: "图片", category: "material", status: "confirmed", mediaType: "image", versionCount: 1, usages: [], position: 0, updatedAt: "2026-10-02T00:00:00.000Z" } });
            }, async () => {
                const first = ensureCanvasNodeAsset({ canvasId: "canvas-1", domainProjectId: "project-1", node: imageNode(), source: "canvas-upload" });
                await entered.promise;
                const second = ensureCanvasNodeAsset({ canvasId: "canvas-1", domainProjectId: "project-1", node: imageNode(), source: "canvas-upload" });
                gate.resolve();
                const [a, b] = await Promise.all([first, second]);
                expect(a.assetId).toBe(b.assetId);
                expect(puts).toBe(1);
            });
        } finally {
            restore();
        }
    });

    test("A→B→A does not join the abandoned pending key", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const firstEntered = deferred();
        const firstGate = deferred();
        const puts: string[] = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "put") {
                    puts.push(getActiveUserScope());
                    if (puts.length === 1) {
                        firstEntered.resolve();
                        await firstGate.promise;
                    }
                    return envelope({ asset: { id: "x", title: "图片", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
                }
                return envelope({ asset: { id: "x", title: "图片", category: "material", status: "confirmed", mediaType: "image", versionCount: 1, usages: [], position: 0, updatedAt: "2026-10-02T00:00:00.000Z" } });
            }, async () => {
                const first = ensureCanvasNodeAsset({ canvasId: "canvas-1", domainProjectId: "project-1", node: imageNode("node-a"), source: "canvas-manual" });
                await firstEntered.promise;
                setActiveUserScope("owner-b");
                setActiveUserScope("owner-a");
                useAssetStore.setState({ assets: [] });
                const second = ensureCanvasNodeAsset({ canvasId: "canvas-1", domainProjectId: "project-1", node: imageNode("node-a"), source: "canvas-manual" });
                firstGate.resolve();
                await expect(first).rejects.toBeInstanceOf(UserScopeAbandonedError);
                const result = await second;
                expect(result.created).toBe(true);
                expect(puts.length).toBeGreaterThanOrEqual(2);
            });
        } finally {
            restore();
        }
    });

    test("403 on asset put does not link the project", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                throw httpError(config, 403, "没有权限");
            }, async () => {
                await expect(ensureCanvasNodeAsset({
                    canvasId: "canvas-1",
                    domainProjectId: "project-1",
                    node: imageNode(),
                    source: "canvas-manual",
                })).rejects.toBeInstanceOf(ApiError);
                expect(urls.every((url) => url.startsWith("put /assets/"))).toBe(true);
                expect(urls.some((url) => url.includes("/projects/"))).toBe(false);
            });
        } finally {
            restore();
        }
    });

    test("409 on asset put does not link the project", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                throw httpError(config, 409, "素材冲突");
            }, async () => {
                await expect(persistWorkspaceAssetLink({
                    asset: {
                        id: "asset-conflict",
                        kind: "text",
                        title: "文本",
                        coverUrl: "",
                        tags: [],
                        category: "other",
                        status: "confirmed",
                        source: "Canvas",
                        data: { content: "x" },
                        createdAt: "2026-10-02T00:00:00.000Z",
                        updatedAt: "2026-10-02T00:00:00.000Z",
                    } satisfies Asset,
                    domainProjectId: "project-1",
                    expectedScope: captureUserScope(),
                })).rejects.toMatchObject({ status: 409 });
                expect(urls).toEqual(["put /assets/asset-conflict"]);
            });
        } finally {
            restore();
        }
    });

    test("write failure on project link leaves linkedToProject unset because ensure throws", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                if (String(config.method).toLowerCase() === "put") {
                    return envelope({ asset: { id: "x", title: "图片", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
                }
                throw httpError(config, 500, "写入失败");
            }, async () => {
                await expect(ensureCanvasNodeAsset({
                    canvasId: "canvas-1",
                    domainProjectId: "project-1",
                    node: imageNode(),
                    source: "canvas-manual",
                })).rejects.toBeInstanceOf(ApiError);
                expect(urls.some((url) => url === "post /projects/project-1/assets")).toBe(true);
            });
        } finally {
            restore();
        }
    });

    test("same-scope 429 retry continues after wait and then links", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const expected = captureUserScope();
        const waitStarted = deferred();
        const waitGate = deferred();
        const urls: string[] = [];
        let puts = 0;
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                if (String(config.method).toLowerCase() === "put") {
                    puts += 1;
                    if (puts === 1) throw httpError(config, 429, "请求过于频繁，请稍后重试");
                    return envelope({ asset: { id: "x", title: "图片", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
                }
                return envelope({ asset: { id: "x", title: "图片", category: "material", status: "confirmed", mediaType: "image", versionCount: 1, usages: [], position: 0, updatedAt: "2026-10-02T00:00:00.000Z" } });
            }, async () => {
                const pending = retryCanvasAssetSyncAfterRateLimit(
                    () => ensureCanvasNodeAsset({ canvasId: "canvas-1", domainProjectId: "project-1", node: imageNode(), source: "canvas-generation", expectedScope: expected }),
                    {
                        expectedScope: expected,
                        wait: async () => {
                            waitStarted.resolve();
                            await waitGate.promise;
                        },
                    },
                );
                await waitStarted.promise;
                waitGate.resolve();
                const result = await pending;
                expect(result.linkedToProject).toBe(true);
                expect(puts).toBe(2);
                expect(urls.filter((url) => url === "post /projects/project-1/assets")).toEqual(["post /projects/project-1/assets"]);
            });
        } finally {
            waitGate.resolve();
            restore();
        }
    });

    test("429 wait then account change abandons before the retry request", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const expected = captureUserScope();
        const waitStarted = deferred();
        const waitGate = deferred();
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                throw httpError(config, 429, "请求过于频繁，请稍后重试");
            }, async () => {
                const pending = retryCanvasAssetSyncAfterRateLimit(
                    () => ensureCanvasNodeAsset({ canvasId: "canvas-1", domainProjectId: "project-1", node: imageNode(), source: "canvas-generation", expectedScope: expected }),
                    {
                        expectedScope: expected,
                        wait: async () => {
                            waitStarted.resolve();
                            await waitGate.promise;
                        },
                    },
                );
                await waitStarted.promise;
                setActiveUserScope("owner-b");
                waitGate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(urls.every((url) => url.startsWith("put /assets/"))).toBe(true);
                expect(urls.some((url) => url.includes("/projects/"))).toBe(false);
            });
        } finally {
            restore();
        }
    });
});
