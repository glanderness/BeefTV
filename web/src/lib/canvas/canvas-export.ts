import { confinedArchivePath, createZip, readZip } from "@/lib/zip";
import { saveOwnedNativeArchiveFiles, saveOwnedOrBrowserBlob, type OwnedMediaSaveResult } from "@/services/desktop-media-save";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { CanvasExportAsset, CanvasExportFile, CanvasProjectExportItem } from "@/types/canvas-export";
import type { CanvasFolder, CanvasProject } from "@/stores/canvas/use-canvas-store";
import { loadCanvasDrawing, loadCanvasDrawingPreview, loadCanvasDrawingRender } from "@/lib/canvas/canvas-drawing-storage";
import type { CanvasDrawingExport } from "@/types/canvas-export";
import { normalizeLocalCanvasProject } from "@/lib/local-workspace-migration";
import { archiveFileExtension, assertUniqueArchiveNames, ExportIntegrityError, type MissingExportFile } from "@/lib/export-integrity";
import { http } from "@/services/api/request";
import { startOperation } from "@/stores/use-operation-progress";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { getResource, isResourceUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { isTrustedLocalOriginUrl } from "@/lib/desktop-shell";
import { extractOwnedResourceId } from "@/lib/canvas/canvas-resource-id";

export const ARCHIVE_STORAGE_KEY_PATTERN = /^(image|video|audio|file|resource|model|video-reference|audio-reference):/;
const ARCHIVE_RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export const ARCHIVE_PRIMARY_MEDIA_URL_KEYS = new Set([
    "content",
    "previewContent",
    "url",
    "dataUrl",
]);

export const ARCHIVE_BARE_RESOURCE_ID_KEYS = new Set([
    "resourceId",
    "sampleResourceId",
    "referenceResourceId",
]);

export const ARCHIVE_BARE_RESOURCE_ID_ARRAY_KEYS = new Set([
    "resourceIds",
    "referenceResourceIds",
]);

export const ARCHIVE_MEDIA_CONTAINER_KEYS = new Set([
    "imageHistory",
    "videoPreview",
    "directorScenes",
    "panorama",
    "screenshots",
    "panoramaConfig",
    "emotionEdit",
    "maskEdit",
    "mediaConversion",
]);

export function isArchiveStorageKey(value: string) {
    const key = value.trim();
    if (!key || key.startsWith("data:") || key.startsWith("blob:")) return false;
    return ARCHIVE_STORAGE_KEY_PATTERN.test(key);
}

export function isArchiveStorageKeyField(key: string) {
    return key === "storageKey" || key.endsWith("StorageKey");
}

export function isArchiveMediaUrlField(key: string) {
    return key === "content" || key === "previewContent" || key === "url" || key.endsWith("Url");
}

export function isArchiveMediaNodeType(type: unknown): boolean {
    return type === "image" || type === "video" || type === "audio";
}

export function validArchiveResourceId(value: string): string {
    const trimmed = value.trim();
    return ARCHIVE_RESOURCE_ID_PATTERN.test(trimmed) ? trimmed : "";
}

export function extractOwnedResourceIdFromArchiveUrl(
    value: string,
    options: { allowAnyOrigin?: boolean } = {},
): string {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("resource:")) return "";
    if (!options.allowAnyOrigin && !isResourceUrl(trimmed) && !isTrustedLocalOriginUrl(trimmed)) {
        return "";
    }
    return extractOwnedResourceId(undefined, trimmed);
}

export type CanvasExportProgress = { phase: "loading" | "media" | "drawings" | "packing" | "saving"; completed?: number; total?: number };

export function canvasExportProgressLabel(progress: CanvasExportProgress) {
    switch (progress.phase) {
        case "loading": return "正在读取画布…";
        case "media": return `正在读取文件 ${progress.completed ?? 0}/${progress.total ?? 0}…`;
        case "drawings": return "正在读取画板…";
        case "packing": return "正在打包…";
        case "saving": return "正在准备保存，请在弹窗中选择位置…";
    }
}

