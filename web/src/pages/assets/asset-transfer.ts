import { createZip, readZip } from "@/lib/zip";
import { saveOwnedOrBrowserBlob, type OwnedMediaSaveResult } from "@/services/desktop-media-save";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import type { Asset } from "@/stores/use-asset-store";
import { normalizeLocalAsset } from "@/lib/local-workspace-migration";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { ExportIntegrityError, type MissingExportFile } from "@/lib/export-integrity";

type AssetExportFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    assets: Asset[];
    files: AssetExportItem[];
};

type AssetExportItem = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export async function exportAssets(assets: Asset[]): Promise<OwnedMediaSaveResult> {
    const files: AssetExportItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const missingFiles: MissingExportFile[] = [];
    const seenKeys = new Set<string>();

    await Promise.all(
        assets.map(async (asset) => {
            if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio" && asset.kind !== "model") return;
            const storageKey = asset.data.storageKey;
            if (!storageKey) {
                missingFiles.push({ owner: asset.title || asset.id, reference: "媒体文件" });
                return;
            }
            if (seenKeys.has(storageKey)) return;
            seenKeys.add(storageKey);
            let blob: Blob | null | undefined;
            try {
                blob = asset.kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
            } catch {
                missingFiles.push({ owner: asset.title || asset.id, reference: `${storageKey}（读取失败）` });
                return;
            }
            if (!blob || blob.size === 0) {
                missingFiles.push({ owner: asset.title || asset.id, reference: storageKey });
                return;
            }
            const path = `files/${encodeURIComponent(storageKey)}.${fileExtension(blob.type, asset.kind)}`;
            files.push({ storageKey, path, mimeType: blob.type || asset.data.mimeType, bytes: blob.size });
            zipFiles.push({ name: path, data: blob });
        }),
    );

    if (missingFiles.length) throw new ExportIntegrityError(missingFiles);

    const exportedAssets = isLocalWorkspaceMode() ? assets.map(normalizeLocalAsset) : assets;
    const data: AssetExportFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), assets: exportedAssets, files };
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    return saveOwnedOrBrowserBlob("我的素材.zip", zip);
}

export async function readAssetPackage(file: File) {
    const zip = await readZip(file);
    const assetFile = zip.get("assets.json");
    if (!assetFile) throw new Error("missing assets.json");
    const data = JSON.parse(await assetFile.text()) as AssetExportFile;
    const missingFiles = data.files.filter((item) => !zip.get(item.path));
    if (missingFiles.length) throw new Error(`导入未完成，压缩包缺少文件：${missingFiles.map((item) => item.path).join("、")}`);
    await Promise.all(
        data.files.map(async (item) => {
            const blob = zip.get(item.path);
            if (!blob) return;
            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
            await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
        }),
    );
    return data.assets;
}

function fileExtension(mimeType: string, kind: Asset["kind"]) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("gltf-binary")) return "glb";
    if (mimeType.includes("gltf+json") || mimeType.includes("json")) return "gltf";
    return kind === "image" ? "png" : "bin";
}
