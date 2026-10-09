import { afterEach, expect, test } from "bun:test";
import type LocalForage from "localforage";
import { installLocalForageStoreFactoryForTests } from "../src/lib/localforage-storage";
import { apiClient } from "../src/services/api/request";
import { cacheResourceObjectUrl, getCachedResourceBlob } from "../src/services/resource-blob-cache";

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => { apiClient.defaults.adapter = originalAdapter; installLocalForageStoreFactoryForTests(); });

test("缓存读写失败仍能通过鉴权接口拉取图片，并在会话内复用", async () => {
    installLocalForageStoreFactoryForTests(() => ({
        ready: async () => undefined,
        getItem: async () => { throw new Error("IndexedDB broken"); },
        setItem: async () => { throw new Error("quota full"); },
        removeItem: async () => undefined,
        keys: async () => [], iterate: async () => undefined,
    }) as unknown as LocalForage);
    const blob = new Blob(["image"], { type: "image/png" });
    let requests = 0;
    apiClient.defaults.adapter = async (config) => {
        requests++;
        expect(config.url).toContain("/file?proxy=1");
        return { data: blob, status: 200, statusText: "OK", headers: {}, config };
    };
    const key = "resource:cache-broken-preview";
    const url = await cacheResourceObjectUrl(key);
    expect(url.startsWith("blob:")).toBe(true);
    expect(await (await fetch(url)).text()).toBe("image");
    expect(await cacheResourceObjectUrl(key)).toBe(url);
    expect(await getCachedResourceBlob(key)).toBe(blob);
    expect(requests).toBe(1);
});

test("首次资源请求失败后能重新下载，不缓存失败结果", async () => {
    installLocalForageStoreFactoryForTests(() => ({ ready: async () => undefined, getItem: async () => null, setItem: async (_key: string, value: unknown) => value, keys: async () => [], iterate: async () => undefined }) as unknown as LocalForage);
    let requests = 0;
    apiClient.defaults.adapter = async (config) => {
        if (++requests === 1) throw new Error("offline");
        return { data: new Blob(["recovered"]), status: 200, statusText: "OK", headers: {}, config };
    };
    expect(await cacheResourceObjectUrl("resource:retry-preview")).toBe("");
    expect((await cacheResourceObjectUrl("resource:retry-preview")).startsWith("blob:")).toBe(true);
    expect(requests).toBe(2);
});

test("解码失败后的显式重试绕过已发布的坏 Blob 和持久缓存", async () => {
    const stored = new Map<string, unknown>();
    installLocalForageStoreFactoryForTests(() => ({ ready: async () => undefined, getItem: async (key: string) => stored.get(key) || null, setItem: async (key: string, value: unknown) => { stored.set(key, value); return value; }, keys: async () => [], iterate: async () => undefined }) as unknown as LocalForage);
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
