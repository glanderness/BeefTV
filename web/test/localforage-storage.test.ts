import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import localforage from "localforage";

import {
    APP_STATE_STORE_NAME,
    INFINITE_CANVAS_OBJECT_STORES,
    localForageInstance,
    localForageStorageForScope,
    resetLocalForageDatabaseForTests,
} from "@/lib/localforage-storage";

afterEach(() => {
    resetLocalForageDatabaseForTests();
});

const wiredModules: Array<[string, string[]]> = [
    ["lib/canvas/canvas-folder-storage.ts", ["localForageInstance(CANVAS_FOLDER_PENDING_STORE_NAME)"]],
    ["lib/canvas/canvas-drawing-storage.ts", [
        "localForageInstance(DRAWING_DOCUMENTS_STORE_NAME)",
        "localForageInstance(DRAWING_PREVIEWS_STORE_NAME)",
        "localForageInstance(DRAWING_GENERATION_RENDERS_STORE_NAME)",
    ]],
    ["services/image-storage.ts", ["localForageInstance(IMAGE_FILES_STORE_NAME)"]],
    ["services/local-media-repository.ts", ["localForageInstance(MEDIA_FILES_STORE_NAME)"]],
    ["services/resource-blob-cache.ts", [
        "localForageInstance(RESOURCE_BLOBS_STORE_NAME)",
        "localForageInstance(RESOURCE_BLOB_META_STORE_NAME)",
    ]],
];

test("infinite-canvas stores use the shared facade instead of a private createInstance", () => {
    for (const [relative, wirings] of wiredModules) {
        const source = readFileSync(resolve(import.meta.dir, "../src", relative), "utf8");
        for (const wiring of wirings) expect(source).toContain(wiring);
        expect(source).not.toContain("localforage.createInstance");
        expect(source).not.toContain("from \"localforage\"");
    }
    const facade = readFileSync(resolve(import.meta.dir, "../src/lib/localforage-storage.ts"), "utf8");
    for (const storeName of INFINITE_CANVAS_OBJECT_STORES) {
        expect(facade).toContain(`"${storeName}"`);
    }
});

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

test("first open readies object stores one at a time", async () => {
    let inflight = 0;
    let overlapped = false;
    const readied: string[] = [];
    const mark = async (storeName: string) => {
        if (inflight) overlapped = true;
        inflight += 1;
        readied.push(storeName);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (inflight > 1) overlapped = true;
        inflight -= 1;
    };
    const ready = spyOn(localforage, "ready").mockImplementation(async () => {
        await mark(APP_STATE_STORE_NAME);
    });
    const getItem = spyOn(localforage, "getItem").mockResolvedValue(null);
    const createInstance = spyOn(localforage, "createInstance").mockImplementation((options: { storeName?: string } = {}) => {
        const storeName = options.storeName || "";
        return {
            ready: async () => mark(storeName),
            getItem: async () => null,
            setItem: async (_key: string, value: unknown) => value,
            removeItem: async () => undefined,
            keys: async () => [],
            clear: async () => undefined,
            length: async () => 0,
            iterate: async () => undefined,
        } as never;
    });
    try {
        await Promise.all(INFINITE_CANVAS_OBJECT_STORES.map((name) => localForageInstance(name).getItem("probe")));
        expect(overlapped).toBe(false);
        expect(readied).toEqual([...INFINITE_CANVAS_OBJECT_STORES]);
        expect(createInstance.mock.calls.map((call) => call[0]?.storeName)).toEqual(
            INFINITE_CANVAS_OBJECT_STORES.filter((name) => name !== APP_STATE_STORE_NAME),
        );
    } finally {
        ready.mockRestore();
        getItem.mockRestore();
        createInstance.mockRestore();
        resetLocalForageDatabaseForTests();
    }
});

test("stalled app_state cache getItem does not block a draft setItem", async () => {
    const originalWindow = globalThis.window;
    globalThis.window = originalWindow ?? ({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as never);
    const entered = deferred();
    const gate = deferred();
    const memory = new Map<string, string>();
    const getItem = spyOn(localforage, "getItem").mockImplementation(async (key) => {
        entered.resolve();
        await gate.promise;
        return memory.get(String(key)) ?? null;
    });
    const setItem = spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
        memory.set(String(key), String(value));
        return value;
    });
    try {
        const storage = localForageStorageForScope("owner-a");
        const read = storage.getItem("infinite-canvas:asset_store");
        await entered.promise;
        await storage.setItem("infinite-canvas:asset_store_drafts", JSON.stringify({ drafts: { asset: { title: "编辑后" } } }));
        expect([...memory.entries()].some(([key, value]) => key.includes("asset_store_drafts") && value.includes("编辑后"))).toBe(true);
        gate.resolve();
        await read;
    } finally {
        gate.resolve();
        getItem.mockRestore();
        setItem.mockRestore();
        if (!originalWindow) delete (globalThis as { window?: unknown }).window;
        else globalThis.window = originalWindow;
        resetLocalForageDatabaseForTests();
    }
});
