import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

import { scopedStorageKey } from "@/lib/user-scope";

export const DIAGNOSTICS_DB_NAME = "beeftv-diagnostics-events";
export const DIAGNOSTICS_EVENTS_STORE_NAME = "events";

const LEGACY_RESOURCE_BLOB_PURGE_FLAG = "beeftv-legacy-resource-blob-idb-purged-v1";

let diagnosticsForage: LocalForage | undefined;
let diagnosticsStoreFactory: (() => LocalForage) | undefined;
let legacyBlobPurgeScheduled = false;

function getDiagnosticsForage(): LocalForage {
    if (!diagnosticsForage) {
        diagnosticsForage = diagnosticsStoreFactory
            ? diagnosticsStoreFactory()
            : localforage.createInstance({
                  name: DIAGNOSTICS_DB_NAME,
                  storeName: DIAGNOSTICS_EVENTS_STORE_NAME,
              });
    }
    return diagnosticsForage;
}

/**
 * Isolated IndexedDB database for client diagnostic events so contention or
 * failure in the main `infinite-canvas` database can never stall diagnostics.
 */
export function diagnosticsStorageForScope(scope?: string): StateStorage {
    const keyFor = (name: string) => scopedStorageKey(name, scope);
    return {
        getItem: async (name) => {
            if (typeof window === "undefined") return null;
            return (await getDiagnosticsForage().getItem<string>(keyFor(name))) || null;
        },
        setItem: async (name, value) => {
            if (typeof window === "undefined") return;
            await getDiagnosticsForage().setItem(keyFor(name), value);
        },
        removeItem: async (name) => {
            if (typeof window === "undefined") return;
            await getDiagnosticsForage().removeItem(keyFor(name));
        },
    };
}

/**
 * One-time background cleanup of legacy v2.3.x `resource_blobs` and
 * `resource_blob_meta` IndexedDB stores so existing desktop users reclaim disk
 * space without blocking startup or pulling media modules into the boot bundle.
 */
export function purgeLegacyResourceBlobIndexedDB(): Promise<void> {
    if (legacyBlobPurgeScheduled) return Promise.resolve();
    legacyBlobPurgeScheduled = true;
    try {
        if (typeof localStorage !== "undefined" && localStorage.getItem(LEGACY_RESOURCE_BLOB_PURGE_FLAG) === "1") {
            return Promise.resolve();
        }
    } catch {
        // Ignore storage flag read failures.
    }
    return (async () => {
        try {
            const storage = await import("@/lib/localforage-storage");
            if (typeof storage.localForageInstance !== "function") return;
            const blobs = storage.localForageInstance(storage.RESOURCE_BLOBS_STORE_NAME);
            const meta = storage.localForageInstance(storage.RESOURCE_BLOB_META_STORE_NAME);
            await Promise.allSettled([blobs.clear(), meta.clear()]);
            try {
                if (typeof localStorage !== "undefined") localStorage.setItem(LEGACY_RESOURCE_BLOB_PURGE_FLAG, "1");
            } catch {
                // Ignore flag write failures.
            }
        } catch {
            // Best-effort cleanup only.
        }
    })();
}

export function resetDiagnosticsStorageForTests() {
    diagnosticsForage = undefined;
    legacyBlobPurgeScheduled = false;
}

export function installDiagnosticsStoreFactoryForTests(factory?: () => LocalForage) {
    diagnosticsStoreFactory = factory;
    resetDiagnosticsStorageForTests();
}
