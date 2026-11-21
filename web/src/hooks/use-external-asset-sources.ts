import { useMemo } from "react";

import type { AssetLibraryPickerFolder, AssetLibraryPickerItem } from "@/components/assets/asset-library-picker-modal";
import type { ExternalAssetPickerReference } from "@/lib/plugins/plugin-types";
import type { Asset } from "@/stores/use-asset-store";

export type ExternalAssetSourceState = {
    items: AssetLibraryPickerItem[];
    folders: AssetLibraryPickerFolder[];
    categoryLabels: Record<string, string>;
    loading: boolean;
    error: string;
    importExternalAsset: (reference: ExternalAssetPickerReference, signal?: AbortSignal) => Promise<Asset>;
    uploadExternalFiles: (files: FileList | File[], folderId?: string, signal?: AbortSignal) => Promise<AssetLibraryPickerItem[]>;
};

const EMPTY_ITEMS: AssetLibraryPickerItem[] = [];
const EMPTY_FOLDERS: AssetLibraryPickerFolder[] = [];
const EMPTY_LABELS: Record<string, string> = {};

async function rejectExternalAssetImport(_reference: ExternalAssetPickerReference, _signal?: AbortSignal): Promise<Asset> {
    throw new Error("本地工作区仅支持本地素材");
}

async function rejectExternalAssetUpload(_files: FileList | File[], _folderId?: string, _signal?: AbortSignal): Promise<AssetLibraryPickerItem[]> {
    throw new Error("本地工作区仅支持本地素材");
}

export function createLocalExternalAssetSourceState(): ExternalAssetSourceState {
    return {
        items: EMPTY_ITEMS,
        folders: EMPTY_FOLDERS,
        categoryLabels: EMPTY_LABELS,
        loading: false,
        error: "",
        importExternalAsset: rejectExternalAssetImport,
        uploadExternalFiles: rejectExternalAssetUpload,
    };
}

/** Local workspaces never enumerate or write external SaaS/cloud asset sources. */
export function useExternalAssetSources(_open: boolean): ExternalAssetSourceState {
    return useMemo(() => createLocalExternalAssetSourceState(), []);
}