export async function exportCanvasProjects(projects: CanvasProject[], fileName = "画布", options: { includeLocalDrawings?: boolean; allowMissingMedia?: boolean; onSkippedFiles?: (missing: MissingExportFile[]) => void; folders?: CanvasFolder[]; signal?: AbortSignal; onProgress?: (progress: CanvasExportProgress) => void } = {}): Promise<OwnedMediaSaveResult> {
    if (projects.some((project) => project.summaryOnly)) {
        throw new Error("画布尚未完整加载，请先打开画布后再导出");
    }
    const operation = startOperation("导出画布", { detail: "正在读取画布与媒体文件", totalFiles: projects.reduce((sum, project) => sum + collectStorageKeys(project).length, 0) });
    const finish = (result: OwnedMediaSaveResult) => {
        if (result === "cancelled") operation.dismiss(); else operation.done("画布备份已保存");
        return result;
    };
    try {
    const recordedPhases = new Set<CanvasExportProgress["phase"]>();
    const check = () => { options.signal?.throwIfAborted(); };
    const step = <T,>(promise: Promise<T>) => awaitCanvasExportStep(promise, options.signal);
    const progress = (value: CanvasExportProgress) => {
        check();
        options.onProgress?.(value);
        operation.update({ phase: value.phase === "packing" || value.phase === "saving" ? "processing" : "preparing", detail: canvasExportProgressLabel(value) });
        if (value.phase === "media") operation.update({ completedFiles: value.completed, totalFiles: value.total });
        if (!recordedPhases.has(value.phase)) {
            recordedPhases.add(value.phase);
            recordDiagnosticEvent({ category: "action", level: "info", code: "canvas_export_" + value.phase, message: `画布导出 ${value.phase}`, canvasId: projects.length === 1 ? projects[0]?.id : undefined });
        }
    };
    let completed = 0;
    const total = projects.reduce((count, project) => count + collectStorageKeys(project).length, 0);
    progress({ phase: "media", completed, total });
    const canUseNativeArchive = typeof window !== "undefined" && typeof window.go?.main?.DesktopApp?.SaveOwnedArchive === "function";
    const zipFiles: { name: string; data: BlobPart; resourceId?: string }[] = [];
    const missingFiles: MissingExportFile[] = [];
    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            const missingStorageKeys = new Set<string>();
            const missingDrawingIds = new Set<string>();
            await runWithConcurrency(collectStorageKeys(project), 4, async (storageKey) => {
                const resourceId = resourceIdFromStorageKey(storageKey);
                if (canUseNativeArchive && resourceId) {
                    try {
                        const resource = await step(getResource(resourceId, { signal: options.signal }));
                        check();
                        if (!resource || resource.status !== "ready") {
                            missingStorageKeys.add(storageKey);
                            missingFiles.push({ owner: project.title || project.id, reference: storageKey });
                            return;
                        }
                        const mimeType = resource.mimeType || "application/octet-stream";
                        const path = `projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(storageKey)}.${archiveFileExtension(mimeType, resource.kind === "image" ? "png" : "bin")}`;
                        files.push({ storageKey, path, mimeType, bytes: resource.size || 0 });
                        zipFiles.push({ name: path, data: "", resourceId });
                    } catch {
                        check();
                        missingStorageKeys.add(storageKey);
                        missingFiles.push({ owner: project.title || project.id, reference: `${storageKey}（读取失败）` });
                    } finally {
                        if (!options.signal?.aborted) progress({ phase: "media", completed: ++completed, total });
                    }
                    return;
                }
                let blob: Blob | null | undefined;
                try {
                    blob = await step(storageKey.startsWith("image:") ? getImageBlob(storageKey) : getMediaBlob(storageKey));
                    check();
                } catch {
                    check();
                    missingStorageKeys.add(storageKey);
                    missingFiles.push({ owner: project.title || project.id, reference: `${storageKey}（读取失败）` });
                    return;
                } finally {
                    if (!options.signal?.aborted) progress({ phase: "media", completed: ++completed, total });
                }
                if (!blob || blob.size === 0) {
                    missingStorageKeys.add(storageKey);
                    missingFiles.push({ owner: project.title || project.id, reference: storageKey });
                    return;
                }
                const path = `projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(storageKey)}.${archiveFileExtension(blob.type, storageKey.startsWith("image:") ? "png" : "bin")}`;
                files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                zipFiles.push({ name: path, data: blob, resourceId: resourceId || undefined });
            });
            check();
            const drawingNodes = project.nodes.filter((node) => options.includeLocalDrawings !== false && node.type === "drawing" && node.metadata?.drawingId);
            if (drawingNodes.length) progress({ phase: "drawings" });
            const drawingDocuments = (await Promise.all(drawingNodes.map(async (node): Promise<CanvasDrawingExport | null> => {
                const drawingId = node.metadata?.drawingId;
                if (!drawingId) return null;
                let saved: Awaited<ReturnType<typeof loadCanvasDrawing>>;
                let preview: Awaited<ReturnType<typeof loadCanvasDrawingPreview>>;
                let render: Awaited<ReturnType<typeof loadCanvasDrawingRender>>;
                try {
                    [saved, preview, render] = await step(Promise.all([
                        loadCanvasDrawing(project.id, drawingId),
                        loadCanvasDrawingPreview(project.id, drawingId),
                        loadCanvasDrawingRender(project.id, drawingId),
                    ]));
                    check();
                } catch (error) {
                    check();
                    missingDrawingIds.add(drawingId);
                    missingFiles.push({ owner: project.title || project.id, reference: `画板 ${node.title || drawingId}（读取失败）` });
                    return null;
                }
                if (!saved) {
                    missingDrawingIds.add(drawingId);
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
            const normalizedProject = normalizeLocalCanvasProject(project);
            const exportedProject = options.allowMissingMedia && (missingStorageKeys.size > 0 || missingDrawingIds.size > 0)
                ? stripMissingArchiveReferences(normalizedProject, missingStorageKeys, missingDrawingIds)
                : normalizedProject;
            return {
                project: exportedProject,
                files,
                ...(options.includeLocalDrawings === false ? {} : { drawingDocuments }),
            };
        }),
    );

    const projectFolderIds = new Set(projects.map((project) => project.folderId).filter((id): id is string => Boolean(id)));
    const folders: CanvasExportFile["folders"] = [];
    for (const folder of options.folders?.filter((item) => projectFolderIds.has(item.id)) || []) {
        let cover: Blob | undefined;
        try {
            if (folder.coverResourceId) {
                const response = await http.raw<Blob>({ method: "GET", url: `/resources/${encodeURIComponent(folder.coverResourceId)}/file?proxy=1`, responseType: "blob", signal: options.signal });
                cover = response.data;
            } else if (folder.coverDataUrl) {
                const response = await fetch(folder.coverDataUrl, { signal: options.signal });
                if (!response.ok) throw new ExportIntegrityError([{ owner: folder.name, reference: "文件夹封面" }]);
                cover = await step(response.blob());
            }
            if (cover && !cover.size) throw new ExportIntegrityError([{ owner: folder.name, reference: "文件夹封面" }]);
        } catch (error) {
            check();
            if (!options.allowMissingMedia) throw error;
            missingFiles.push({ owner: folder.name, reference: "文件夹封面" });
            cover = undefined;
        }
        const coverPath = cover ? `folders/${encodeURIComponent(folder.id)}/cover.${archiveFileExtension(cover.type, "png")}` : undefined;
        if (cover && coverPath) zipFiles.push({ name: coverPath, data: cover, resourceId: folder.coverResourceId });
        folders.push({ ...folder, coverResourceId: undefined, coverDataUrl: undefined, coverPath, coverMimeType: cover?.type || undefined });
    }
    const exportedFolderIds = new Set(folders.map((folder) => folder.id));
    for (const item of exportedProjects) {
        if (item.project.folderId && !exportedFolderIds.has(item.project.folderId)) {
            item.project = { ...item.project, folderId: undefined };
        }
    }
    if (missingFiles.length) {
        if (!options.allowMissingMedia) throw new ExportIntegrityError(missingFiles);
        options.onSkippedFiles?.(missingFiles);
    }
    assertUniqueArchiveNames(["projects.json", ...zipFiles.map((file) => file.name)]);
    for (const item of exportedProjects) {
        const liveKeys = new Set(collectStorageKeys(item.project));
        for (const file of item.files) {
            if (!liveKeys.has(file.storageKey) || file.path === file.storageKey) {
                throw new Error("备份未完成：文件引用不一致，未生成备份。");
            }
        }
    }

    const data: CanvasExportFile = {
        app: "infinite-canvas",
        version: 4,
        exportedAt: new Date().toISOString(),
        ...(folders?.length ? { folders } : {}),
        ...(missingFiles.length ? { skippedFiles: missingFiles } : {}),
        projects: exportedProjects,
    };
    progress({ phase: "packing" });
    const archiveFiles = [{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles];
    const saved = await saveOwnedNativeArchiveFiles(`${safeFileName(fileName)}.zip`, archiveFiles, { signal: options.signal, onSaving: () => progress({ phase: "saving" }) });
    if (saved !== undefined) return finish(saved);
    const zip = await step(createZip(archiveFiles));
    check();
    progress({ phase: "saving" });
    return finish(await saveOwnedOrBrowserBlob(`${safeFileName(fileName)}.zip`, zip));
    } catch (error) {
        if (options.signal?.aborted) operation.dismiss(); else operation.fail("画布导出未完成，请查看错误后重试");
        throw error;
    }
}

// A cache/IndexedDB read may never settle. Cancellation stops this export;
// shared cache reads can finish independently but can no longer save a file.
export function awaitCanvasExportStep<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason); };
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
    });
}

