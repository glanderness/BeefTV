import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import localforage from "localforage";

import {
    CANVAS_FOLDER_PENDING_STORE_NAME,
    localForageInstance,
    localForageStorageForScope,
    resetLocalForageDatabaseForTests,
} from "@/lib/localforage-storage";

afterEach(() => {
    resetLocalForageDatabaseForTests();
});

test("folder pending storage uses the shared infinite-canvas instance", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/lib/canvas/canvas-folder-storage.ts"), "utf8");
    expect(source).toContain("localForageInstance(CANVAS_FOLDER_PENDING_STORE_NAME)");
    expect(source).not.toContain("localforage.createInstance");
});

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
        const store = {
            ready: async () => {
                folderInits += 1;
                if (appReads) overlapped = true;
                await new Promise((resolve) => setTimeout(resolve, 20));
                if (appReads) overlapped = true;
                folderInits -= 1;
            },
            getItem: async () => {
                await store.ready();
                return null;
            },
            setItem: async (_key: string, value: unknown) => value,
            removeItem: async () => undefined,
        };
        return store as never;
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
