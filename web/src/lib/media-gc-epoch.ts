let localEpoch = 0;
const mediaKeyLocks = new Map<string, Promise<void>>();

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

/**
 * Serialize in-process media writes and GC deletes on the exact same storageKey
 * so a check-then-delete cannot interleave with a concurrent rewrite of that key.
 */
export function withMediaKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = mediaKeyLocks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.then(() => undefined, () => undefined);
    mediaKeyLocks.set(key, tail);
    void tail.finally(() => {
        if (mediaKeyLocks.get(key) === tail) mediaKeyLocks.delete(key);
    });
    return run;
}
