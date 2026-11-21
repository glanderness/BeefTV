import { nanoid } from "nanoid";

import { getActiveUserScope } from "@/lib/user-scope";
import { ApiError } from "@/services/api/request";
import { resourceFileUrl, uploadResourceFile } from "@/services/api/resources";
import {
    deleteCanvasLibraryFolder as deleteCanvasLibraryFolderRemote,
    listCanvasLibraryFolders as listCanvasLibraryFoldersRemote,
    putCanvasLibraryFolder,
    type CanvasLibraryFolderRecord,
} from "@/services/api/workspace-data";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";

const folderOpChains = new Map<string, Promise<unknown>>();
const folderTouchedAt = new Map<string, number>();
const folderDeletedAt = new Map<string, number>();
let folderOpClock = 0;
let folderHydrateGeneration = 0;

function folderScopeKey(userScope: string, id: string) {
    return `${userScope}\0${id}`;
}

function enqueueFolderOp<T>(userScope: string, id: string, job: () => Promise<T>): Promise<T> {
    const key = folderScopeKey(userScope, id);
    const previous = folderOpChains.get(key) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(job);
    const tail = run.then(() => undefined, () => undefined);
    folderOpChains.set(key, tail);
    void tail.finally(() => {
        if (folderOpChains.get(key) === tail) folderOpChains.delete(key);
    });
    return run;
}

function isStaleProcessCoverUrl(value?: string) {
    if (!value) return false;
    if (value.startsWith("blob:")) return true;
    try {
        const parsed = new URL(value, "http://127.0.0.1");
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
            && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    } catch {
        return false;
    }
}

function liveCover(folder: CanvasFolder): CanvasFolder {
    if (folder.coverResourceId) {
        return { ...folder, coverDataUrl: resourceFileUrl(folder.coverResourceId) };
    }
    if (isStaleProcessCoverUrl(folder.coverDataUrl)) {
        return { ...folder, coverDataUrl: undefined };
    }
    return folder;
}

function mapRecord(record: CanvasLibraryFolderRecord): CanvasFolder {
    return liveCover({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        coverResourceId: record.coverResourceId,
    });
}

function sortFolders(folders: CanvasFolder[]): CanvasFolder[] {
    return [...folders].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}

function upsertStoreFolder(folder: CanvasFolder) {
    const current = useCanvasStore.getState().folders;
    const next = current.some((item) => item.id === folder.id)
        ? current.map((item) => item.id === folder.id ? folder : item)
        : [folder, ...current];
    useCanvasStore.getState().replaceFolders(sortFolders(next));
}

function removeStoreFolder(id: string) {
    const current = useCanvasStore.getState().folders;
    useCanvasStore.getState().replaceFolders(current.filter((item) => item.id !== id));
}

function folderReceiptMatches(saved: { folder?: { id?: string; name?: string } } | null | undefined, id: string, name?: string) {
    if (!saved?.folder || saved.folder.id !== id) return false;
    if (name !== undefined && saved.folder.name !== name) return false;
    return true;
}

