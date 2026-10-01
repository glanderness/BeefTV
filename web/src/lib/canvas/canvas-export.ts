import { confinedArchivePath, createZip, readZip } from "@/lib/zip";
import { saveOwnedOrBrowserBlob, type OwnedMediaSaveResult } from "@/services/desktop-media-save";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { CanvasExportAsset, CanvasExportFile, CanvasProjectExportItem } from "@/types/canvas-export";
import type { CanvasFolder, CanvasProject } from "@/stores/canvas/use-canvas-store";
import { loadCanvasDrawing, loadCanvasDrawingPreview, loadCanvasDrawingRender } from "@/lib/canvas/canvas-drawing-storage";
import type { CanvasDrawingExport } from "@/types/canvas-export";
import { normalizeLocalCanvasProject } from "@/lib/local-workspace-migration";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { archiveFileExtension, assertUniqueArchiveNames, ExportIntegrityError, type MissingExportFile } from "@/lib/export-integrity";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";
import { http } from "@/services/api/request";

export const ARCHIVE_STORAGE_KEY_PATTERN = /^(image|video|audio|file|resource|model|video-reference|audio-reference):/;

export function isArchiveStorageKey(value: string) {
    const key = value.trim();
    if (!key || key.startsWith("data:") || key.startsWith("blob:")) return false;
    return ARCHIVE_STORAGE_KEY_PATTERN.test(key);
}

export async function exportCanvasProjects(projects: CanvasProject[], fileName = "画布", options: { includeLocalDrawings?: boolean; folders?: CanvasFolder[] } = {}): Promise<OwnedMediaSaveResult> {
    const scope = captureUserScope();
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
                    loadCanvasDrawing(project.id, drawingId, scope),
                    loadCanvasDrawingPreview(project.id, drawingId, scope),
                    loadCanvasDrawingRender(project.id, drawingId, scope),
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

    assertUserScope(scope);
    const projectFolderIds = new Set(projects.map((project) => project.folderId).filter((id): id is string => Boolean(id)));
    const folders: CanvasExportFile["folders"] = [];
    for (const folder of options.folders?.filter((item) => projectFolderIds.has(item.id)) || []) {
        let cover: Blob | undefined;
        if (folder.coverResourceId) {
            const response = await http.raw<Blob>({ method: "GET", url: `/resources/${encodeURIComponent(folder.coverResourceId)}/file?proxy=1`, responseType: "blob", expectedScope: scope });
            cover = response.data;
        } else if (folder.coverDataUrl) {
            const response = await fetch(folder.coverDataUrl);
            if (!response.ok) throw new ExportIntegrityError([{ owner: folder.name, reference: "文件夹封面" }]);
            cover = await response.blob();
        }
        assertUserScope(scope);
        if (cover && !cover.size) throw new ExportIntegrityError([{ owner: folder.name, reference: "文件夹封面" }]);
        const coverPath = cover ? `folders/${encodeURIComponent(folder.id)}/cover.${archiveFileExtension(cover.type, "png")}` : undefined;
        if (cover && coverPath) zipFiles.push({ name: coverPath, data: cover });
        folders.push({ ...folder, coverResourceId: undefined, coverDataUrl: undefined, coverPath, coverMimeType: cover?.type || undefined });
    }
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

    const data: CanvasExportFile = { app: "infinite-canvas", version: 4, exportedAt: new Date().toISOString(), ...(folders?.length ? { folders } : {}), projects: exportedProjects };
    const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    assertUserScope(scope);
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
    preflightCanvasArchive(data, zip);
    return { data, files: zip };
}

export function preflightCanvasArchive(data: CanvasExportFile, zip: Map<string, Blob>): void {
    if (!data || data.app !== "infinite-canvas") throw new Error("不是有效的画布备份");
    if (data.version !== 3 && data.version !== 4) throw new Error("不支持的画布备份版本");
    if (!Array.isArray(data.projects)) throw new Error("projects.json 中缺少画布列表");
    if (data.folders !== undefined && !Array.isArray(data.folders)) throw new Error("备份中的文件夹列表无效");
    const folderIds = new Set<string>();
    const archivePaths = new Set<string>(["projects.json"]);
    for (const folder of data.folders || []) {
        if (!folder || typeof folder.id !== "string" || !folder.id.trim() || typeof folder.name !== "string") {
            throw new Error("备份中的文件夹无效");
        }
        if (folderIds.has(folder.id)) throw new Error("备份中存在重复的文件夹");
        folderIds.add(folder.id);
        if (folder.coverPath !== undefined) {
            const path = confinedArchivePath(folder.coverPath);
            if (archivePaths.has(path)) throw new Error(`压缩包存在重名文件：${path}`);
            archivePaths.add(path);
            const blob = zip.get(path);
            if (!blob?.size) throw new Error(`压缩包缺少文件夹封面：${folder.name}`);
        }
    }
    const projectIds = new Set<string>();
    for (const item of data.projects) {
        preflightCanvasArchiveProject(item, zip, projectIds, folderIds, archivePaths);
    }
}

