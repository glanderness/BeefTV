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
};

export type WorkspaceAssetPageResponse = {
    assets: unknown[];
    kindCounts?: Record<string, number>;
    categoryCounts?: Record<string, number>;
    folderCounts?: Record<string, number>;
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
        }),
    });
}

/** GET /assets without page returns owner summaries only, not media blobs. */
export function listWorkspaceAssetSummaries(config?: HttpRequestConfig) {
    return http.get<{ assets: WorkspaceAssetSummary[] }>("/assets", config);
}

/** POST /assets/batch returns owned client payloads for up to 100 ids. */
export function lookupWorkspaceAssetsByIds(ids: string[], config?: HttpRequestConfig) {
    return http.post<{ assets: unknown[] }>("/assets/batch", { ids }, config);
}
