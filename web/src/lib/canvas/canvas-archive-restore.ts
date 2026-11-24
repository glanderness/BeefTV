import { createClientId } from "@/lib/client-id";
import { getActiveUserScope } from "@/lib/user-scope";
import { confinedArchivePath } from "@/lib/zip";
import { canonicalize } from "json-canonicalize";
import { startOperation } from "@/stores/use-operation-progress";
import { isLocalRuntimeMode } from "@/lib/runtime-mode";
import {
    ARCHIVE_PRIMARY_MEDIA_URL_KEYS,
    collectStorageKeys,
    extractOwnedResourceIdFromArchiveUrl,
    isArchiveStorageKey,
    openCanvasArchive,
    preflightCanvasArchive,
    transformArchiveMediaTree,
    type OpenCanvasArchive,
} from "@/lib/canvas/canvas-export";
import { uniqueMissingExportFiles, type MissingExportFile } from "@/lib/export-integrity";
import { createCanvasLibraryFolder, deleteCanvasLibraryFolder, persistCanvasFolderCover } from "@/lib/canvas/canvas-folder-storage";
import { loadCanvasDrawing, saveCanvasDrawing, type CanvasDrawingRenderDraft } from "@/lib/canvas/canvas-drawing-storage";
import { canvasWorkspaceProjectId } from "@/lib/canvas/canvas-workspace-project";
import { normalizeLocalCanvasProject } from "@/lib/local-workspace-migration";
import { http } from "@/services/api/request";
import { resourceFileUrl, resourceIdFromStorageKey, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { primeResourceBlobCache } from "@/services/resource-blob-cache";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { deleteWorkspaceAsset } from "@/services/workspace-asset-repository";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasDrawingExport, CanvasExportAsset } from "@/types/canvas-export";
import type { TimelineProject } from "@/types/timeline";

export type RestoredMediaRef = {
    storageKey: string;
    url: string;
    resourceId?: string;
};

export type CanvasArchiveProjectProgress = {
    projectId: string;
    total: number;
    completed: number;
    phase: "uploading" | "saving" | "error";
    message: string;
};

export type CanvasArchiveRestoreHost = {
    usesCanonicalBackend: boolean;
    createFolder(name: string): string | Promise<string>;
    deleteFolder(id: string): void | Promise<void>;
    restoreFolderCover?(id: string, cover: Blob): Promise<void>;
    importProject(project: Partial<CanvasProject>, workspaceProjectId?: string): string;
    updateProject(id: string, patch: Partial<CanvasProject>): void;
    persistProject(id: string): Promise<void>;
    deleteProjects(ids: readonly string[]): Promise<void>;
    discardProjects(ids: readonly string[]): void;
    uploadMedia(blob: Blob, kind: "image" | "video" | "audio" | "file", meta: { storageKey: string; mimeType: string; fileName?: string }): Promise<RestoredMediaRef>;
    bindMediaAsset?(options: { canvasId: string; node: CanvasNodeData }): Promise<string>;
    saveDrawing: typeof saveCanvasDrawing;
    loadDrawing?(projectId: string, drawingId: string): Promise<{ drawingId: string; revision: number; snapshot?: unknown; previewResourceId?: string; renderResourceId?: string } | null>;
    deleteResource?(resourceId: string): Promise<void>;
    onProjectProgress?(projectId: string, progress: CanvasArchiveProjectProgress | null): void;
};

export type CanvasArchiveRestoreResult = {
    count: number;
    projectIds: string[];
    folderIds: string[];
    resourceIds: string[];
    storage: "browser" | "backend";
    skippedFiles?: MissingExportFile[];
};

export async function archiveContentDigest(blob: Blob): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function archiveMediaIdempotencyKey(blob: Blob): Promise<string> {
    return `canvas-archive:sha256:${await archiveContentDigest(blob)}`;
}

function isMediaNode(type: CanvasNodeData["type"]) {
    return type === CanvasNodeType.Image || type === CanvasNodeType.Video || type === CanvasNodeType.Audio;
}