function preflightCanvasArchiveProject(
    item: CanvasProjectExportItem,
    zip: Map<string, Blob>,
    projectIds: Set<string>,
    folderIds: Set<string>,
    archivePaths: Set<string>,
) {
    if (!item || !item.project || typeof item.project !== "object") throw new Error("备份中的画布无效");
    const project = item.project;
    const title = typeof project.title === "string" && project.title.trim() ? project.title : "未命名画布";
    if (typeof project.id !== "string" || !project.id.trim()) throw new Error(`画布「${title}」缺少编号`);
    if (projectIds.has(project.id)) throw new Error(`备份中存在重复的画布：${title}`);
    projectIds.add(project.id);
    if (project.folderId && !folderIds.has(project.folderId)) throw new Error(`画布「${title}」引用了不存在的文件夹`);
    if (!Array.isArray(item.files)) throw new Error(`画布「${title}」的媒体清单无效`);
    if (project.nodes !== undefined && !Array.isArray(project.nodes)) throw new Error(`画布「${title}」的节点列表无效`);
    if (project.connections !== undefined && !Array.isArray(project.connections)) throw new Error(`画布「${title}」的连线列表无效`);
    if (project.timeline !== undefined) preflightCanvasArchiveTimeline(project.timeline, title);
    const nodeIds = new Set<string>();
    for (const node of project.nodes || []) {
        if (!node || typeof node !== "object" || typeof node.id !== "string" || !node.id.trim() || typeof node.type !== "string" || !node.type.trim()) {
            throw new Error(`画布「${title}」包含无效节点`);
        }
        if (nodeIds.has(node.id)) throw new Error(`画布「${title}」存在重复节点`);
        nodeIds.add(node.id);
    }
    const fileKeys = new Set<string>();
    for (const fileItem of item.files) {
        if (!fileItem || typeof fileItem.storageKey !== "string" || typeof fileItem.path !== "string") {
            throw new Error(`画布「${title}」的媒体清单无效`);
        }
        if (!isArchiveStorageKey(fileItem.storageKey)) {
            throw new Error(`画布「${title}」包含无效的媒体引用`);
        }
        if (fileKeys.has(fileItem.storageKey)) throw new Error(`画布「${title}」存在重复的媒体引用`);
        fileKeys.add(fileItem.storageKey);
        const path = confinedArchivePath(fileItem.path);
        if (path === "projects.json" || archivePaths.has(path)) throw new Error(`压缩包存在重名文件：${path}`);
        archivePaths.add(path);
        const blob = zip.get(path) || zip.get(fileItem.path);
        if (!blob || blob.size === 0) throw new Error(`压缩包缺少媒体文件：${fileItem.path || "未命名文件"}`);
    }
    const liveKeys = collectStorageKeys(project);
    for (const storageKey of liveKeys) {
        if (!fileKeys.has(storageKey)) throw new Error(`压缩包缺少媒体文件：${storageKey}`);
    }
    for (const storageKey of fileKeys) {
        if (!liveKeys.includes(storageKey)) throw new Error(`画布「${title}」的媒体清单与画布内容不一致`);
    }
    if (item.drawingDocuments !== undefined && !Array.isArray(item.drawingDocuments)) {
        throw new Error(`画布「${title}」的画板文档无效`);
    }
    const drawingIds = new Set<string>();
    for (const document of item.drawingDocuments || []) {
        if (!document || typeof document.drawingId !== "string" || !document.drawingId.trim()) {
            throw new Error(`画布「${title}」的画板文档无效`);
        }
        if (drawingIds.has(document.drawingId)) throw new Error(`画布「${title}」存在重复画板`);
        drawingIds.add(document.drawingId);
        if (document.previewPath) {
            const path = confinedArchivePath(document.previewPath);
            if (archivePaths.has(path)) throw new Error(`压缩包存在重名文件：${path}`);
            archivePaths.add(path);
            if (!zip.get(path) && !zip.get(document.previewPath)) throw new Error(`压缩包缺少媒体文件：${document.previewPath}`);
        }
        if (document.generationRender?.path) {
            const path = confinedArchivePath(document.generationRender.path);
            if (archivePaths.has(path)) throw new Error(`压缩包存在重名文件：${path}`);
            archivePaths.add(path);
            if (!zip.get(path) && !zip.get(document.generationRender.path)) throw new Error(`压缩包缺少媒体文件：${document.generationRender.path}`);
        }
    }
    for (const node of project.nodes || []) {
        if (node.type !== "drawing" || !node.metadata?.drawingId) continue;
        if (item.drawingDocuments && !drawingIds.has(node.metadata.drawingId)) {
            throw new Error(`画布「${title}」缺少画板 ${node.title || node.metadata.drawingId}`);
        }
    }
}

function preflightCanvasArchiveTimeline(timeline: NonNullable<CanvasProject["timeline"]>, title: string) {
    if (!timeline || typeof timeline !== "object" || !Array.isArray(timeline.clips) || !Array.isArray(timeline.tracks)) {
        throw new Error(`画布「${title}」的时间线无效`);
    }
}

export function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && isArchiveStorageKey(value.storageKey)) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}
