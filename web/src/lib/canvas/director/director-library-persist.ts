import { assertUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { persistWorkspaceAssetLink } from "@/services/workspace-asset-repository";
import { peekAssetStoreDraft, useAssetStore, type NewAsset } from "@/stores/use-asset-store";

export type DirectorCanvasImageHandoff = {
    assetId?: string;
};

export type DirectorLibraryPersistResult = {
    assetId: string;
    created: boolean;
};

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("导演台会话已结束", "AbortError");
}

export function findWorkspaceAssetIdByStorageKey(storageKey?: string) {
    const key = storageKey?.trim();
    if (!key) return undefined;
    return useAssetStore.getState().assets.find((asset) => "storageKey" in asset.data && asset.data.storageKey === key)?.id;
}

/**
 * Create an explicit library draft, then commit through the typed workspace
 * asset boundary. Desktop/hosted PUT the owned asset; browser-local still
 * flushes IndexedDB. Failures keep the draft and do not claim a save.
 */
export async function persistDirectorLibraryAsset(input: {
    asset: NewAsset;
    expectedScope: CapturedUserScope;
    signal?: AbortSignal;
    existingAssetId?: string;
}): Promise<DirectorLibraryPersistResult> {
    const { expectedScope, signal } = input;
    throwIfAborted(signal);
    assertUserScope(expectedScope);

    const existingId = input.existingAssetId?.trim();
    if (existingId) {
        const live = useAssetStore.getState().assets.find((item) => item.id === existingId);
        if (live) {
            if (!peekAssetStoreDraft(expectedScope.userScope, live.id)) return { assetId: live.id, created: false };
            await persistWorkspaceAssetLink({ asset: live, expectedScope, signal, source: "uploaded" });
            throwIfAborted(signal);
            assertUserScope(expectedScope);
            return { assetId: live.id, created: false };
        }
    }

    const assetId = useAssetStore.getState().addAsset(input.asset);
    const asset = useAssetStore.getState().assets.find((item) => item.id === assetId);
    if (!asset) throw new Error("素材写入本地失败");
    await persistWorkspaceAssetLink({ asset, expectedScope, signal, source: "uploaded" });
    throwIfAborted(signal);
    assertUserScope(expectedScope);
    return { assetId, created: true };
}

/** Upload with the captured identity, then persist. Do not recapture after the original upload. */
export async function persistDirectorImageUpload(input: {
    source: string | Blob;
    expectedScope: CapturedUserScope;
    signal?: AbortSignal;
    toAsset: (uploaded: UploadedImage) => NewAsset;
    existingAssetId?: string;
    onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}): Promise<{ uploaded: UploadedImage; persist: DirectorLibraryPersistResult }> {
    throwIfAborted(input.signal);
    assertUserScope(input.expectedScope);
    const uploaded = await uploadImage(input.source, input.onProgress, input.expectedScope);
    throwIfAborted(input.signal);
    assertUserScope(input.expectedScope);
    const persist = await persistDirectorLibraryAsset({
        asset: input.toAsset(uploaded),
        expectedScope: input.expectedScope,
        signal: input.signal,
        existingAssetId: input.existingAssetId,
    });
    return { uploaded, persist };
}

export async function persistDirectorMediaUpload(input: {
    source: Blob;
    prefix: string;
    expectedScope: CapturedUserScope;
    signal?: AbortSignal;
    toAsset: (uploaded: UploadedFile) => NewAsset;
    existingAssetId?: string;
    onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}): Promise<{ uploaded: UploadedFile; persist: DirectorLibraryPersistResult }> {
    throwIfAborted(input.signal);
    assertUserScope(input.expectedScope);
    const uploaded = await uploadMediaFile(input.source, input.prefix, input.onProgress, input.expectedScope);
    throwIfAborted(input.signal);
    assertUserScope(input.expectedScope);
    const persist = await persistDirectorLibraryAsset({
        asset: input.toAsset(uploaded),
        expectedScope: input.expectedScope,
        signal: input.signal,
        existingAssetId: input.existingAssetId,
    });
    return { uploaded, persist };
}