export async function exportCanvasProjectsByIds(
    canvasIds: readonly string[],
    loadProject: (id: string) => Promise<CanvasProject | null | undefined> | CanvasProject | null | undefined,
    options: {
        archiveTitle?: string;
        singleCanvasOnly?: boolean;
        folders?: CanvasFolder[];
        allowMissingMedia?: boolean;
        onSkipped?: (count: number, missing: MissingExportFile[]) => void;
        signal?: AbortSignal;
        onProgress?: (progress: CanvasExportProgress) => void;
    } = {},
): Promise<OwnedMediaSaveResult> {
    if (!canvasIds.length) throw new Error("画布不存在，无法导出");
    const loaded: CanvasProject[] = [];
    for (const id of canvasIds) {
        const project = await awaitCanvasExportStep(Promise.resolve(loadProject(id)), options.signal);
        options.signal?.throwIfAborted();
        if (!project) throw new Error("画布不存在，无法导出");
        loaded.push(project);
    }
    let skippedFiles: MissingExportFile[] = [];
    const baseTitle = loaded[0]?.title || "画布";
    const fileName = options.archiveTitle || (options.singleCanvasOnly ? `${baseTitle}-画布备份` : `${baseTitle}-${loaded.length}个画布`);
    const result = await exportCanvasProjects(loaded, fileName, {
        folders: options.folders,
        allowMissingMedia: options.allowMissingMedia ?? false,
        onSkippedFiles: (missing) => { skippedFiles = missing; },
        signal: options.signal,
        onProgress: options.onProgress,
    });
    if (result !== "cancelled" && skippedFiles.length > 0) {
        options.onSkipped?.(skippedFiles.length, skippedFiles);
    }
    return result;
}

