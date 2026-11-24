import { http, compactApiParams, type HttpRequestConfig } from "@/services/api/request";
import type { WorkspaceAssetSummary } from "@/services/api/workspace-data";

export type WorkspaceAssetPageFilter = {
    page: number;
    pageSize: number;
    kind?: string;
    category?: string;
    folderId?: string;
    uncategorized?: boolean;
    status?: string;
    query?: string;
    favorite?: boolean;
    recent?: boolean;
    project?: string;
    generated?: boolean;
    personal?: boolean;
};

export type WorkspaceAssetPageResponse = {
    assets: unknown[];
    kindCounts?: Record<string, number>;
    categoryCounts?: Record<string, number>;
    folderCounts?: Record<string, number>;
    favoriteTotal?: number;
    recentTotal?: number;
    projectCounts?: Record<string, number>;
    generatedTotal?: number;
    generatedKindCounts?: Record<string, number>;
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
};

/** GET /assets?page=... returns full client payloads plus facet counts. */
export function listWorkspaceAssetsPage(filter: WorkspaceAssetPageFilter, config?: HttpRequestConfig) {
    return http.get<WorkspaceAssetPageResponse>("/assets", {
        ...config,
        params: compactApiParams({
            page: filter.page,
            pageSize: filter.pageSize,
            kind: filter.kind,
            category: filter.category,
            folderId: filter.folderId,
            uncategorized: filter.uncategorized ? 1 : undefined,
            status: filter.status,
            q: filter.query,
            favorite: filter.favorite ? 1 : undefined,
            recent: filter.recent ? 1 : undefined,
            project: filter.project,
            generated: filter.generated ? 1 : undefined,
            personal: filter.personal ? 1 : undefined,
        }),
    });
}

/** GET /assets without page returns owner summaries only, not media blobs. */
export function listWorkspaceAssetSummaries(config?: HttpRequestConfig) {
    return http.get<{ assets: WorkspaceAssetSummary[] }>("/assets", config);
}

const ASSET_BATCH_MAX_IDS = 100;
const ASSET_BATCH_COALESCE_MS = 10;

type PendingBatchLookup = {
    idList: string[];
    signal?: AbortSignal;
    aborted: boolean;
    resolve: (value: { assets: unknown[] }) => void;
    reject: (reason?: unknown) => void;
    onAbort?: () => void;
};

let pendingBatchLookups: PendingBatchLookup[] = [];
let pendingBatchTimer: ReturnType<typeof setTimeout> | null = null;

function createAbortError(signal?: AbortSignal) {
    if (signal?.reason instanceof Error) return signal.reason;
    return new DOMException("The operation was aborted.", "AbortError");
}

function canCoalesceLookupConfig(config?: HttpRequestConfig) {
    if (!config) return true;
    for (const [key, value] of Object.entries(config)) {
        if (key === "signal") {
            if (value !== undefined && !(typeof AbortSignal !== "undefined" && value instanceof AbortSignal)) {
                return false;
            }
            continue;
        }
        if (value !== undefined) return false;
    }
    return true;
}

function detachAbortListener(entry: PendingBatchLookup) {
    if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener("abort", entry.onAbort);
        entry.onAbort = undefined;
    }
}

