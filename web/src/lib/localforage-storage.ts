import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

import { scopedStorageKey } from "@/lib/user-scope";

export const INFINITE_CANVAS_DB_NAME = "infinite-canvas";
export const APP_STATE_STORE_NAME = "app_state";
export const CANVAS_FOLDER_PENDING_STORE_NAME = "canvas_folder_pending";

localforage.config({
    name: INFINITE_CANVAS_DB_NAME,
    storeName: APP_STATE_STORE_NAME,
});

export type LocalForageKeyStore = {
    getItem<T>(key: string): Promise<T | null>;
    setItem<T>(key: string, value: T): Promise<T>;
    removeItem(key: string): Promise<void>;
};

const stores = new Map<string, LocalForage>();
let databaseTail: Promise<void> = Promise.resolve();

// Extra object stores on this IndexedDB name upgrade the whole database and
// close other connections. Overlapping app_state reads during that upgrade
// throw TypeError on a nulled db handle and abort durable canvas PUT.

function withInfiniteCanvasDatabase<T>(job: () => Promise<T>): Promise<T> {
    const run = databaseTail.then(job, job);
    databaseTail = run.then(() => undefined, () => undefined);
    return run;
}

function forageForStore(storeName: string): LocalForage {
    const cached = stores.get(storeName);
    if (cached) return cached;
    const instance = storeName === APP_STATE_STORE_NAME
        ? localforage
        : localforage.createInstance({ name: INFINITE_CANVAS_DB_NAME, storeName });
    stores.set(storeName, instance);
    return instance;
}

async function withStore<T>(storeName: string, job: (store: LocalForage) => Promise<T>): Promise<T> {
    return withInfiniteCanvasDatabase(async () => job(forageForStore(storeName)));
}

export function localForageInstance(storeName: string): LocalForageKeyStore {
    return {
        getItem: <T>(key: string) => withStore(storeName, (store) => store.getItem<T>(key)),
        setItem: <T>(key: string, value: T) => withStore(storeName, (store) => store.setItem(key, value)),
        removeItem: (key: string) => withStore(storeName, (store) => store.removeItem(key)),
    };
}

export function localForageStorageForScope(scope?: string): StateStorage {
    const keyFor = (name: string) => scopedStorageKey(name, scope);
    const store = localForageInstance(APP_STATE_STORE_NAME);
    return {
        getItem: async (name) => {
            if (typeof window === "undefined") return null;
            return (await store.getItem<string>(keyFor(name))) || null;
        },
        setItem: async (name, value) => {
            if (typeof window === "undefined") return;
            await store.setItem(keyFor(name), value);
        },
        removeItem: async (name) => {
            if (typeof window === "undefined") return;
            await store.removeItem(keyFor(name));
        },
    };
}

export const localForageStorage: StateStorage = localForageStorageForScope();

export function resetLocalForageDatabaseForTests() {
    stores.clear();
    databaseTail = Promise.resolve();
}