export function createCanvasArchiveRestoreHost(overrides: Partial<CanvasArchiveRestoreHost> = {}): CanvasArchiveRestoreHost {
    const store = () => useCanvasStore.getState();
    const usesCanonicalBackend = overrides.usesCanonicalBackend ?? !usesBrowserLocalResourceStore();
    const createdAssets = new Set<string>();
    return {
        createFolder: (name) => createCanvasLibraryFolder(name),
        deleteFolder: (id) => deleteCanvasLibraryFolder(id),
        restoreFolderCover: async (id, cover) => {
            const bytes = new Uint8Array(await cover.arrayBuffer());
            let binary = "";
            for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
            await persistCanvasFolderCover(id, `data:${cover.type || "image/png"};base64,${btoa(binary)}`);
        },
        importProject: (project, workspaceProjectId) => store().importProject(project, workspaceProjectId),
        updateProject: (id, patch) => store().updateProject(id, patch),
        persistProject: async (id) => {
            const live = store().openProject(id);
            if (!live) throw new Error("画布未保存到工作区");
            if (!usesCanonicalBackend) {
                await flushCanvasStorePersistence();
                const cached = store().openProject(id);
                if (!cached?.id || cached.id !== id) throw new Error("画布未保存到工作区");
                return;
            }
            await syncLocalCanvasProjectToBackend(id);
            const saved = store().openProject(id);
            if (!saved?.id || saved.id !== id || (saved.revision ?? 0) < 1) {
                throw new Error("画布未保存到工作区");
            }
        },
        deleteProjects: async (ids) => {
            const unique = [...new Set(ids.filter(Boolean))];
            if (usesCanonicalBackend) {
                await Promise.all(unique.map(async (id) => {
                    await http.delete(`/canvas-projects/${encodeURIComponent(id)}`);
                }));
            }
            store().deleteProjects(unique);
            for (const assetId of createdAssets) {
                await deleteWorkspaceAsset(assetId);
                createdAssets.delete(assetId);
            }
        },
        discardProjects: (ids) => store().deleteProjects([...ids]),
        uploadMedia: async (blob, kind, meta) => {
            if (!usesCanonicalBackend) {
                const storageKey = `${kind}:${getActiveUserScope()}:${createClientId()}`;
                const url = await (kind === "image" ? setImageBlob(storageKey, blob) : setMediaBlob(storageKey, blob));
                return { storageKey, url: url || "" };
            }
            const resource = await uploadResourceFile(blob, kind, { fileName: meta.fileName, idempotencyKey: await archiveMediaIdempotencyKey(blob) });
            const storageKey = resourceStorageKey(resource.id);
            await primeResourceBlobCache(storageKey, blob).catch(() => undefined);
            return { storageKey, url: resource.publicUrl || resourceFileUrl(resource.id), resourceId: resource.id };
        },
        bindMediaAsset: async (options) => {
            const result = await ensureCanvasNodeAsset({ ...options, source: "canvas-upload" });
            if (result.created) createdAssets.add(result.assetId);
            if (!result.confirmed) throw new Error("素材文件尚未保存到工作区，导入未完成");
            return result.assetId;
        },
        saveDrawing: (projectId, drawingId, engine, snapshot, previous, preview, render) =>
            saveCanvasDrawing(projectId, drawingId, engine, snapshot, previous, preview, render),
        loadDrawing: async (projectId, drawingId) => {
            const saved = await loadCanvasDrawing(projectId, drawingId);
            if (usesCanonicalBackend && saved && saved.origin !== "canonical") {
                throw new Error("画板尚未保存到工作区，导入未完成");
            }
            return saved ? { drawingId, revision: saved.revision, snapshot: saved.snapshot, previewResourceId: saved.previewResourceId, renderResourceId: saved.renderResourceId } : null;
        },
        ...overrides,
        usesCanonicalBackend,
    };
}

export async function restoreCanvasArchive(input: Blob | OpenCanvasArchive, host: Partial<CanvasArchiveRestoreHost> = {}): Promise<CanvasArchiveRestoreResult> {
    const progress = startOperation("导入画布备份", { detail: "正在解压并检查备份", totalBytes: input instanceof Blob ? input.size : undefined });
    try {
        const result = await restoreCanvasArchiveContents(input, host, (completedFiles, totalFiles) => progress.update({ phase: "processing", detail: "正在恢复媒体并保存画布", completedFiles, totalFiles }));
        progress.done(result.skippedFiles?.length ? `画布已导入，跳过 ${result.skippedFiles.length} 个缺失媒体` : "画布与媒体已恢复并保存");
        return result;
    } catch (error) {
        const detail = error instanceof Error ? error.message.trim() : "";
        progress.fail(detail ? `画布导入未完成：${detail}` : "画布导入未完成，请查看错误后重试");
        throw error;
    }
}

