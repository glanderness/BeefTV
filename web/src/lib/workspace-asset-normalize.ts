import { parseAssetRecord } from "@/lib/asset-record";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import type { Asset } from "@/stores/asset-types";

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function blobOrEmpty(value?: string) {
    return !value || value.startsWith("blob:");
}

function safeURLPathname(value: string) {
    try {
        return new URL(value).pathname;
    } catch {
        return value.split(/[?#]/, 1)[0] || "";
    }
}

function looksLikeOwnedResourceFileUrl(value: string | undefined, resourceId: string) {
    if (!value) return false;
    const path = (value.includes("://") ? safeURLPathname(value) : value.split(/[?#]/, 1)[0] || "").replace(/\/+$/, "");
    const match = path.match(/\/(?:api\/)?resources\/([^/]+)\/file$/);
    if (!match) return false;
    try {
        return decodeURIComponent(match[1]) === resourceId;
    } catch {
        return match[1] === resourceId;
    }
}

function rewriteResourceCoverUrl(value: string | undefined, resourceId: string, current: string) {
    if (blobOrEmpty(value) || looksLikeOwnedResourceFileUrl(value, resourceId)) return current;
    return value || current;
}

export function applyResourceDisplayUrls(asset: Asset): Asset {
    const storageKey = "data" in asset && asset.data && "storageKey" in asset.data ? asset.data.storageKey : undefined;
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (!resourceId) return asset;
    const url = resourceFileUrl(resourceId);
    const coverUrl = rewriteResourceCoverUrl(asset.coverUrl, resourceId, url);
    if (asset.kind === "video") {
        return { ...asset, coverUrl, data: { ...asset.data, url } };
    }
    if (asset.kind === "audio") {
        return { ...asset, coverUrl, data: { ...asset.data, url } };
    }
    if (asset.kind === "model") {
        return { ...asset, coverUrl, data: { ...asset.data, url } };
    }
    if (asset.kind === "image") {
        return { ...asset, coverUrl, data: { ...asset.data, dataUrl: url } };
    }
    return { ...asset, coverUrl };
}

export function normalizeWorkspaceAssetPayload(value: unknown): Asset {
    // Durable resource rows can omit process-specific display URLs. Resolve
    // their real locator before validating the complete media record.
    if (isRecord(value) && isRecord(value.data) && typeof value.data.storageKey === "string") {
        const resourceId = resourceIdFromStorageKey(value.data.storageKey);
        const media = value.kind === "image" || value.kind === "video" || value.kind === "audio" || value.kind === "model";
        if (resourceId && media) {
            const field = value.kind === "image" ? "dataUrl" : "url";
            if (value.data[field] === undefined) {
                value = { ...value, data: { ...value.data, [field]: resourceFileUrl(resourceId) } };
            }
        }
    }
    return applyResourceDisplayUrls(parseAssetRecord(value));
}

export function parseWorkspaceAssetPayloads(values: unknown): Asset[] {
    if (values == null) return [];
    if (!Array.isArray(values)) throw new Error("素材列表无效");
    const assets: Asset[] = [];
    values.forEach((item, index) => {
        try {
            assets.push(normalizeWorkspaceAssetPayload(item));
        } catch (error) {
            const id = isRecord(item) && typeof item.id === "string" && item.id.trim() ? item.id : `#${index}`;
            console.warn("已隔离无法展示的素材记录", { id, error: error instanceof Error ? error.message : String(error) });
        }
    });
    return assets;
}
