import { createZip, readZip } from "@/lib/zip";
import { saveOwnedOrBrowserBlob, type OwnedMediaSaveResult } from "@/services/desktop-media-save";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";
import type { CanvasFolder, CanvasProject } from "@/stores/canvas/use-canvas-store";
import { loadCanvasDrawing, loadCanvasDrawingPreview, loadCanvasDrawingRender } from "@/lib/canvas/canvas-drawing-storage";
import type { CanvasDrawingExport } from "@/types/canvas-export";
import { normalizeLocalCanvasProject } from "@/lib/local-workspace-migration";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { archiveFileExtension, assertUniqueArchiveNames, ExportIntegrityError, type MissingExportFile } from "@/lib/export-integrity";

export async function exportCanvasProjects(projects: CanvasProject[], fileName = "画布", options: { includeLocalDrawings?: boolean; folders?: CanvasFolder[] } = {}): Promise<OwnedMediaSaveResult> {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const missingFiles: MissingExportFile[] = [];
    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            await Promise.all(
                collectStorageKeys(project).map(async (storageKey) => {
                    let blob: Blob | null | undefined;
                    try {
                        blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                    } catch {
                        missingFiles.push({ owner: project.title || project.id, reference: `${storageKey}（读取失败）` });
                        return;
                    }
                    if (!blob || blob.size === 0) {
                        missingFiles.push({ owner: project.title || project.id, reference: storageKey });
                        return;
                    }
                    const path = `projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(storageKey)}.${archiveFileExtension(blob.type, storageKey.startsWith("image:") ? "png" : "bin")}`;
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }),
            );
            const drawingDocuments = (await Promise.all(project.nodes.filter((node) => options.includeLocalDrawings !== false && node.type === "drawing" && node.metadata?.drawingId).map(async (node): Promise<CanvasDrawingExport | null> => {
                const drawingId = node.metadata?.drawingId;
                if (!drawingId) return null;
                const [saved, preview, render] = await Promise.all([
                    loadCanvasDrawing(project.id, drawingId),
                    loadCanvasDrawingPreview(project.id, drawingId),
                    loadCanvasDrawingRender(project.id, drawingId),
                ]);
                if (!saved) {
                    missingFiles.push({ owner: project.title || project.id, reference: `画板 ${node.title || drawingId}` });
                    return null;
                }
                const previewPath = preview ? `projects/${project.id}/drawings/${safeFileName(drawingId)}.png` : undefined;
                if (preview && previewPath) zipFiles.push({ name: previewPath, data: preview });
                const generationRenderPath = render ? `projects/${project.id}/drawings/${safeFileName(drawingId)}.generation.png` : undefined;
                if (render && generationRenderPath) zipFiles.push({ name: generationRenderPath, data: render.blob });
                return {
                    drawingId,
                    ...saved,
                    previewPath,
                    generationRender: render && generationRenderPath
                        ? { path: generationRenderPath, pageId: render.pageId, width: render.width, height: render.height, mimeType: render.mimeType, background: render.background }
                        : undefined,
                } satisfies CanvasDrawingExport;
            }))).filter((item): item is CanvasDrawingExport => item !== null);
            drawingDocuments.forEach((document) => zipFiles.push({ name: `projects/${project.id}/drawings/${safeFileName(document.drawingId)}.json`, data: JSON.stringify(document) }));
            return { project: isLocalWorkspaceMode() ? normalizeLocalCanvasProject(project) : project, files, drawingDocuments };
        }),
    );

    if (missingFiles.length) throw new ExportIntegrityError(missingFiles);
    assertUniqueArchiveNames(["projects.json", ...zipFiles.map((file) => file.name)]);
    for (const item of exportedProjects) {
        const liveKeys = new Set(collectStorageKeys(item.project));
        for (const file of item.files) {
            if (!liveKeys.has(file.storageKey) || file.path === file.storageKey) {
                throw new Error("备份未完成：文件引用不一致，未生成备份。");
            }
        }
    }

    const projectFolderIds = new Set(projects.map((project) => project.folderId).filter((id): id is string => Boolean(id)));
    const folders = options.folders?.filter((folder) => projectFolderIds.has(folder.id));
    const data: CanvasExportFile = { app: "infinite-canvas", version: 4, exportedAt: new Date().toISOString(), ...(folders?.length ? { folders } : {}), projects: exportedProjects };
    const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    return saveOwnedOrBrowserBlob(`${safeFileName(fileName)}.zip`, zip);
}

export type OpenCanvasArchive = {
    data: CanvasExportFile;
    files: Map<string, Blob>;
};

export async function openCanvasArchive(file: Blob): Promise<OpenCanvasArchive> {
    const zip = await readZip(file);
    const projectFile = zip.get("projects.json");
    if (!projectFile) throw new Error("缺少 projects.json 元数据文件");
    let data: CanvasExportFile;
    try {
        data = JSON.parse(await projectFile.text()) as CanvasExportFile;
    } catch {
        throw new Error("画布备份已损坏，无法导入");
    }
    if (!data || !Array.isArray(data.projects)) throw new Error("projects.json 中缺少画布列表");
    for (const item of data.projects) {
        if (!item || !Array.isArray(item.files)) {
            throw new Error(`画布「${item?.project?.title || "未命名画布"}」的媒体清单无效`);
        }
        const missing = item.files.find((entry) => !entry?.path || !zip.get(entry.path));
        if (missing) throw new Error(`压缩包缺少媒体文件：${missing.path || "未命名文件"}`);
        for (const document of item.drawingDocuments || []) {
            if (document.previewPath && !zip.get(document.previewPath)) {
                throw new Error(`压缩包缺少媒体文件：${document.previewPath}`);
            }
            if (document.generationRender?.path && !zip.get(document.generationRender.path)) {
                throw new Error(`压缩包缺少媒体文件：${document.generationRender.path}`);
            }
        }
    }
    return { data, files: zip };
}

export async function restoreCanvasArchiveMedia(archive: OpenCanvasArchive): Promise<void> {
    for (const item of archive.data.projects) {
        for (const fileItem of item.files) {
            const blob = archive.files.get(fileItem.path);
            if (!blob) throw new Error(`压缩包缺少媒体文件：${fileItem.path}`);
            const mime = fileItem.mimeType || blob.type || "application/octet-stream";
            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, mime);
            await (fileItem.storageKey.startsWith("image:") ? setImageBlob(fileItem.storageKey, typedBlob) : setMediaBlob(fileItem.storageKey, typedBlob));
        }
    }
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}