async function restoreCanvasArchiveContents(input: Blob | OpenCanvasArchive, host: Partial<CanvasArchiveRestoreHost>, onProgress: (completed: number, total: number) => void): Promise<CanvasArchiveRestoreResult> {
    const localPersistence = isLocalRuntimeMode();
    const fromBlob = !("data" in input && "files" in input);
    const archive = fromBlob ? await openCanvasArchive(input) : input;
    const skippedFiles: MissingExportFile[] = [...(fromBlob ? (archive.missingFiles ?? []) : preflightCanvasArchive(archive.data, archive.files))];
    const projectPlans = archive.data.projects.map((item) => {
        const liveKeys = new Set(collectStorageKeys(item.project, new Set(), false, { allowAnyOrigin: true }));
        return { item, activeFiles: item.files.filter((fileItem) => liveKeys.has(fileItem.storageKey)) };
    });
    const totalMedia = projectPlans.reduce((total, plan) => total + plan.activeFiles.length, 0);
    let restoredMedia = 0;
    onProgress(0, totalMedia);
    const restoreHost = createCanvasArchiveRestoreHost(host);
    const folderIds: string[] = [];
    const projectIds: string[] = [];
    const resourceIds: string[] = [];
    const progressProjectIds = new Set<string>();
    const reportProgress = (id: string, progress: CanvasArchiveProjectProgress | null) => {
        if (progress) progressProjectIds.add(id);
        else progressProjectIds.delete(id);
        restoreHost.onProjectProgress?.(id, progress);
    };
    const folderIdMap = new Map<string, string>();
    const importedWorkspaceProjectIds = new Map<string, string>();
    try {
        for (const folder of archive.data.folders || []) {
            const id = await restoreHost.createFolder(folder.name);
            folderIds.push(id);
            folderIdMap.set(folder.id, id);
            if (folder.coverPath && restoreHost.restoreFolderCover) {
                const cover = archive.files.get(confinedArchivePath(folder.coverPath));
                if (!cover || cover.size === 0) {
                    skippedFiles.push({ owner: folder.name || folder.id, reference: folder.coverPath });
                } else {
                    await restoreHost.restoreFolderCover(id, cover.slice(0, cover.size, folder.coverMimeType || cover.type || "image/png"));
                }
            } else if (folder.coverDataUrl?.startsWith("data:image/") && restoreHost.restoreFolderCover) {
                const response = await fetch(folder.coverDataUrl);
                await restoreHost.restoreFolderCover(id, await response.blob());
            }
        }
        for (const { item, activeFiles } of projectPlans) {
            const archiveProjectId = item.project.id;
            const projectTitle = item.project.title || "导入画布";
            reportProgress(archiveProjectId, {
                projectId: archiveProjectId,
                total: activeFiles.length,
                completed: 0,
                phase: localPersistence ? "saving" : "uploading",
                message: localPersistence ? "正在保存本地媒体" : "正在上传媒体",
            });
            const { storageKeyMap, missingReferences: uploadMissing, missingStorageKeys } = await restoreArchiveMedia(
                activeFiles,
                archive.files,
                restoreHost,
                resourceIds,
                (completed) => {
                    onProgress(restoredMedia + completed, totalMedia);
                    reportProgress(archiveProjectId, {
                        projectId: archiveProjectId,
                        total: activeFiles.length,
                        completed,
                        phase: localPersistence ? "saving" : "uploading",
                        message: localPersistence ? "正在保存本地媒体" : "正在上传媒体",
                    });
                },
            );
            for (const reference of uploadMissing) {
                skippedFiles.push({ owner: projectTitle, reference });
            }
            restoredMedia += activeFiles.length;
            const normalized = normalizeLocalCanvasProject(item.project);
            const { project: remappedProject, missingReferences: remapMissing } = remapArchiveProjectMedia(
                normalized,
                storageKeyMap,
                item.drawingDocuments || [],
                missingStorageKeys,
            );
            for (const reference of remapMissing) {
                skippedFiles.push({ owner: projectTitle, reference });
            }
            const remappedNodes = remappedProject.nodes || [];
            const remappedTimeline = remappedProject.timeline;
            const sourceWorkspaceProjectId = canvasWorkspaceProjectId(item.project);
            const importedProjectId = restoreHost.importProject({
                ...remappedProject,
                projectId: undefined,
                folderId: item.project.folderId ? folderIdMap.get(item.project.folderId) : undefined,
                title: projectTitle,
            }, importedWorkspaceProjectIds.get(sourceWorkspaceProjectId));
            projectIds.push(importedProjectId);
            if (!importedWorkspaceProjectIds.has(sourceWorkspaceProjectId)) importedWorkspaceProjectIds.set(sourceWorkspaceProjectId, importedProjectId);
            reportProgress(archiveProjectId, null);
            reportProgress(importedProjectId, {
                projectId: importedProjectId,
                total: activeFiles.length,
                completed: activeFiles.length,
                phase: "saving",
                message: localPersistence ? "正在保存本地画布" : "正在保存画布",
            });
            const bound = await bindRestoredMedia(importedProjectId, remappedNodes, remappedTimeline, restoreHost);
            restoreHost.updateProject(importedProjectId, bound.timeline ? { nodes: bound.nodes, timeline: bound.timeline } : { nodes: bound.nodes });
            try {
                await restoreHost.persistProject(importedProjectId);
                await restoreArchiveDrawings(importedProjectId, item.drawingDocuments || [], archive.files, restoreHost);
                await verifyRestoredDrawings(importedProjectId, item.drawingDocuments || [], archive.files, restoreHost);
            } catch (error) {
                reportProgress(importedProjectId, {
                    projectId: importedProjectId,
                    total: activeFiles.length,
                    completed: activeFiles.length,
                    phase: "error",
                    message: error instanceof Error ? error.message : "画布导入未完成",
                });
                throw error;
            } finally {
                reportProgress(importedProjectId, null);
            }
        }
        const uniqueSkipped = uniqueMissingExportFiles(skippedFiles);
        return {
            count: archive.data.projects.length,
            projectIds,
            folderIds,
            resourceIds,
            storage: restoreHost.usesCanonicalBackend ? "backend" : "browser",
            ...(uniqueSkipped.length ? { skippedFiles: uniqueSkipped } : {}),
        };
    } catch (error) {
        try {
            await cleanupCanvasArchiveAttempt(restoreHost, { folderIds, projectIds, resourceIds });
        } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], `${error instanceof Error ? error.message : "导入未完成"}；部分导入内容未能清理，请检查工作区后重试`);
        }
        throw error;
    } finally {
        // Media upload and asset binding can fail before persistProject's
        // finally block. Their progress must not keep blocking exit/update.
        for (const id of progressProjectIds) restoreHost.onProjectProgress?.(id, null);
    }
}

