import { getActiveUserScope, scopedStorageKey } from "@/lib/user-scope";

export const MEDIA_GC_EPOCH_KEY = "infinite-canvas:media-gc-epoch";

let localEpoch = 0;
let storageListenerBound = false;
const pendingCrossTabFlushes = new Set<string>();

function ensureCrossTabStorageListener() {
    if (storageListenerBound || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    storageListenerBound = true;
    try {
        window.addEventListener("storage", (event) => {
            if (!event.key || event.key.startsWith(`${MEDIA_GC_EPOCH_KEY}:user:`)) {
                localEpoch += 1;
            }
        });
    } catch {
        storageListenerBound = false;
    }
}

function scheduleCrossTabEpochFlush(scope: string) {
    if (typeof window === "undefined" || pendingCrossTabFlushes.has(scope)) return;
    pendingCrossTabFlushes.add(scope);
    const flush = () => {
        pendingCrossTabFlushes.delete(scope);
        try {
            window.localStorage?.setItem(scopedStorageKey(MEDIA_GC_EPOCH_KEY, scope), `${Date.now()}:${localEpoch}`);
        } catch {
            // Best-effort cross-tab signal; localEpoch still protects the current tab.
        }
    };
    if (typeof queueMicrotask === "function") queueMicrotask(flush);
    else void Promise.resolve().then(flush);
}

/**
 * Record a reference-bearing mutation (canvas/history/asset stores, operation journal,
 * or direct local image/media blob writes) so any in-flight media GC sweep aborts
 * (or restores a racing key), both within the current tab and across same-origin tabs.
 * Same-tab increments are synchronous in memory; cross-tab localStorage publishes are
 * coalesced per microtask to avoid main-thread jank during high-frequency edits.
 */
export function bumpMediaReferenceEpoch(scope = getActiveUserScope()) {
    ensureCrossTabStorageListener();
    localEpoch += 1;
    scheduleCrossTabEpochFlush(scope);
}

export function readMediaReferenceEpoch(
    scope = getActiveUserScope(),
    options: { checkStorage?: boolean } = {},
): { local: number; crossTab: string } {
    ensureCrossTabStorageListener();
    let crossTab = "";
    if (options.checkStorage !== false && typeof window !== "undefined") {
        try {
            crossTab = window.localStorage?.getItem(scopedStorageKey(MEDIA_GC_EPOCH_KEY, scope)) ?? "";
        } catch {
            crossTab = "";
        }
    }
    return { local: localEpoch, crossTab };
}
