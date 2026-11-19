import { afterEach, expect, test } from "bun:test";
import type LocalForage from "localforage";
import { resetDiagnosticsStorageForTests } from "../src/lib/diagnostics-storage";
import { installLocalForageStoreFactoryForTests, RESOURCE_BLOB_META_STORE_NAME, RESOURCE_BLOBS_STORE_NAME } from "../src/lib/localforage-storage";
import { apiClient } from "../src/services/api/request";
import {
    cacheResourceObjectUrl,
    clearResourceMemoryCache,
    getCachedResourceBlob,
    purgeLegacyResourceBlobIndexedDB,
    resourceMemoryCacheStats,
} from "../src/services/resource-blob-cache";

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
    clearResourceMemoryCache();
    resetDiagnosticsStorageForTests();
    installLocalForageStoreFactoryForTests();
});

test("后端托管资源不向 IndexedDB 镜像写入，且在内存 LRU 内复用对象地址", async () => {
    let idbReads = 0;
    let idbWrites = 0;
    installLocalForageStoreFactoryForTests(() => ({
        ready: async () => undefined,
        getItem: async () => { idbReads += 1; return null; },
        setItem: async () => { idbWrites += 1; throw new Error("should never write backend blobs to IndexedDB"); },
        removeItem: async () => undefined,
        clear: async () => undefined,
        keys: async () => [],
        iterate: async () => undefined,
    }) as unknown as LocalForage);
    const blob = new Blob(["image"], { type: "image/png" });
    let requests = 0;
    apiClient.defaults.adapter = async (config) => {
        requests++;
        expect(config.url).toContain("/file?proxy=1");
        return { data: blob, status: 200, statusText: "OK", headers: {}, config };
    };
    const key = "resource:memory-lru-no-idb";
    const url = await cacheResourceObjectUrl(key);
    expect(url.startsWith("blob:")).toBe(true);
    expect(await (await fetch(url)).text()).toBe("image");
    expect(await cacheResourceObjectUrl(key)).toBe(url);
    expect(await getCachedResourceBlob(key)).toBe(blob);
    expect(requests).toBe(1);
    expect(idbReads).toBe(0);
    expect(idbWrites).toBe(0);
});

test("首次资源请求失败后能重新下载，不缓存失败结果", async () => {
    let requests = 0;
    apiClient.defaults.adapter = async (config) => {
        if (++requests === 1) throw new Error("offline");
        return { data: new Blob(["recovered"]), status: 200, statusText: "OK", headers: {}, config };
    };
    expect(await cacheResourceObjectUrl("resource:retry-preview")).toBe("");
    expect((await cacheResourceObjectUrl("resource:retry-preview")).startsWith("blob:")).toBe(true);
    expect(requests).toBe(2);
});

test("解码失败后的显式重试绕过已发布的坏 Blob 并撤销旧 ObjectURL", async () => {
    let requests = 0;
    apiClient.defaults.adapter = async (config) => ({ data: new Blob([++requests === 1 ? "broken" : "valid"]), status: 200, statusText: "OK", headers: {}, config });
    const key = "resource:decode-retry-preview";
    const first = await cacheResourceObjectUrl(key);
    expect(await (await fetch(first)).text()).toBe("broken");
    const recovered = await cacheResourceObjectUrl(key, true);
    expect(recovered).not.toBe(first);
    expect(await (await fetch(recovered)).text()).toBe("valid");
    expect(await cacheResourceObjectUrl(key)).toBe(recovered);
    expect(requests).toBe(2);
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

test("多节点同时请求同一大素材时合并为一次下载且共享同一 ObjectURL", async () => {
    const gate = deferred<void>();
    const blob = new Blob(["unchanged-original-media"], { type: "image/png" });
    let requests = 0;
    apiClient.defaults.adapter = async (config) => {
        requests++;
        await gate.promise;
        return { data: blob, status: 200, statusText: "OK", headers: {}, config };
    };
    const key = "resource:concurrent-inflight-dedupe";
    const urls = Array.from({ length: 12 }, () => cacheResourceObjectUrl(key));
    const blobs = Array.from({ length: 6 }, () => getCachedResourceBlob(key));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toBe(1);
    gate.resolve();
    const resolved = await Promise.all(urls);
    expect(new Set(resolved).size).toBe(1);
    expect(await (await fetch(resolved[0])).text()).toBe("unchanged-original-media");
    expect((await Promise.all(blobs)).every((value) => value === blob)).toBe(true);
});

test("高优先级 getCachedResourceBlob 优先于排队中的低优先级下载，且并发保持上限 4", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const downloadOrder: string[] = [];
    apiClient.defaults.adapter = async (config) => {
        const match = /\/resources\/([^/]+)\/file/.exec(config.url || "");
        const id = match?.[1] || "unknown";
        downloadOrder.push(id);
        const gate = gates.get(id);
        if (gate) await gate.promise;
        return { data: new Blob([id], { type: "image/png" }), status: 200, statusText: "OK", headers: {}, config };
    };

    const bgPromises: Promise<string>[] = [];
    for (let i = 1; i <= 20; i++) {
        const id = `bg-thumb-${i}`;
        if (i <= 4) gates.set(id, deferred<void>());
        bgPromises.push(cacheResourceObjectUrl(`resource:${id}`));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(downloadOrder.length).toBe(4);

    const queuedReference = cacheResourceObjectUrl("resource:gen-ref-priority");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const priorityPromise = getCachedResourceBlob("resource:gen-ref-priority");
    await new Promise((resolve) => setTimeout(resolve, 5));

    gates.get("bg-thumb-1")!.resolve();
    const priorityBlob = await priorityPromise;
    expect(await priorityBlob?.text()).toBe("gen-ref-priority");
    expect(downloadOrder[4]).toBe("gen-ref-priority");
    await queuedReference;
    expect(downloadOrder.filter((id) => id === "gen-ref-priority")).toHaveLength(1);

    for (let i = 2; i <= 4; i++) gates.get(`bg-thumb-${i}`)!.resolve();
    await Promise.all(bgPromises);
});

test("内存 LRU 严格遵守 128 MB 预算并淘汰旧条目，且一次性清理旧 IndexedDB 媒体库", async () => {
    const chunk = new Uint8Array(24 * 1024 * 1024); // 24 MiB
    apiClient.defaults.adapter = async (config) => ({
        data: new Blob([chunk], { type: "image/png" }),
        status: 200,
        statusText: "OK",
        headers: {},
        config,
    });
    for (let i = 1; i <= 8; i++) {
        await cacheResourceObjectUrl(`resource:lru-heavy-${i}`);
    }
    const stats = resourceMemoryCacheStats();
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
    expect(stats.entries).toBeLessThanOrEqual(5);

    const clearedStores: string[] = [];
    installLocalForageStoreFactoryForTests((storeName) => ({
        ready: async () => undefined,
        clear: async () => { clearedStores.push(storeName); },
    }) as unknown as LocalForage);
    await purgeLegacyResourceBlobIndexedDB();
    expect(clearedStores).toContain(RESOURCE_BLOBS_STORE_NAME);
    expect(clearedStores).toContain(RESOURCE_BLOB_META_STORE_NAME);
});