async function verifyRestoredDrawings(
    projectId: string,
    documents: CanvasDrawingExport[],
    zip: Map<string, Blob>,
    host: CanvasArchiveRestoreHost,
) {
    if (!host.loadDrawing) return;
    for (const document of documents.filter((item) => !item.engine || item.engine === "excalidraw")) {
        const saved = await host.loadDrawing(projectId, document.drawingId);
        if (!saved || saved.drawingId !== document.drawingId || (saved.revision || 0) < 1) throw new Error("画板未保存到工作区");
        if (canonicalize(saved.snapshot) !== canonicalize(document.snapshot)) throw new Error("画板未保存到工作区");
        const hasPreviewBlob = Boolean(
            document.previewPath && (zip.get(document.previewPath) || zip.get(confinedArchivePath(document.previewPath))),
        );
        const hasRenderBlob = Boolean(
            document.generationRender?.path
            && (zip.get(document.generationRender.path) || zip.get(confinedArchivePath(document.generationRender.path))),
        );
        if (host.usesCanonicalBackend && hasPreviewBlob && !saved.previewResourceId) throw new Error("画板预览未保存到工作区");
        if (host.usesCanonicalBackend && hasRenderBlob && !saved.renderResourceId) throw new Error("画板生成图未保存到工作区");
    }
}

