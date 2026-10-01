import { createZip } from "@/lib/zip";
import { saveOwnedOrBrowserBlob, type OwnedMediaSaveResult } from "@/services/desktop-media-save";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";
import type { CanvasFolder, CanvasProject } from "@/stores/canvas/use-canvas-store";
import { loadCanvasDrawing, loadCanvasDrawingPreview, loadCanvasDrawingRender } from "@/lib/canvas/canvas-drawing-storage";
import type { CanvasDrawingExport } from "@/types/canvas-export";
import { normalizeLocalCanvasProject } from "@/lib/local-workspace-migration";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { archiveFileExtension, assertBackupHasEntries, assertUniqueArchiveNames, ExportIntegrityError, type MissingExportFile } from "@/lib/export-integrity";

export async function exportCanvasProjects(projects: CanvasProject[], fileName = "画布", options: { includeLocalDrawings?: boolean; folders?: CanvasFolder[] } = {}): Promise<OwnedMediaSaveResult> {
    assertBackupHasEntries(projects.length, "workspace");
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

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}
