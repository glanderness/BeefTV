import type { AssetCategory } from "@/lib/asset-category";

export type { AssetCategory } from "@/lib/asset-category";
export type AssetKind = "text" | "image" | "video" | "audio" | "model" | "entity";
export type AssetStatus = "draft" | "review" | "confirmed" | "archived";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; durationMs?: number; hasAudio?: boolean; bytes: number; mimeType: string } };
export type AudioAsset = AssetBase<"audio"> & { data: { url: string; storageKey?: string; durationMs?: number; bytes: number; mimeType: string } };
export type ModelAsset = AssetBase<"model"> & { data: { url: string; storageKey?: string; bytes: number; mimeType: string; fileName: string } };
export type EntityAsset = AssetBase<"entity"> & { data: { definition: Record<string, unknown> } };
export type Asset = TextAsset | ImageAsset | VideoAsset | AudioAsset | ModelAsset | EntityAsset;
export type NewAsset =
    | Omit<TextAsset, "id" | "createdAt" | "updatedAt">
    | Omit<ImageAsset, "id" | "createdAt" | "updatedAt">
    | Omit<VideoAsset, "id" | "createdAt" | "updatedAt">
    | Omit<AudioAsset, "id" | "createdAt" | "updatedAt">
    | Omit<ModelAsset, "id" | "createdAt" | "updatedAt">
    | Omit<EntityAsset, "id" | "createdAt" | "updatedAt">;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    folderId?: string;
    category?: AssetCategory;
    status?: AssetStatus;
    primaryVersionId?: string;
    source?: string;
    note?: string;
    arkAssetId?: string;
    portraitCertified?: boolean;
    pendingRemoteUpload?: boolean;
    remoteUploadError?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

export type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    addAsset: (asset: NewAsset) => string;
    addGenerationAsset: (effectKey: string, asset: NewAsset, signal?: AbortSignal) => Promise<string>;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string, options?: { cleanupMedia?: boolean }) => Promise<void>;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => Promise<boolean>;
};

export type AssetStoreDraftKind = "upsert" | "delete";

export type AssetStoreDraft = {
    kind: AssetStoreDraftKind;
    version: number;
    /** Upsert payload captured at edit time. Delete drafts are tombstones only. */
    asset?: Asset;
};

export type AssetStoreDraftRecord = AssetStoreDraft & { id: string };