async function restoreArchiveMedia(
    files: CanvasExportAsset[],
    zip: Map<string, Blob>,
    host: CanvasArchiveRestoreHost,
    resourceIds: string[],
    onProgress?: (completed: number) => void,
) {
    const storageKeyMap = new Map<string, RestoredMediaRef>();
    const missingReferences: string[] = [];
    const missingStorageKeys = new Set<string>();
    const concurrency = 4;
    let fileIndex = 0;
    let completed = 0;
    let halt = false;
    let firstError: unknown;
    const workers = new Array(Math.min(files.length, concurrency) || 0).fill(null).map(async () => {
        while (!halt) {
            const current = fileIndex++;
            if (current >= files.length) return;
            const fileItem = files[current];
            try {
                const blob = zip.get(fileItem.path) || zip.get(confinedArchivePath(fileItem.path));
                if (!blob || blob.size === 0) {
                    missingStorageKeys.add(fileItem.storageKey);
                    missingReferences.push(fileItem.path || fileItem.storageKey);
                    completed += 1;
                    onProgress?.(completed);
                    continue;
                }
                const mime = fileItem.mimeType || blob.type || "application/octet-stream";
                const typedBlob = blob.type ? blob : blob.slice(0, blob.size, mime);
                const mapped = await host.uploadMedia(typedBlob, mediaKind(fileItem.storageKey, mime), {
                    storageKey: fileItem.storageKey,
                    mimeType: mime,
                    fileName: fileItem.path.split("/").pop(),
                });
                if (mapped.resourceId) resourceIds.push(mapped.resourceId);
                storageKeyMap.set(fileItem.storageKey, mapped);
                completed += 1;
                onProgress?.(completed);
            } catch (error) {
                halt = true;
                const fileName = fileItem.path.split("/").pop() || fileItem.path || fileItem.storageKey;
                const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "";
                firstError ??= detail && detail.includes(fileName)
                    ? error
                    : new Error(detail ? `文件「${fileName}」恢复失败：${detail}` : `文件「${fileName}」恢复失败`);
            }
        }
    });
    await Promise.all(workers);
    if (firstError) throw firstError;
    return { storageKeyMap, missingReferences, missingStorageKeys };
}

async function bindRestoredMedia(
    projectId: string,
    nodes: CanvasNodeData[],
    timeline: TimelineProject | undefined,
    host: CanvasArchiveRestoreHost,
) {
    if (!host.bindMediaAsset) return { nodes, timeline };
    const assetIdByStorageKey = new Map<string, string>();
    const nextNodes: CanvasNodeData[] = [];
    for (const node of nodes) {
        const isMedia = isMediaNode(node.type);
        if (!isMedia || !node.metadata?.storageKey) {
            nextNodes.push(node);
            continue;
        }
        const storageKey = node.metadata.storageKey;
        let assetId = assetIdByStorageKey.get(storageKey);
        if (!assetId) {
            assetId = await host.bindMediaAsset({ canvasId: projectId, node: { ...node, metadata: { ...node.metadata, assetId: undefined } } });
            if (assetId) assetIdByStorageKey.set(storageKey, assetId);
        }
        nextNodes.push(assetId ? { ...node, metadata: { ...node.metadata, assetId } } : node);
    }
    // Reuse already-bound local assetIds on matching imageHistory entries without
    // creating extra Asset Library rows for historical-only images.
    const nodesWithAlignedHistory = nextNodes.map((node) => {
        if (node.type !== CanvasNodeType.Image || !node.metadata?.imageHistory?.length) return node;
        let changed = false;
        const nextHistory = node.metadata.imageHistory.map((entry) => {
            const matchedAssetId = entry.storageKey ? assetIdByStorageKey.get(entry.storageKey) : undefined;
            if (!matchedAssetId || entry.assetId === matchedAssetId) return entry;
            changed = true;
            return { ...entry, assetId: matchedAssetId };
        });
        return changed ? { ...node, metadata: { ...node.metadata, imageHistory: nextHistory } } : node;
    });
    if (!timeline) return { nodes: nodesWithAlignedHistory, timeline };
    const clips: TimelineProject["clips"] = [];
    for (const clip of timeline.clips) {
        const media = clip.directMedia;
        if (!media || !media.storageKey || media.kind === "text") {
            clips.push(clip);
            continue;
        }
        const content = media.url || media.dataUrl || media.content || "";
        let assetId = assetIdByStorageKey.get(media.storageKey);
        if (!assetId) {
            const type = media.kind === "audio" ? CanvasNodeType.Audio : media.kind === "video" ? CanvasNodeType.Video : CanvasNodeType.Image;
            const node: CanvasNodeData = {
                id: media.id,
                type,
                title: media.title,
                position: { x: 0, y: 0 },
                width: media.width || 320,
                height: media.height || (type === CanvasNodeType.Audio ? 120 : 240),
                metadata: {
                    content,
                    storageKey: media.storageKey,
                    naturalWidth: media.width,
                    naturalHeight: media.height,
                    durationMs: media.durationMs,
                    bytes: media.bytes,
                    mimeType: media.mimeType,
                },
            };
            assetId = await host.bindMediaAsset({ canvasId: projectId, node });
            if (assetId) assetIdByStorageKey.set(media.storageKey, assetId);
        }
        clips.push(assetId ? { ...clip, directMedia: { ...media, assetId } } : clip);
    }
    return { nodes: nodesWithAlignedHistory, timeline: { ...timeline, clips } };
}