async function contentDigest(blob: Blob) {
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function uploadFolderCover(folder: CanvasFolder) {
    if (folder.coverResourceId) return folder.coverResourceId;
    const dataUrl = folder.coverDataUrl;
    if (!dataUrl?.startsWith("data:image")) return undefined;
    const blob = await (await fetch(dataUrl)).blob();
    const digest = await contentDigest(blob);
    const resource = await uploadResourceFile(blob, "image", {
        fileName: "folder-cover.jpg",
        idempotencyKey: `canvas-folder-cover:sha256:${digest}`,
    });
    return resource.id;
}

async function saveFolderToBackend(userScope: string, folder: CanvasFolder): Promise<CanvasFolder> {
    const coverResourceId = await uploadFolderCover(folder);
    const saved = await putCanvasLibraryFolder(folder.id, {
        id: folder.id,
        name: folder.name,
        coverResourceId,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
    });
    if (!folderReceiptMatches(saved, folder.id, folder.name)) {
        throw new Error("文件夹没有保存成功");
    }
    const receipt = mapRecord(saved.folder);
    const key = folderScopeKey(userScope, folder.id);
    folderTouchedAt.set(key, ++folderOpClock);
    folderDeletedAt.delete(key);
    upsertStoreFolder(receipt);
    return receipt;
}

async function reconcileCanvasesAfterFolderDelete(folderId: string) {
    const affected = useCanvasStore.getState().projects.filter((project) => project.folderId === folderId);
    if (!affected.length) return;
    const { refreshLocalCanvasProjectIfChanged } = await import("@/services/local-workspace-repository");
    const staleIds: string[] = [];
    for (const project of affected) {
        const refreshed = await refreshLocalCanvasProjectIfChanged(project.id);
        if (!refreshed) staleIds.push(project.id);
    }
    if (!staleIds.length) return;
    const staleSet = new Set(staleIds);
    useCanvasStore.setState((state) => ({
        projects: state.projects.map((project) =>
            staleSet.has(project.id) && project.folderId === folderId
                ? { ...project, folderId: undefined }
                : project,
        ),
    }));
}

export async function createCanvasLibraryFolder(name = "未命名文件夹"): Promise<string> {
    const trimmed = name.trim() || "未命名文件夹";
    if (usesBrowserLocalResourceStore()) {
        return useCanvasStore.getState().createFolder(trimmed);
    }
    const now = new Date().toISOString();
    const folder: CanvasFolder = { id: nanoid(), name: trimmed, createdAt: now, updatedAt: now };
    const userScope = getActiveUserScope();
    const receipt = await enqueueFolderOp(userScope, folder.id, () => saveFolderToBackend(userScope, folder));
    return receipt.id;
}

export async function renameCanvasLibraryFolder(id: string, name: string): Promise<void> {
    const nextName = name.trim() || "未命名文件夹";
    if (usesBrowserLocalResourceStore()) {
        useCanvasStore.getState().renameFolder(id, nextName);
        return;
    }
    const userScope = getActiveUserScope();
    await enqueueFolderOp(userScope, id, async () => {
        const current = useCanvasStore.getState().folders.find((folder) => folder.id === id);
        if (!current) throw new Error("文件夹没有保存成功");
        await saveFolderToBackend(userScope, {
            ...current,
            name: nextName,
            updatedAt: new Date().toISOString(),
        });
    });
}

export async function deleteCanvasLibraryFolder(id: string): Promise<void> {
    if (usesBrowserLocalResourceStore()) {
        useCanvasStore.getState().deleteFolder(id);
        return;
    }
    const userScope = getActiveUserScope();
    await enqueueFolderOp(userScope, id, async () => {
        try {
            await deleteCanvasLibraryFolderRemote(id);
        } catch (error) {
            if (!(error instanceof ApiError) || (error.status !== 404 && error.code !== 404)) throw error;
        }
        const key = folderScopeKey(userScope, id);
        const clock = ++folderOpClock;
        folderDeletedAt.set(key, clock);
        folderTouchedAt.set(key, clock);
        removeStoreFolder(id);
        await reconcileCanvasesAfterFolderDelete(id);
    });
}

export async function persistCanvasFolderCover(id: string, coverDataUrl: string): Promise<void> {
    if (usesBrowserLocalResourceStore()) {
        useCanvasStore.getState().setFolderCover(id, coverDataUrl);
        return;
    }
    const userScope = getActiveUserScope();
    await enqueueFolderOp(userScope, id, async () => {
        const current = useCanvasStore.getState().folders.find((folder) => folder.id === id);
        if (!current) throw new Error("封面没有保存成功");
        await saveFolderToBackend(userScope, {
            ...current,
            coverResourceId: undefined,
            coverDataUrl,
            updatedAt: new Date().toISOString(),
        });
    });
}

export async function hydrateCanvasLibraryFolders(): Promise<void> {
    if (usesBrowserLocalResourceStore()) return;
    const userScope = getActiveUserScope();
    const hydrateId = ++folderHydrateGeneration;
    const startedAt = folderOpClock;
    const data = await listCanvasLibraryFoldersRemote();
    if (hydrateId !== folderHydrateGeneration) return;

    const currentFolders = useCanvasStore.getState().folders;
    const currentById = new Map(currentFolders.map((folder) => [folder.id, folder]));
    const listedIds = new Set((data.folders || []).map((folder) => folder.id));
    const byId = new Map<string, CanvasFolder>();

    for (const record of data.folders || []) {
        const key = folderScopeKey(userScope, record.id);
        if ((folderDeletedAt.get(key) || 0) > startedAt) continue;
        if ((folderTouchedAt.get(key) || 0) > startedAt && currentById.has(record.id)) {
            byId.set(record.id, liveCover(currentById.get(record.id)!));
        } else {
            byId.set(record.id, mapRecord(record));
        }
    }

    for (const folder of currentFolders) {
        const key = folderScopeKey(userScope, folder.id);
        if (byId.has(folder.id)) continue;
        if ((folderDeletedAt.get(key) || 0) > startedAt) continue;
        if ((folderTouchedAt.get(key) || 0) > startedAt) {
            byId.set(folder.id, liveCover(folder));
        }
    }

    const scopePrefix = `${userScope}\0`;
    for (const [key, clock] of [...folderDeletedAt.entries()]) {
        if (!key.startsWith(scopePrefix)) continue;
        const id = key.slice(scopePrefix.length);
        if (!listedIds.has(id) && clock <= startedAt) folderDeletedAt.delete(key);
    }
    for (const [key, clock] of [...folderTouchedAt.entries()]) {
        if (!key.startsWith(scopePrefix)) continue;
        if (clock <= startedAt) folderTouchedAt.delete(key);
    }

    useCanvasStore.getState().replaceFolders(sortFolders([...byId.values()]));
}

export function resetCanvasFolderStorageForTests() {
    folderOpChains.clear();
    folderTouchedAt.clear();
    folderDeletedAt.clear();
    folderOpClock = 0;
    folderHydrateGeneration = 0;
}
