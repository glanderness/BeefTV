import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import localforage from "localforage";

import {
    APP_STATE_STORE_NAME,
    CANVAS_FOLDER_PENDING_STORE_NAME,
    IMAGE_FILES_STORE_NAME,
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

function mockExtraStore(onReady: () => Promise<void>) {
    const store = {
        ready: onReady,
        getItem: async () => {
            await store.ready();
            return null;
        },
        setItem: async (_key: string, value: unknown) => value,
        removeItem: async () => undefined,
        keys: async () => {
            await store.ready();
            return [];
        },
        clear: async () => {
            await store.ready();
        },
        length: async () => {
            await store.ready();
            return 0;
        },
        iterate: async (iteratee: (value: unknown, key: string, iterationNumber: number) => unknown) => {
            await store.ready();
            return iteratee(null, "k", 1);
        },
    };
    return store;
}

test("folder pending ready does not overlap an app_state read", async () => {
    let appReads = 0;
    let folderInits = 0;
    let overlapped = false;
    const getItem = spyOn(localforage, "getItem").mockImplementation(async () => {
        appReads += 1;
        if (folderInits) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (folderInits) overlapped = true;
        appReads -= 1;
        return null;
    });
    const createInstance = spyOn(localforage, "createInstance").mockImplementation(() => {
        return mockExtraStore(async () => {
            folderInits += 1;
            if (appReads) overlapped = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (appReads) overlapped = true;
            folderInits -= 1;
        }) as never;
    });
    try {
        await Promise.all([
            localForageStorageForScope("guest").getItem("canvas-document-journal:startup"),
            localForageInstance(CANVAS_FOLDER_PENDING_STORE_NAME).getItem("guest"),
        ]);
        expect(overlapped).toBe(false);
        expect(createInstance).toHaveBeenCalledTimes(1);
        expect(createInstance.mock.calls[0]?.[0]).toEqual({
            name: "infinite-canvas",
            storeName: CANVAS_FOLDER_PENDING_STORE_NAME,
        });
    } finally {
        getItem.mockRestore();
        createInstance.mockRestore();
        resetLocalForageDatabaseForTests();
    }
});

test("all infinite-canvas object stores serialize ready including iterate", async () => {
    let inflight = 0;
    let overlapped = false;
    const mark = async () => {
        if (inflight) overlapped = true;
        inflight += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (inflight > 1) overlapped = true;
        inflight -= 1;
    };
    const getItem = spyOn(localforage, "getItem").mockImplementation(async () => {
        await mark();
        return null;
    });
    const created = new Set<string>();
    const createInstance = spyOn(localforage, "createInstance").mockImplementation((options: { storeName?: string } = {}) => {
        created.add(options.storeName || "");
        return mockExtraStore(mark) as never;
    });
    try {
        await Promise.all(INFINITE_CANVAS_OBJECT_STORES.flatMap((name) => {
            const store = localForageInstance(name);
            return name === APP_STATE_STORE_NAME
                ? [store.getItem("probe")]
                : [store.getItem("probe"), store.iterate(() => undefined), store.keys(), store.length()];
        }));
        expect(overlapped).toBe(false);
        expect([...created].sort()).toEqual(
            INFINITE_CANVAS_OBJECT_STORES.filter((name) => name !== APP_STATE_STORE_NAME).slice().sort(),
        );
    } finally {
        getItem.mockRestore();
        createInstance.mockRestore();
        resetLocalForageDatabaseForTests();
    }
});
