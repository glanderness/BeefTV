import { resourceFileUrl, uploadResourceFile } from "@/services/api/resources";
import { deleteCanvasLibraryFolder as deleteCanvasLibraryFolderRemote, listCanvasLibraryFolders as listCanvasLibraryFoldersRemote, putCanvasLibraryFolder } from "@/services/api/workspace-data";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";

async function contentDigest(blob: Blob) {
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mapFolder(record: { id: string; name: string; coverResourceId?: string; createdAt: string; updatedAt: string }, previous?: CanvasFolder): CanvasFolder {
    return {
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        coverResourceId: record.coverResourceId,
        coverDataUrl: previous?.coverDataUrl && previous.coverResourceId === record.coverResourceId
            ? previous.coverDataUrl
            : record.coverResourceId
                ? resourceFileUrl(record.coverResourceId)
                : previous?.coverDataUrl,
    };
}

async function folderCoverResourceId(folder: CanvasFolder) {
    if (folder.coverResourceId) return folder.coverResourceId;
    const dataUrl = folder.coverDataUrl;
    if (!dataUrl?.startsWith("data:image")) return undefined;
    const blob = await (await fetch(dataUrl)).blob();
    const resource = await uploadResourceFile(blob, "image", {
        fileName: "folder-cover.jpg",
        idempotencyKey: `canvas-folder-cover:sha256:${await contentDigest(blob)}`,
    });
    return resource.id;
}

export async function persistCanvasLibraryFolder(folder: CanvasFolder): Promise<CanvasFolder> {
    if (usesBrowserLocalResourceStore()) return folder;
    const coverResourceId = await folderCoverResourceId(folder);
    const saved = await putCanvasLibraryFolder(folder.id, {
        id: folder.id,
        name: folder.name,
        coverResourceId,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
    });
    return mapFolder(saved.folder, folder);
}

export async function createCanvasLibraryFolder(name = "未命名文件夹") {
    const store = useCanvasStore.getState();
    const id = store.createFolder(name);
    try {
        const folder = useCanvasStore.getState().folders.find((item) => item.id === id);
        if (!folder) throw new Error("文件夹没有保存成功");
        const saved = await persistCanvasLibraryFolder(folder);
        useCanvasStore.getState().replaceFolders(useCanvasStore.getState().folders.map((item) => item.id === id ? saved : item));
        return id;
    } catch (error) {
        useCanvasStore.getState().deleteFolder(id);
        throw error;
    }
}

export async function renameCanvasLibraryFolder(id: string, name: string) {
    const store = useCanvasStore.getState();
    const previous = store.folders.find((folder) => folder.id === id);
    store.renameFolder(id, name);
    const folder = useCanvasStore.getState().folders.find((item) => item.id === id);
    if (!folder) throw new Error("文件夹没有保存成功");
    try {
        const saved = await persistCanvasLibraryFolder(folder);
        useCanvasStore.getState().replaceFolders(useCanvasStore.getState().folders.map((item) => item.id === id ? saved : item));
    } catch (error) {
        if (previous) useCanvasStore.getState().replaceFolders(useCanvasStore.getState().folders.map((item) => item.id === id ? previous : item));
        throw error;
    }
}

export async function deleteCanvasLibraryFolder(id: string) {
    if (!usesBrowserLocalResourceStore()) await deleteCanvasLibraryFolderRemote(id);
    useCanvasStore.getState().deleteFolder(id);
}

export async function persistCanvasFolderCover(id: string, coverDataUrl: string) {
    const store = useCanvasStore.getState();
    const previous = store.folders.find((folder) => folder.id === id);
    store.setFolderCover(id, coverDataUrl);
    const folder = useCanvasStore.getState().folders.find((item) => item.id === id);
    if (!folder) throw new Error("封面没有保存成功");
    try {
        const saved = await persistCanvasLibraryFolder({ ...folder, coverResourceId: undefined, coverDataUrl });
        useCanvasStore.getState().replaceFolders(useCanvasStore.getState().folders.map((item) => item.id === id ? saved : item));
    } catch (error) {
        if (previous) useCanvasStore.getState().replaceFolders(useCanvasStore.getState().folders.map((item) => item.id === id ? previous : item));
        throw error;
    }
}

export async function hydrateCanvasLibraryFolders() {
    if (usesBrowserLocalResourceStore()) return;
    try {
        const data = await listCanvasLibraryFoldersRemote();
        const previous = new Map(useCanvasStore.getState().folders.map((folder) => [folder.id, folder]));
        useCanvasStore.getState().replaceFolders((data.folders || []).map((folder) => mapFolder(folder, previous.get(folder.id))));
    } catch {
        // Keep the local cache when the workspace cannot be read yet.
    }
}
