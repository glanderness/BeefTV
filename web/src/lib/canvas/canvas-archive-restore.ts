import { confinedArchivePath } from "@/lib/zip";
import {
    collectStorageKeys,
    isArchiveStorageKey,
    openCanvasArchive,
    preflightCanvasArchive,
    type OpenCanvasArchive,
} from "@/lib/canvas/canvas-export";
import { saveCanvasDrawing, type CanvasDrawingRenderDraft } from "@/lib/canvas/canvas-drawing-storage";
import { canvasWorkspaceProjectId } from "@/lib/canvas/canvas-workspace-project";
import { normalizeLocalCanvasProject } from "@/lib/local-workspace-migration";
import { http } from "@/services/api/request";
import { resourceFileUrl, resourceIdFromStorageKey, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { primeResourceBlobCache } from "@/services/resource-blob-cache";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { readLocalCanvasProjectFromBackend, syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
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
    createFolder(name: string): string;
    deleteFolder(id: string): void;
    importProject(project: Partial<CanvasProject>, workspaceProjectId?: string): string;
    updateProject(id: string, patch: Partial<CanvasProject>): void;
    persistProject(id: string): Promise<void>;
    deleteProjects(ids: readonly string[]): Promise<void>;
    discardProjects(ids: readonly string[]): void;
    uploadMedia(blob: Blob, kind: "image" | "video" | "audio" | "file", meta: { storageKey: string; mimeType: string; fileName?: string }): Promise<RestoredMediaRef>;
    bindMediaAsset?(options: { canvasId: string; domainProjectId?: string; node: CanvasNodeData }): Promise<string>;
    saveDrawing: typeof saveCanvasDrawing;
    deleteResource?(resourceId: string): Promise<void>;
    onProjectProgress?(projectId: string, progress: CanvasArchiveProjectProgress | null): void;
};

export type CanvasArchiveRestoreResult = {
    count: number;
    projectIds: string[];
    folderIds: string[];
    resourceIds: string[];
    storage: "browser" | "backend";
};

export function createCanvasArchiveRestoreHost(overrides: Partial<CanvasArchiveRestoreHost> = {}): CanvasArchiveRestoreHost {
    const store = () => useCanvasStore.getState();
    const usesCanonicalBackend = overrides.usesCanonicalBackend ?? !usesBrowserLocalResourceStore();
    return {
        usesCanonicalBackend,
        createFolder: (name) => store().createFolder(name),
        deleteFolder: (id) => store().deleteFolder(id),
        importProject: (project, workspaceProjectId) => store().importProject(project, workspaceProjectId),
        updateProject: (id, patch) => store().updateProject(id, patch),
        persistProject: async (id) => {
            if (!usesCanonicalBackend) {
                await flushCanvasStorePersistence();
                return;
            }
            await syncLocalCanvasProjectToBackend(id);
            let saved: CanvasProject;
            try {
                saved = await readLocalCanvasProjectFromBackend(id);
            } catch {
                throw new Error("画布未保存到工作区");
            }
            if (!saved?.id || saved.id !== id) throw new Error("画布未保存到工作区");
        },
        deleteProjects: async (ids) => {
            const unique = [...new Set(ids.filter(Boolean))];
            if (usesCanonicalBackend) {
                await Promise.all(unique.map(async (id) => {
                    try {
                        await http.delete(`/canvas-projects/${encodeURIComponent(id)}`);
                    } catch {
                        // Cleanup only this attempt; a missing row is already recovered.
                    }
                }));
            }
            store().deleteProjects(unique);
        },
        discardProjects: (ids) => store().deleteProjects([...ids]),
        uploadMedia: async (blob, kind, meta) => {
            if (!usesCanonicalBackend) {
                const url = await (meta.storageKey.startsWith("image:") ? setImageBlob(meta.storageKey, blob) : setMediaBlob(meta.storageKey, blob));
                return { storageKey: meta.storageKey, url: url || "" };
            }
            const resource = await uploadResourceFile(blob, kind, { fileName: meta.fileName, idempotencyKey: `canvas-archive:${meta.storageKey}` });
            const storageKey = resourceStorageKey(resource.id);
            await primeResourceBlobCache(storageKey, blob).catch(() => undefined);
            return { storageKey, url: resource.publicUrl || resourceFileUrl(resource.id), resourceId: resource.id };
        },
        bindMediaAsset: async (options) => {
            const result = await ensureCanvasNodeAsset({ ...options, source: "canvas-upload" });
            return result.assetId;
        },
        saveDrawing: saveCanvasDrawing,
        ...overrides,
        usesCanonicalBackend,
    };
}

export async function restoreCanvasArchive(input: Blob | OpenCanvasArchive, host: Partial<CanvasArchiveRestoreHost> = {}): Promise<CanvasArchiveRestoreResult> {
    const archive = "data" in input && "files" in input ? input : await openCanvasArchive(input);
    preflightCanvasArchive(archive.data, archive.files);
    const restoreHost = createCanvasArchiveRestoreHost(host);
    const folderIds: string[] = [];
    const projectIds: string[] = [];
    const resourceIds: string[] = [];
    const folderIdMap = new Map<string, string>();
    const importedWorkspaceProjectIds = new Map<string, string>();
    try {
        for (const folder of archive.data.folders || []) {
            const id = restoreHost.createFolder(folder.name);
            folderIds.push(id);
            folderIdMap.set(folder.id, id);
        }
        for (const item of archive.data.projects) {
            const archiveProjectId = item.project.id;
            restoreHost.onProjectProgress?.(archiveProjectId, {
                projectId: archiveProjectId,
                total: item.files.length,
                completed: 0,
                phase: "uploading",
                message: restoreHost.usesCanonicalBackend ? "正在保存媒体" : "正在保存本地媒体",
            });
            const storageKeyMap = await restoreArchiveMedia(item.files, archive.files, restoreHost, resourceIds, (completed) => {
                restoreHost.onProjectProgress?.(archiveProjectId, {
                    projectId: archiveProjectId,
                    total: item.files.length,
                    completed,
                    phase: "uploading",
                    message: restoreHost.usesCanonicalBackend ? "正在保存媒体" : "正在保存本地媒体",
                });
            });
            const remappedNodes = (item.project.nodes || []).map((node) => remapArchiveNode(node, storageKeyMap, item.drawingDocuments || []));
            const remappedTimeline = remapArchiveTimeline(item.project.timeline, storageKeyMap);
            const sourceWorkspaceProjectId = canvasWorkspaceProjectId(item.project);
            const importedProjectId = restoreHost.importProject({
                ...normalizeLocalCanvasProject(item.project),
                folderId: item.project.folderId ? folderIdMap.get(item.project.folderId) : undefined,
                title: item.project.title || "导入画布",
                nodes: remappedNodes,
                timeline: remappedTimeline,
            }, importedWorkspaceProjectIds.get(sourceWorkspaceProjectId));
            projectIds.push(importedProjectId);
            if (!importedWorkspaceProjectIds.has(sourceWorkspaceProjectId)) importedWorkspaceProjectIds.set(sourceWorkspaceProjectId, importedProjectId);
            restoreHost.onProjectProgress?.(archiveProjectId, null);
            restoreHost.onProjectProgress?.(importedProjectId, {
                projectId: importedProjectId,
                total: item.files.length,
                completed: item.files.length,
                phase: "saving",
                message: restoreHost.usesCanonicalBackend ? "正在保存画布" : "正在保存本地画布",
            });
            const bound = await bindRestoredMedia(importedProjectId, remappedNodes, remappedTimeline, restoreHost, item.project.projectId);
            restoreHost.updateProject(importedProjectId, bound.timeline ? { nodes: bound.nodes, timeline: bound.timeline } : { nodes: bound.nodes });
            await restoreArchiveDrawings(importedProjectId, item.drawingDocuments || [], archive.files, restoreHost);
            try {
                await restoreHost.persistProject(importedProjectId);
            } catch (error) {
                restoreHost.onProjectProgress?.(importedProjectId, {
                    projectId: importedProjectId,
                    total: item.files.length,
                    completed: item.files.length,
                    phase: "error",
                    message: error instanceof Error ? error.message : "画布导入未完成",
                });
                throw error;
            } finally {
                restoreHost.onProjectProgress?.(importedProjectId, null);
            }
        }
        return {
            count: archive.data.projects.length,
            projectIds,
            folderIds,
            resourceIds,
            storage: restoreHost.usesCanonicalBackend ? "backend" : "browser",
        };
    } catch (error) {
        await cleanupCanvasArchiveAttempt(restoreHost, { folderIds, projectIds, resourceIds });
        throw error;
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
    const concurrency = 4;
    let fileIndex = 0;
    let completed = 0;
    const workers = new Array(Math.min(files.length, concurrency) || 0).fill(null).map(async () => {
        while (fileIndex < files.length) {
            const current = fileIndex++;
            const fileItem = files[current];
            const blob = zip.get(fileItem.path) || zip.get(confinedArchivePath(fileItem.path));
            if (!blob) throw new Error(`压缩包缺少媒体文件：${fileItem.path}`);
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
        }
    });
    await Promise.all(workers);
    return storageKeyMap;
}

async function bindRestoredMedia(
    projectId: string,
    nodes: CanvasNodeData[],
    timeline: TimelineProject | undefined,
    host: CanvasArchiveRestoreHost,
    domainProjectId?: string,
) {
    if (!host.bindMediaAsset) return { nodes, timeline };
    const assetIdByStorageKey = new Map<string, string>();
    const nextNodes: CanvasNodeData[] = [];
    for (const node of nodes) {
        const isMedia = node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio;
        if (!isMedia || !(node.metadata?.content || node.metadata?.storageKey)) {
            nextNodes.push(node);
            continue;
        }
        const storageKey = node.metadata?.storageKey || "";
        let assetId = storageKey ? assetIdByStorageKey.get(storageKey) : undefined;
        if (!assetId) {
            assetId = await host.bindMediaAsset({ canvasId: projectId, domainProjectId, node });
            if (storageKey && assetId) assetIdByStorageKey.set(storageKey, assetId);
        }
        nextNodes.push(assetId ? { ...node, metadata: { ...node.metadata, assetId } } : node);
    }
    if (!timeline) return { nodes: nextNodes, timeline };
    const clips: TimelineProject["clips"] = [];
    for (const clip of timeline.clips) {
        const media = clip.directMedia;
        if (!media || media.assetId || !media.storageKey || media.kind === "text") {
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
            assetId = await host.bindMediaAsset({ canvasId: projectId, domainProjectId, node });
            if (assetId) assetIdByStorageKey.set(media.storageKey, assetId);
        }
        clips.push(assetId ? { ...clip, directMedia: { ...media, assetId } } : clip);
    }
    return { nodes: nextNodes, timeline: { ...timeline, clips } };
}

function mediaKind(storageKey: string, mime: string): "image" | "video" | "audio" | "file" {
    if (mime.startsWith("image/") || storageKey.startsWith("image:")) return "image";
    if (mime.startsWith("video/") || storageKey.startsWith("video:")) return "video";
    if (mime.startsWith("audio/") || storageKey.startsWith("audio:")) return "audio";
    return "file";
}

function remapArchiveNode(node: CanvasNodeData, storageKeyMap: Map<string, RestoredMediaRef>, drawingDocuments: CanvasDrawingExport[]): CanvasNodeData {
    const drawingEngineById = new Map(drawingDocuments.filter((document) => !document.engine || document.engine === "excalidraw").map((document) => [document.drawingId, "excalidraw" as const]));
    const mapped = node.metadata?.storageKey ? storageKeyMap.get(node.metadata.storageKey) : undefined;
    const previewMapped = node.metadata?.videoPreview?.storageKey ? storageKeyMap.get(node.metadata.videoPreview.storageKey) : undefined;
    return {
        ...node,
        metadata: {
            ...node.metadata,
            storageKey: mapped?.storageKey ?? dropDeadStorageKey(node.metadata?.storageKey),
            content: mapped ? mapped.url : dropInlineMediaRef(node.metadata?.content),
            previewContent: mapped ? mapped.url : dropInlineMediaRef(node.metadata?.previewContent),
            videoPreview: node.metadata?.videoPreview
                ? {
                    ...node.metadata.videoPreview,
                    storageKey: previewMapped?.storageKey ?? dropDeadStorageKey(node.metadata.videoPreview.storageKey),
                    content: previewMapped ? previewMapped.url : dropInlineMediaRef(node.metadata.videoPreview.content),
                }
                : node.metadata?.videoPreview,
            drawingEngine: node.type === CanvasNodeType.Drawing && node.metadata?.drawingId
                ? drawingEngineById.get(node.metadata.drawingId) || "excalidraw"
                : node.metadata?.drawingEngine,
        },
    };
}

function remapArchiveTimeline(timeline: TimelineProject | undefined, storageKeyMap: Map<string, RestoredMediaRef>): TimelineProject | undefined {
    if (!timeline) return undefined;
    return {
        ...timeline,
        clips: timeline.clips.map((clip) => {
            const media = clip.directMedia;
            if (!media?.storageKey) return clip;
            const mapped = storageKeyMap.get(media.storageKey);
            if (!mapped) {
                return {
                    ...clip,
                    directMedia: {
                        ...media,
                        storageKey: dropDeadStorageKey(media.storageKey),
                        url: dropInlineMediaRef(media.url) || media.url,
                        dataUrl: dropInlineMediaRef(media.dataUrl),
                        content: dropInlineMediaRef(media.content),
                    },
                };
            }
            return {
                ...clip,
                directMedia: {
                    ...media,
                    storageKey: mapped.storageKey,
                    url: mapped.url,
                    dataUrl: media.dataUrl ? mapped.url : media.dataUrl,
                    content: media.content ? mapped.url : media.content,
                },
            };
        }),
    };
}

function dropDeadStorageKey(value?: string) {
    if (!value || !isArchiveStorageKey(value)) return undefined;
    return value;
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
    await Promise.all(
        documents.filter((document) => !document.engine || document.engine === "excalidraw").map((document) => {
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
                {
                    version: 2,
                    engine,
                    snapshot: document.snapshot,
                    revision: Math.max(0, document.revision - 1),
                    updatedAt: document.updatedAt,
                    shapeCount: document.shapeCount,
                    pageCount: document.pageCount,
                },
                preview,
                render,
            );
        }),
    );
}

async function cleanupCanvasArchiveAttempt(
    host: CanvasArchiveRestoreHost,
    attempt: { folderIds: string[]; projectIds: string[]; resourceIds: string[] },
) {
    if (attempt.projectIds.length) {
        try {
            await host.deleteProjects(attempt.projectIds);
        } catch {
            host.discardProjects(attempt.projectIds);
        }
    }
    for (const folderId of attempt.folderIds) {
        try {
            host.deleteFolder(folderId);
        } catch {
            // Folder rollback is best-effort for this attempt only.
        }
    }
    if (host.deleteResource) {
        await Promise.all(attempt.resourceIds.map(async (resourceId) => {
            try {
                await host.deleteResource?.(resourceId);
            } catch {
                // Only this attempt's unreferenced objects; missing delete is recoverable.
            }
        }));
    }
}

export { collectStorageKeys, isArchiveStorageKey, resourceIdFromStorageKey };
