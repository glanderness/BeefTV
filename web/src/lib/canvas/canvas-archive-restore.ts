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
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
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
    createFolder(name: string): string | Promise<string>;
    deleteFolder(id: string): void | Promise<void>;
    importProject(project: Partial<CanvasProject>, workspaceProjectId?: string): string;
    updateProject(id: string, patch: Partial<CanvasProject>): void;
    persistProject(id: string): Promise<void>;
    deleteProjects(ids: readonly string[]): Promise<void>;
    discardProjects(ids: readonly string[]): void;
    uploadMedia(blob: Blob, kind: "image" | "video" | "audio" | "file", meta: { storageKey: string; mimeType: string; fileName?: string }): Promise<RestoredMediaRef>;
    bindMediaAsset?(options: { canvasId: string; node: CanvasNodeData }): Promise<string>;
    saveDrawing: typeof saveCanvasDrawing;
    loadDrawing?(projectId: string, drawingId: string): Promise<{ drawingId: string; revision: number } | null>;
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

export async function archiveContentDigest(blob: Blob): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function archiveMediaIdempotencyKey(blob: Blob): Promise<string> {
    return `canvas-archive:sha256:${await archiveContentDigest(blob)}`;
}

export function assertRestoredCanvasMatches(intended: Pick<CanvasProject, "id" | "folderId" | "nodes" | "timeline">, saved: CanvasProject) {
    if (!saved?.id || saved.id !== intended.id) throw new Error("画布未保存到工作区");
    if ((saved.folderId || "") !== (intended.folderId || "")) throw new Error("画布文件夹未保存到工作区");
    const intendedTimeline = timelineStorageKeys(intended.timeline);
    const savedTimeline = timelineStorageKeys(saved.timeline);
    if (intendedTimeline.join("\n") !== savedTimeline.join("\n")) throw new Error("画布时间线未保存到工作区");
    const intendedKeys = collectStorageKeys({ nodes: intended.nodes, timeline: intended.timeline }).sort();
    const savedKeys = collectStorageKeys({ nodes: saved.nodes, timeline: saved.timeline }).sort();
    if (intendedKeys.join("\n") !== savedKeys.join("\n")) throw new Error("画布媒体未保存到工作区");
    const intendedAssets = mediaAssetIds(intended.nodes, intended.timeline);
    const savedAssets = mediaAssetIds(saved.nodes, saved.timeline);
    if (intendedAssets.join("\n") !== savedAssets.join("\n")) throw new Error("画布素材引用未保存到工作区");
}

function timelineStorageKeys(timeline: TimelineProject | undefined) {
    return (timeline?.clips || []).map((clip) => clip.directMedia?.storageKey || "").filter(Boolean).sort();
}

function mediaAssetIds(nodes: CanvasNodeData[], timeline: TimelineProject | undefined) {
    const ids: string[] = [];
    for (const node of nodes) {
        if (!isMediaNode(node.type)) continue;
        if (node.metadata?.storageKey && node.metadata.assetId) ids.push(`${node.id}:${node.metadata.assetId}`);
    }
    for (const clip of timeline?.clips || []) {
        const media = clip.directMedia;
        if (!media?.storageKey || media.kind === "text") continue;
        if (media.assetId) ids.push(`clip:${clip.id}:${media.assetId}`);
    }
    return ids.sort();
}

function isMediaNode(type: CanvasNodeData["type"]) {
    return type === CanvasNodeType.Image || type === CanvasNodeType.Video || type === CanvasNodeType.Audio;
}

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
            const live = store().openProject(id);
            if (!live) throw new Error("画布未保存到工作区");
            if (!usesCanonicalBackend) {
                await flushCanvasStorePersistence();
                const cached = store().openProject(id);
                if (!cached) throw new Error("画布未保存到工作区");
                assertRestoredCanvasMatches(live, cached);
                return;
            }
            await syncLocalCanvasProjectToBackend(id);
            let saved: CanvasProject;
            try {
                saved = await readLocalCanvasProjectFromBackend(id);
            } catch {
                throw new Error("画布未保存到工作区");
            }
            assertRestoredCanvasMatches(live, saved);
            if ((saved.revision ?? 0) < 1) throw new Error("画布未保存到工作区");
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
            const resource = await uploadResourceFile(blob, kind, { fileName: meta.fileName, idempotencyKey: await archiveMediaIdempotencyKey(blob) });
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

function withRestoreScope(host: CanvasArchiveRestoreHost, scope: CapturedUserScope): CanvasArchiveRestoreHost {
    const run = <Args extends unknown[], Result>(fn: (...args: Args) => Result) => (...args: Args) => {
        assertUserScope(scope);
        return fn(...args);
    };
    return {
        usesCanonicalBackend: host.usesCanonicalBackend,
        createFolder: run(host.createFolder),
        deleteFolder: run(host.deleteFolder),
        importProject: run(host.importProject),
        updateProject: run(host.updateProject),
        persistProject: run(host.persistProject),
        deleteProjects: run(host.deleteProjects),
        discardProjects: run(host.discardProjects),
        uploadMedia: run(host.uploadMedia),
        bindMediaAsset: host.bindMediaAsset ? run(host.bindMediaAsset) : undefined,
        saveDrawing: run(host.saveDrawing),
        loadDrawing: host.loadDrawing ? run(host.loadDrawing) : undefined,
        deleteResource: host.deleteResource ? run(host.deleteResource) : undefined,
        onProjectProgress: host.onProjectProgress,
    };
}