function flushPendingBatchLookups() {
    if (pendingBatchTimer !== null) {
        clearTimeout(pendingBatchTimer);
        pendingBatchTimer = null;
    }
    const entries = pendingBatchLookups.filter((entry) => !entry.aborted);
    pendingBatchLookups = [];
    if (!entries.length) return;

    const mergedIds: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        for (const id of entry.idList) {
            if (!seen.has(id)) {
                seen.add(id);
                mergedIds.push(id);
            }
        }
    }
    if (!mergedIds.length) {
        for (const entry of entries) {
            detachAbortListener(entry);
            entry.resolve({ assets: [] });
        }
        return;
    }

    const batchController = new AbortController();
    const checkAllAborted = () => {
        if (entries.every((entry) => entry.aborted) && !batchController.signal.aborted) {
            batchController.abort();
        }
    };
    for (const entry of entries) {
        detachAbortListener(entry);
        if (entry.signal) {
            const onAbort = () => {
                if (entry.aborted) return;
                entry.aborted = true;
                detachAbortListener(entry);
                entry.reject(createAbortError(entry.signal));
                checkAllAborted();
            };
            entry.onAbort = onAbort;
            entry.signal.addEventListener("abort", onAbort, { once: true });
        }
    }

    const chunks: string[][] = [];
    for (let i = 0; i < mergedIds.length; i += ASSET_BATCH_MAX_IDS) {
        chunks.push(mergedIds.slice(i, i + ASSET_BATCH_MAX_IDS));
    }

    void (async () => {
        try {
            const byId = new Map<string, unknown>();
            const failedIdErrors = new Map<string, unknown>();
            const settled = await Promise.allSettled(
                chunks.map((chunk) =>
                    Promise.resolve().then(() =>
                        http.post<{ assets: unknown[] }>("/assets/batch", { ids: chunk }, { signal: batchController.signal }),
                    ),
                ),
            );
            settled.forEach((outcome, index) => {
                const chunk = chunks[index]!;
                if (outcome.status === "fulfilled") {
                    const rawAssets = outcome.value?.assets;
                    if (rawAssets !== undefined && !Array.isArray(rawAssets)) {
                        const malformedErr = new TypeError("Invalid /assets/batch response: assets must be an array");
                        for (const id of chunk) failedIdErrors.set(id, malformedErr);
                        return;
                    }
                    for (const item of rawAssets ?? []) {
                        if (item && typeof item === "object" && "id" in item && typeof (item as { id?: unknown }).id === "string") {
                            byId.set((item as { id: string }).id, item);
                        }
                    }
                } else {
                    for (const id of chunk) {
                        failedIdErrors.set(id, outcome.reason);
                    }
                }
            });
            for (const entry of entries) {
                detachAbortListener(entry);
                if (entry.aborted) continue;
                let entryError: unknown = undefined;
                let hasError = false;
                for (const id of entry.idList) {
                    if (failedIdErrors.has(id)) {
                        entryError = failedIdErrors.get(id);
                        hasError = true;
                        break;
                    }
                }
                if (hasError) {
                    entry.reject(entryError);
                    continue;
                }
                const matched: unknown[] = [];
                for (const id of entry.idList) {
                    if (byId.has(id)) matched.push(byId.get(id)!);
                }
                entry.resolve({ assets: matched });
            }
        } catch (error) {
            for (const entry of entries) {
                detachAbortListener(entry);
                if (entry.aborted) continue;
                entry.reject(error);
            }
        }
    })();
}

/**
 * POST /assets/batch returns owned client payloads for up to 100 ids per request.
 * Concurrent standard lookups within a short window are coalesced, deduplicated,
 * and chunked into <=100-id requests with per-chunk failure isolation.
 */
export function lookupWorkspaceAssetsByIds(ids: string[], config?: HttpRequestConfig): Promise<{ assets: unknown[] }> {
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (!uniqueIds.length) {
        return Promise.resolve({ assets: [] });
    }
    const signal = typeof AbortSignal !== "undefined" && config?.signal instanceof AbortSignal ? config.signal : undefined;
    if (signal?.aborted) {
        return Promise.reject(createAbortError(signal));
    }
    if (!canCoalesceLookupConfig(config)) {
        return http.post<{ assets: unknown[] }>("/assets/batch", { ids: uniqueIds }, config);
    }

    return new Promise<{ assets: unknown[] }>((resolve, reject) => {
        const entry: PendingBatchLookup = {
            idList: uniqueIds,
            signal,
            aborted: false,
            resolve,
            reject,
        };
        if (entry.signal) {
            const onAbort = () => {
                if (entry.aborted) return;
                entry.aborted = true;
                detachAbortListener(entry);
                entry.reject(createAbortError(entry.signal));
                if (pendingBatchLookups.every((item) => item.aborted) && pendingBatchTimer !== null) {
                    clearTimeout(pendingBatchTimer);
                    pendingBatchTimer = null;
                    pendingBatchLookups = [];
                }
            };
            entry.onAbort = onAbort;
            entry.signal.addEventListener("abort", onAbort, { once: true });
        }
        pendingBatchLookups.push(entry);

        const uniqueQueued = new Set<string>();
        for (const item of pendingBatchLookups) {
            if (item.aborted) continue;
            for (const id of item.idList) uniqueQueued.add(id);
        }
        if (uniqueQueued.size >= ASSET_BATCH_MAX_IDS) {
            flushPendingBatchLookups();
            return;
        }
        if (pendingBatchTimer === null) {
            pendingBatchTimer = setTimeout(flushPendingBatchLookups, ASSET_BATCH_COALESCE_MS);
        }
    });
}
