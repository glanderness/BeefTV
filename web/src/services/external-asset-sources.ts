import type { Asset } from "@/stores/use-asset-store";
import type { AssetSourceProvider, ExternalAssetItem } from "@/lib/plugins/plugin-types";

export type HostedAssetSource = {
    id: string;
    name: string;
    provider: AssetSourceProvider;
};

export type ExternalAssetSyncRecord = {
    sourceId: string;
    sourceName: string;
    status: "synced" | "failed";
    externalId?: string;
    folderId?: string;
    error?: string;
    updatedAt: string;
};

export type ExternalAssetSyncResult = {
    records: ExternalAssetSyncRecord[];
    uploaded: ExternalAssetItem[];
    failures: Array<{ sourceId: string; sourceName: string; error: string }>;
};

/** Local-first workspaces never write generated assets to external SaaS or cloud plugins. */
export async function uploadGeneratedAssetToConfiguredSources(asset: Asset, _signal?: AbortSignal): Promise<ExternalAssetSyncResult> {
    return { records: readSyncRecords(asset), uploaded: [], failures: [] };
}

export function externalAssetSyncFailures(asset: Asset) {
    return readSyncRecords(asset).filter((record) => record.status === "failed");
}

function readSyncRecords(asset: Asset): ExternalAssetSyncRecord[] {
    const raw = asset.metadata?.externalSync;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is ExternalAssetSyncRecord => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Partial<ExternalAssetSyncRecord>;
        return typeof candidate.sourceId === "string" && typeof candidate.sourceName === "string" && (candidate.status === "synced" || candidate.status === "failed") && typeof candidate.updatedAt === "string";
    });
}