export type OpenCanvasArchive = {
    data: CanvasExportFile;
    files: Map<string, Blob>;
    missingFiles?: MissingExportFile[];
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
    const missingFiles = preflightCanvasArchive(data, zip);
    return { data, files: zip, ...(missingFiles.length ? { missingFiles } : {}) };
}

export function preflightCanvasArchive(data: CanvasExportFile, zip: Map<string, Blob>): MissingExportFile[] {
    if (!data || data.app !== "infinite-canvas") throw new Error("不是有效的画布备份");
    if (data.version !== 3 && data.version !== 4) throw new Error("不支持的画布备份版本");
    if (!Array.isArray(data.projects)) throw new Error("projects.json 中缺少画布列表");
    if (data.folders !== undefined && !Array.isArray(data.folders)) throw new Error("备份中的文件夹列表无效");
    const folderIds = new Set<string>();
    const archivePaths = new Set<string>(["projects.json"]);
    const missingFiles: MissingExportFile[] = [];
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
            if (!blob?.size) {
                missingFiles.push({ owner: folder.name || folder.id, reference: folder.coverPath });
            }
        }
    }
    const projectIds = new Set<string>();
    for (const item of data.projects) {
        preflightCanvasArchiveProject(item, zip, projectIds, folderIds, archivePaths, missingFiles);
    }
    return missingFiles;
}

