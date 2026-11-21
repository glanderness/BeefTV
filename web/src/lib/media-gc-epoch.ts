import { getActiveUserScope, scopedStorageKey } from "@/lib/user-scope";

export const MEDIA_GC_EPOCH_KEY = "infinite-canvas:media-gc-epoch";

let localEpoch = 0;

/**
 * Record a reference-bearing mutation (canvas/history/asset stores, operation journal,
 * or direct local image/media blob writes) so any in-flight media GC sweep aborts
 * before deleting a single blob, both within the current tab and across same-origin tabs.
 */
export function bumpMediaReferenceEpoch(scope = getActiveUserScope()) {
    localEpoch += 1;
    if (typeof window === "undefined") return;
    try {
        window.localStorage?.setItem(scopedStorageKey(MEDIA_GC_EPOCH_KEY, scope), `${Date.now()}:${localEpoch}`);
    } catch {
        // Best-effort cross-tab signal; localEpoch still protects the current tab.
    }
}

export function readMediaReferenceEpoch(scope = getActiveUserScope()): string {
    let crossTab = "";
    if (typeof window !== "undefined") {
        try {
            crossTab = window.localStorage?.getItem(scopedStorageKey(MEDIA_GC_EPOCH_KEY, scope)) ?? "";
        } catch {
            crossTab = "";
        }
    }
    return `${localEpoch}|${crossTab}`;
}
