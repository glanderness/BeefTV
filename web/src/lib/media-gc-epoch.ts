let localEpoch = 0;

/**
 * In-process monotonic counter for single-WebView local media GC safety.
 * Bumped synchronously whenever canvas/history/asset stores, operation journals,
 * or local image/media blob stores mutate so an in-flight GC sweep aborts
 * before deleting any blob under stale reference knowledge.
 */
export function bumpMediaReferenceEpoch() {
    localEpoch += 1;
}

export function readMediaReferenceEpoch(): number {
    return localEpoch;
}
