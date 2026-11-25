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

/** POST /assets/batch returns owned client payloads for up to 100 ids per request. */
export async function lookupWorkspaceAssetsByIds(ids: string[], config?: HttpRequestConfig): Promise<{ assets: unknown[] }> {
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (!uniqueIds.length) {
        return { assets: [] };
    }
    if (uniqueIds.length <= ASSET_BATCH_MAX_IDS) {
        return http.post<{ assets: unknown[] }>("/assets/batch", { ids: uniqueIds }, config);
    }
    const assets: unknown[] = [];
    for (let i = 0; i < uniqueIds.length; i += ASSET_BATCH_MAX_IDS) {
        const res = await http.post<{ assets: unknown[] }>(
            "/assets/batch",
            { ids: uniqueIds.slice(i, i + ASSET_BATCH_MAX_IDS) },
            config,
        );
        if (Array.isArray(res?.assets)) {
            assets.push(...res.assets);
        }
    }
    return { assets };
}