function mediaKind(storageKey: string, mime: string): "image" | "video" | "audio" | "file" {
    if (mime.startsWith("image/") || storageKey.startsWith("image:")) return "image";
    if (mime.startsWith("video/") || storageKey.startsWith("video:")) return "video";
    if (mime.startsWith("audio/") || storageKey.startsWith("audio:")) return "audio";
    return "file";
}

export function remapArchiveProjectMedia(
    project: CanvasProject,
    storageKeyMap: Map<string, RestoredMediaRef>,
    drawingDocuments: CanvasDrawingExport[] = [],
    knownMissingKeys: ReadonlySet<string> = new Set(),
): { project: CanvasProject; missingReferences: string[] } {
    const resourceIdMap = new Map<string, RestoredMediaRef>();
    for (const [oldKey, mapped] of storageKeyMap.entries()) {
        const oldId = resourceIdFromStorageKey(oldKey);
        if (oldId) resourceIdMap.set(oldId, mapped);
    }
    const missingReferences = new Set<string>();
    const recordMissing = (missingKey: string) => {
        if (!knownMissingKeys.has(missingKey)) {
            missingReferences.add(missingKey);
        }
    };
    const remapped = transformArchiveMediaTree(project, {
        shouldOmitKey: (key) => key === "assetId" || key === "taskId",
        onStorageKey: (_key, storageKey) => {
            const mapped = storageKeyMap.get(storageKey);
            if (mapped) return mapped.storageKey;
            recordMissing(storageKey);
            return undefined;
        },
        onResourceId: (_key, resourceId) => {
            const mapped = resourceIdMap.get(resourceId);
            if (mapped) return mapped.resourceId || resourceIdFromStorageKey(mapped.storageKey) || undefined;
            recordMissing(`resource:${resourceId}`);
            return undefined;
        },
        onMediaUrl: ({ key, value, record, inMediaContext }) => {
            const ownedId = extractOwnedResourceIdFromArchiveUrl(value);
            if (ownedId) {
                const mapped = resourceIdMap.get(ownedId);
                if (mapped) return mapped.url;
                recordMissing(`resource:${ownedId}`);
                return "";
            }
            const packagedId = extractOwnedResourceIdFromArchiveUrl(value, { allowAnyOrigin: true });
            if (packagedId && resourceIdMap.has(packagedId)) {
                return resourceIdMap.get(packagedId)!.url;
            }
            const pairedKeyName = key.endsWith("Url") && key !== "dataUrl" ? `${key.slice(0, -3)}StorageKey` : undefined;
            const pairedRaw = pairedKeyName && typeof record[pairedKeyName] === "string" ? (record[pairedKeyName] as string) : undefined;
            const pairedMapped = pairedRaw ? storageKeyMap.get(pairedRaw) : undefined;
            if (pairedMapped) {
                return value ? pairedMapped.url : value;
            }
            const rawKey = typeof record.storageKey === "string" ? record.storageKey : undefined;
            const localMapped = rawKey ? storageKeyMap.get(rawKey) : undefined;
            if (localMapped && inMediaContext && ARCHIVE_PRIMARY_MEDIA_URL_KEYS.has(key)) {
                if (key === "url" || key === "content") return localMapped.url;
                return value ? localMapped.url : value;
            }
            const localMissingKey = rawKey && !localMapped && isArchiveStorageKey(rawKey) ? rawKey : undefined;
            const pairedMissingKey = pairedRaw && !pairedMapped && isArchiveStorageKey(pairedRaw) ? pairedRaw : undefined;
            if (inMediaContext || localMissingKey || pairedMissingKey || key !== "content") {
                return dropInlineMediaRef(value) ?? "";
            }
            return value;
        },
        finalizeObject: (next, source, inMediaContext) => {
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
            const rawKey = typeof source.storageKey === "string" ? source.storageKey : undefined;
            const localMapped = rawKey ? storageKeyMap.get(rawKey) : undefined;
            if (localMapped && inMediaContext && !("content" in next) && !("url" in next)) {
                next.content = localMapped.url;
            }
            if (inMediaContext && !("storageKey" in next)) {
                const primaryUrl = typeof next.content === "string" ? next.content : typeof next.url === "string" ? next.url : "";
                const mappedResourceId = extractOwnedResourceIdFromArchiveUrl(primaryUrl);
                if (mappedResourceId) {
                    next.storageKey = resourceStorageKey(mappedResourceId);
                }
            }
        },
    });
    const drawingEngineById = new Map(
        drawingDocuments
            .filter((document) => !document.engine || document.engine === "excalidraw")
            .map((document) => [document.drawingId, "excalidraw" as const]),
    );
    if (Array.isArray(remapped.nodes)) {
        remapped.nodes = remapped.nodes.map((node) => {
            if (node.type !== CanvasNodeType.Drawing || !node.metadata?.drawingId) return node;
            return {
                ...node,
                metadata: {
                    ...node.metadata,
                    drawingEngine: drawingEngineById.get(node.metadata.drawingId) || "excalidraw",
                },
            };
        });
    }
    return { project: remapped, missingReferences: [...missingReferences] };
}