export async function restoreCanvasArchive(input: Blob | OpenCanvasArchive, host: Partial<CanvasArchiveRestoreHost> = {}): Promise<CanvasArchiveRestoreResult> {
    const scope = captureUserScope();
    const archive = "data" in input && "files" in input ? input : await openCanvasArchive(input);
    assertUserScope(scope);
    preflightCanvasArchive(archive.data, archive.files);
    const restoreHost = withRestoreScope(createCanvasArchiveRestoreHost(host), scope);
    const folderIds: string[] = [];
    const projectIds: string[] = [];
    const resourceIds: string[] = [];
    const folderIdMap = new Map<string, string>();
    const importedWorkspaceProjectIds = new Map<string, string>();
    try {
        for (const folder of archive.data.folders || []) {
            const id = await restoreHost.createFolder(folder.name);
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
                projectId: undefined,
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
            const bound = await bindRestoredMedia(importedProjectId, remappedNodes, remappedTimeline, restoreHost);
            restoreHost.updateProject(importedProjectId, bound.timeline ? { nodes: bound.nodes, timeline: bound.timeline } : { nodes: bound.nodes });
            await restoreArchiveDrawings(importedProjectId, item.drawingDocuments || [], archive.files, restoreHost);
            try {
                await restoreHost.persistProject(importedProjectId);
                await verifyRestoredDrawings(importedProjectId, item.drawingDocuments || [], restoreHost);
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
        if (isUserScopeAbandonedError(error) || !userScopeMatches(scope)) throw error;
        await cleanupCanvasArchiveAttempt(restoreHost, scope, { folderIds, projectIds, resourceIds });
        throw error;
    }
}

async function verifyRestoredDrawings(projectId: string, documents: CanvasDrawingExport[], host: CanvasArchiveRestoreHost) {
    if (!host.loadDrawing) return;
    for (const document of documents.filter((item) => !item.engine || item.engine === "excalidraw")) {
        const saved = await host.loadDrawing(projectId, document.drawingId);
        if (!saved || saved.drawingId !== document.drawingId) throw new Error("画板未保存到工作区");
        if ((saved.revision || 0) < 1) throw new Error("画板未保存到工作区");
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
    let halt = false;
    let firstError: unknown;
    const workers = new Array(Math.min(files.length, concurrency) || 0).fill(null).map(async () => {
        while (!halt) {
            const current = fileIndex++;
            if (current >= files.length) return;
            const fileItem = files[current];
            try {
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
            } catch (error) {
                halt = true;
                firstError ??= error;
            }
        }
    });
    await Promise.all(workers);
    if (firstError) throw firstError;
    return storageKeyMap;
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
    if (!timeline) return { nodes: nextNodes, timeline };
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
    const media = isMediaNode(node.type);
    const mapped = media && node.metadata?.storageKey ? storageKeyMap.get(node.metadata.storageKey) : undefined;
    const previewMapped = media && node.metadata?.videoPreview?.storageKey ? storageKeyMap.get(node.metadata.videoPreview.storageKey) : undefined;
    return {
        ...node,
        metadata: {
            ...node.metadata,
            assetId: undefined,
            storageKey: media ? mapped?.storageKey ?? dropDeadStorageKey(node.metadata?.storageKey) : node.metadata?.storageKey,
            content: media ? (mapped ? mapped.url : dropInlineMediaRef(node.metadata?.content)) : node.metadata?.content,
            previewContent: media ? (mapped ? mapped.url : dropInlineMediaRef(node.metadata?.previewContent)) : node.metadata?.previewContent,
            videoPreview: node.metadata?.videoPreview
                ? {
                    ...node.metadata.videoPreview,
                    storageKey: media ? previewMapped?.storageKey ?? dropDeadStorageKey(node.metadata.videoPreview.storageKey) : node.metadata.videoPreview.storageKey,
                    content: media ? (previewMapped ? previewMapped.url : dropInlineMediaRef(node.metadata.videoPreview.content)) : node.metadata.videoPreview.content,
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
            if (!media) return clip;
            if (media.kind === "text" || !media.storageKey) {
                return { ...clip, directMedia: { ...media, assetId: undefined } };
            }
            const mapped = storageKeyMap.get(media.storageKey);
            if (!mapped) {
                return {
                    ...clip,
                    directMedia: {
                        ...media,
                        assetId: undefined,
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
                    assetId: undefined,
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
    scope: CapturedUserScope,
    attempt: { folderIds: string[]; projectIds: string[]; resourceIds: string[] },
) {
    if (!userScopeMatches(scope)) return;
    try {
        assertUserScope(scope);
    } catch {
        return;
    }
    if (attempt.projectIds.length) {
        try {
            await host.deleteProjects(attempt.projectIds);
        } catch (error) {
            if (isUserScopeAbandonedError(error) || !userScopeMatches(scope)) return;
            host.discardProjects(attempt.projectIds);
        }
    }
    if (!userScopeMatches(scope)) return;
    for (const folderId of attempt.folderIds) {
        try {
            await host.deleteFolder(folderId);
        } catch (error) {
            if (isUserScopeAbandonedError(error) || !userScopeMatches(scope)) return;
        }
    }
    if (!host.deleteResource || !userScopeMatches(scope)) return;
    await Promise.all(attempt.resourceIds.map(async (resourceId) => {
        try {
            assertUserScope(scope);
            await host.deleteResource?.(resourceId);
        } catch {
            // Only this attempt's unreferenced objects; missing delete is recoverable.
        }
    }));
}

export { collectStorageKeys, isArchiveStorageKey, resourceIdFromStorageKey };