function preflightCanvasArchiveProject(
    item: CanvasProjectExportItem,
    zip: Map<string, Blob>,
    projectIds: Set<string>,
    folderIds: Set<string>,
    archivePaths: Set<string>,
    missingFiles: MissingExportFile[],
) {
    if (!item || !item.project || typeof item.project !== "object") throw new Error("备份中的画布无效");
    const project = item.project;
    const title = typeof project.title === "string" && project.title.trim() ? project.title : "未命名画布";
    if (typeof project.id !== "string" || !project.id.trim()) throw new Error(`画布「${title}」缺少编号`);
    if (projectIds.has(project.id)) throw new Error(`备份中存在重复的画布：${title}`);
    projectIds.add(project.id);
    if (project.folderId && !folderIds.has(project.folderId)) {
        missingFiles.push({ owner: title, reference: `文件夹 ${project.folderId}` });
    }
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
        if (!blob || blob.size === 0) {
            missingFiles.push({ owner: title, reference: fileItem.path || fileItem.storageKey });
        }
    }
    const liveKeys = collectStorageKeys(project);
    for (const storageKey of liveKeys) {
        if (!fileKeys.has(storageKey)) {
            missingFiles.push({ owner: title, reference: storageKey });
        }
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
            if (!zip.get(path) && !zip.get(document.previewPath)) {
                missingFiles.push({ owner: title, reference: document.previewPath });
            }
        }
        if (document.generationRender?.path) {
            const path = confinedArchivePath(document.generationRender.path);
            if (archivePaths.has(path)) throw new Error(`压缩包存在重名文件：${path}`);
            archivePaths.add(path);
            if (!zip.get(path) && !zip.get(document.generationRender.path)) {
                missingFiles.push({ owner: title, reference: document.generationRender.path });
            }
        }
    }
    for (const node of project.nodes || []) {
        if (node.type !== "drawing" || !node.metadata?.drawingId) continue;
        if (item.drawingDocuments && !drawingIds.has(node.metadata.drawingId)) {
            missingFiles.push({ owner: title, reference: `画板 ${node.title || node.metadata.drawingId}` });
        }
    }
}

function preflightCanvasArchiveTimeline(timeline: NonNullable<CanvasProject["timeline"]>, title: string) {
    if (!timeline || typeof timeline !== "object" || !Array.isArray(timeline.clips) || !Array.isArray(timeline.tracks)) {
        throw new Error(`画布「${title}」的时间线无效`);
    }
}

export type ArchiveMediaTreeHooks = {
    shouldOmitKey?: (key: string, value: unknown) => boolean;
    onStorageKey: (key: string, storageKey: string) => string | undefined;
    onResourceId: (key: string, resourceId: string) => string | undefined;
    onMediaUrl: (input: {
        key: string;
        value: string;
        record: Record<string, unknown>;
        inMediaContext: boolean;
    }) => string;
    finalizeObject?: (next: Record<string, unknown>, source: Record<string, unknown>, inMediaContext: boolean) => void;
};