function dropInlineMediaRef(value?: string) {
    if (typeof value !== "string") return value;
    if (value.startsWith("blob:")) return "";
    if (/^data:(image|video|audio)\//i.test(value.trim())) return "";
    return value;
}

async function restoreArchiveDrawings(
    projectId: string,
    documents: CanvasDrawingExport[],
    zip: Map<string, Blob>,
    host: CanvasArchiveRestoreHost,
) {
    const results = await Promise.allSettled(
        documents.filter((document) => !document.engine || document.engine === "excalidraw").map(async (document) => {
            const previewFile = document.previewPath ? zip.get(document.previewPath) || zip.get(confinedArchivePath(document.previewPath)) : undefined;
            const preview = previewFile && !previewFile.type ? previewFile.slice(0, previewFile.size, "image/png") : previewFile;
            const renderFile = document.generationRender?.path ? zip.get(document.generationRender.path) || zip.get(confinedArchivePath(document.generationRender.path)) : undefined;
            const renderBlob = renderFile && !renderFile.type ? renderFile.slice(0, renderFile.size, document.generationRender?.mimeType || "image/png") : renderFile;
            const render =
                renderBlob && document.generationRender
                    ? ({
                        blob: renderBlob,
                        pageId: document.generationRender.pageId,
                        width: document.generationRender.width,
                        height: document.generationRender.height,
                        mimeType: document.generationRender.mimeType,
                        background: document.generationRender.background,
                    } satisfies CanvasDrawingRenderDraft)
                    : undefined;
            const engine = "excalidraw" as const;
            return host.saveDrawing(
                projectId,
                document.drawingId,
                engine,
                document.snapshot,
                null,
                preview,
                render,
            );
        }),
    );
    // Cleanup must not race a sibling drawing that is still being persisted.
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
}

async function cleanupCanvasArchiveAttempt(
    host: CanvasArchiveRestoreHost,
    attempt: { folderIds: string[]; projectIds: string[]; resourceIds: string[] },
) {
    if (attempt.projectIds.length) {
        try {
            await host.deleteProjects(attempt.projectIds);
        } catch (error) {
            // Keep the visible projects when their durable deletion failed.
            throw error;
        }
    }
    for (const folderId of attempt.folderIds) {
        try {
            await host.deleteFolder(folderId);
        } catch (error) {
            throw error;
        }
    }
    if (!host.deleteResource) return;
    await Promise.all(attempt.resourceIds.map(async (resourceId) => {
        try {
            await host.deleteResource?.(resourceId);
        } catch (error) {
            throw error;
        }
    }));
}

export { collectStorageKeys, isArchiveStorageKey, resourceIdFromStorageKey };
