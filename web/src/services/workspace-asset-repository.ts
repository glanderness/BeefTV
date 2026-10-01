import { linkProjectAsset, moveProjectAsset, updateProjectAssetCategory } from "@/services/api/projects";
import { ApiError } from "@/services/api/request";
import { deleteWorkspaceAssetRecord, putWorkspaceAsset } from "@/services/api/workspace-data";
import { normalizeAssetCategory } from "@/lib/asset-category";
import { assertUserScope, captureUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import {
    consumeAssetStoreDrafts,
    flushAssetStorePersistence,
    readAssetStoreDrafts,
    runAssetStoreProjection,
    useAssetStore,
    type Asset,
    type AssetCategory,
    type AssetStatus,
} from "@/stores/use-asset-store";

export type WorkspaceAssetLinkOptions = {
    asset: Asset;
    domainProjectId?: string;
    category?: AssetCategory;
    folderId?: string;
    source?: "uploaded" | "canvas";
    signal?: AbortSignal;
    expectedScope?: CapturedUserScope;
};

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function isNotFoundAssetError(error: unknown) {
    return error instanceof ApiError && (error.status === 404 || error.code === 404);
}

function projectLinkedAsset(asset: Asset, domainProjectId: string | undefined, linked: { category?: string; status?: string; primaryVersionId?: string; folderId?: string }) {
    const projectIds = Array.isArray(asset.metadata?.projectIds) ? asset.metadata.projectIds.filter((id): id is string => typeof id === "string") : [];
    return {
        category: normalizeAssetCategory(linked.category || asset.category),
        status: (linked.status as AssetStatus | undefined) || asset.status,
        primaryVersionId: linked.primaryVersionId || asset.primaryVersionId,
        folderId: linked.folderId || asset.folderId,
        metadata: {
            ...asset.metadata,
            ...(domainProjectId ? { projectIds: [...new Set([...projectIds, domainProjectId])] } : {}),
        },
    };
}

/** Single boundary for local asset persistence and optional project linking. */
export async function persistWorkspaceAssetLink({ asset, domainProjectId, category, folderId, source, signal, expectedScope }: WorkspaceAssetLinkOptions) {
    const expected = expectedScope ?? captureUserScope();
    throwIfAborted(signal);
    assertUserScope(expected);

    if (usesBrowserLocalResourceStore()) {
        if (domainProjectId) {
            const projectIds = Array.isArray(asset.metadata?.projectIds) ? asset.metadata.projectIds.filter((id): id is string => typeof id === "string") : [];
            useAssetStore.getState().updateAsset(asset.id, { metadata: { ...asset.metadata, projectIds: [...new Set([...projectIds, domainProjectId])] } });
        }
        await flushAssetStorePersistence(expected);
        assertUserScope(expected);
        return;
    }

    const saved = await putWorkspaceAsset(asset.id, asset, { signal, expectedScope: expected });
    throwIfAborted(signal);
    assertUserScope(expected);
    consumeAssetStoreDrafts(expected, [asset.id]);

    let projected = projectLinkedAsset(asset, undefined, saved.asset);
    if (domainProjectId) {
        const { asset: linkedAsset } = await linkProjectAsset(
            domainProjectId,
            { assetId: asset.id, category: normalizeAssetCategory(category || asset.category), folderId, source },
            signal,
            expected,
        );
        throwIfAborted(signal);
        assertUserScope(expected);
        let linked = category && linkedAsset.category !== category ? (await updateProjectAssetCategory(domainProjectId, asset.id, category, signal, expected)).asset : linkedAsset;
        throwIfAborted(signal);
        assertUserScope(expected);
        if (folderId !== undefined && (linked.folderId || "") !== folderId) linked = (await moveProjectAsset(domainProjectId, asset.id, folderId, signal, expected)).asset;
        throwIfAborted(signal);
        assertUserScope(expected);
        projected = projectLinkedAsset(asset, domainProjectId, linked);
    }

    runAssetStoreProjection(() => {
        useAssetStore.getState().updateAsset(asset.id, projected);
    });
}

export async function deleteWorkspaceAsset(id: string, expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    const assetId = id.trim();
    if (!assetId) throw new Error("素材 ID 不能为空");
    assertUserScope(expected);

    if (usesBrowserLocalResourceStore()) {
        await useAssetStore.getState().removeAsset(assetId);
        await flushAssetStorePersistence(expected);
        return;
    }

    try {
        await deleteWorkspaceAssetRecord(assetId, { expectedScope: expected });
    } catch (error) {
        if (!isNotFoundAssetError(error)) throw error;
    }
    assertUserScope(expected);
    consumeAssetStoreDrafts(expected, [assetId]);
    await runAssetStoreProjection(() => useAssetStore.getState().removeAsset(assetId));
}

export async function persistWorkspaceAssetChanges(expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    if (usesBrowserLocalResourceStore()) {
        await flushAssetStorePersistence(expected);
        return;
    }

    const drafts = readAssetStoreDrafts(expected);
    const committed: string[] = [];
    try {
        for (const id of drafts.upserts) {
            assertUserScope(expected);
            const asset = useAssetStore.getState().assets.find((item) => item.id === id);
            if (!asset) continue;
            await putWorkspaceAsset(id, asset, { expectedScope: expected });
            committed.push(id);
        }
        for (const id of drafts.deletes) {
            assertUserScope(expected);
            try {
                await deleteWorkspaceAssetRecord(id, { expectedScope: expected });
            } catch (error) {
                if (!isNotFoundAssetError(error)) throw error;
            }
            committed.push(id);
        }
    } finally {
        consumeAssetStoreDrafts(expected, committed);
    }
}