export function transformArchiveMediaTree<T>(
    value: T,
    hooks: ArchiveMediaTreeHooks,
    inMediaContext = false,
): T {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        return value.map((item) => transformArchiveMediaTree(item, hooks, inMediaContext)) as T;
    }
    const record = value as Record<string, unknown>;
    let objectMediaContext = inMediaContext;
    if (typeof record.type === "string" && typeof record.id === "string" && "metadata" in record) {
        objectMediaContext = isArchiveMediaNodeType(record.type);
    } else if (record.kind === "text") {
        objectMediaContext = false;
    }
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
        if (hooks.shouldOmitKey?.(key, child)) {
            continue;
        }
        if (typeof child === "string") {
            if (isArchiveStorageKeyField(key)) {
                if (isArchiveStorageKey(child)) {
                    const transformed = hooks.onStorageKey(key, child);
                    if (transformed !== undefined && transformed !== "") next[key] = transformed;
                } else {
                    next[key] = child;
                }
                continue;
            }
            if (ARCHIVE_BARE_RESOURCE_ID_KEYS.has(key)) {
                const validId = validArchiveResourceId(child);
                if (validId) {
                    const transformed = hooks.onResourceId(key, validId);
                    if (transformed !== undefined && transformed !== "") next[key] = transformed;
                } else {
                    next[key] = child;
                }
                continue;
            }
            if (isArchiveMediaUrlField(key) && (key !== "content" || objectMediaContext)) {
                next[key] = hooks.onMediaUrl({ key, value: child, record, inMediaContext: objectMediaContext });
                continue;
            }
            next[key] = child;
            continue;
        }
        if (key === "referenceUrls" && Array.isArray(child)) {
            next.referenceUrls = child
                .map((entry) => (typeof entry === "string"
                    ? hooks.onMediaUrl({ key: "referenceUrl", value: entry, record, inMediaContext: true })
                    : entry))
                .filter((entry) => entry !== "");
            continue;
        }
        if (ARCHIVE_BARE_RESOURCE_ID_ARRAY_KEYS.has(key) && Array.isArray(child)) {
            const nextIds: unknown[] = [];
            for (const entry of child) {
                if (typeof entry !== "string") {
                    nextIds.push(entry);
                    continue;
                }
                const validId = validArchiveResourceId(entry);
                if (!validId) {
                    nextIds.push(entry);
                    continue;
                }
                const transformed = hooks.onResourceId(key, validId);
                if (transformed !== undefined && transformed !== "") nextIds.push(transformed);
            }
            next[key] = nextIds;
            continue;
        }
        let childMediaContext = objectMediaContext;
        if (ARCHIVE_MEDIA_CONTAINER_KEYS.has(key)) {
            childMediaContext = true;
        } else if (key === "directMedia") {
            childMediaContext = Boolean(child && typeof child === "object" && (child as Record<string, unknown>).kind !== "text");
        }
        next[key] = transformArchiveMediaTree(child, hooks, childMediaContext);
    }
    hooks.finalizeObject?.(next, record, objectMediaContext);
    return next as T;
}

export function collectStorageKeys(
    value: unknown,
    keys = new Set<string>(),
    inMediaContext = false,
    options: { allowAnyOrigin?: boolean } = {},
): string[] {
    transformArchiveMediaTree(
        value,
        {
            onStorageKey: (_key, storageKey) => {
                keys.add(storageKey);
                return storageKey;
            },
            onResourceId: (_key, resourceId) => {
                keys.add(`resource:${resourceId}`);
                return resourceId;
            },
            onMediaUrl: ({ value: url }) => {
                const resourceId = extractOwnedResourceIdFromArchiveUrl(url, options);
                if (resourceId) keys.add(`resource:${resourceId}`);
                return url;
            },
        },
        inMediaContext,
    );
    return [...keys];
}

function stripMissingArchiveReferences<T>(
    value: T,
    missingStorageKeys: ReadonlySet<string>,
    missingDrawingIds: ReadonlySet<string>,
    inMediaContext = false,
): T {
    return transformArchiveMediaTree(
        value,
        {
            shouldOmitKey: (key, child) => key === "drawingId" && typeof child === "string" && missingDrawingIds.has(child),
            onStorageKey: (_key, storageKey) => (missingStorageKeys.has(storageKey) ? undefined : storageKey),
            onResourceId: (_key, resourceId) => (missingStorageKeys.has(`resource:${resourceId}`) ? undefined : resourceId),
            onMediaUrl: ({ value: url }) => {
                const refId = extractOwnedResourceIdFromArchiveUrl(url);
                return refId && missingStorageKeys.has(`resource:${refId}`) ? "" : url;
            },
            finalizeObject: (next) => {
                if (Array.isArray(next.imageHistory)) {
                    const liveHistory = next.imageHistory.filter((entry) => {
                        if (!entry || typeof entry !== "object") return false;
                        const item = entry as Record<string, unknown>;
                        const hasStorageKey = typeof item.storageKey === "string" && item.storageKey.trim() !== "";
                        const hasContent = typeof item.content === "string" && item.content.trim() !== "";
                        const hasResourceId = typeof item.resourceId === "string" && item.resourceId.trim() !== "";
                        return hasStorageKey || hasContent || hasResourceId;
                    });
                    if (liveHistory.length > 0) {
                        next.imageHistory = liveHistory;
                    } else {
                        delete next.imageHistory;
                    }
                }
            },
        },
        inMediaContext,
    );
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

async function runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>) {
    let index = 0;
    const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        while (index < items.length) {
            const current = index++;
            await worker(items[current]);
        }
    });
    await Promise.all(runners);
}
