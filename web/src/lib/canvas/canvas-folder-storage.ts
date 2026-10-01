import { nanoid } from "nanoid";

import { scopedStorageKey } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { ApiError } from "@/services/api/request";
import { resourceFileUrl, uploadResourceFile } from "@/services/api/resources";
import { deleteCanvasLibraryFolder as deleteCanvasLibraryFolderRemote, listCanvasLibraryFolders as listCanvasLibraryFoldersRemote, putCanvasLibraryFolder } from "@/services/api/workspace-data";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";

export const CANVAS_FOLDER_PENDING_KEY = "infinite-canvas:canvas_folder_pending";

type FolderPendingIntent = {
    generation: number;
    kind: "upsert" | "delete";
    folder?: CanvasFolder;
    error?: string;
};

type FolderPendingMap = Record<string, FolderPendingIntent>;

const folderCommitChains = new Map<string, Promise<unknown>>();
const folderRemovedAt = new Map<string, number>();
let folderOpClock = 0;
let folderHydrateGeneration = 0;
let digestDelayForTests: (() => Promise<void>) | undefined;

function captureScope(expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    return expected;
}

function folderCommitKey(userScope: string, id: string) {
    return `${userScope}\0${id}`;
}

function enqueueFolderCommit<T>(userScope: string, id: string, job: () => Promise<T>): Promise<T> {
    const key = folderCommitKey(userScope, id);
    const previous = folderCommitChains.get(key) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(job);
    folderCommitChains.set(key, run.then(() => undefined, () => undefined));
    return run;
}

function readPending(userScope: string): FolderPendingMap {
    if (typeof window === "undefined") return {};
    try {
        const raw = window.localStorage?.getItem(scopedStorageKey(CANVAS_FOLDER_PENDING_KEY, userScope));
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object") return {};
        const result: FolderPendingMap = {};
        for (const [id, value] of Object.entries(parsed as Record<string, FolderPendingIntent>)) {
            if (!id || !value || (value.kind !== "upsert" && value.kind !== "delete")) continue;
            result[id] = {
                generation: Number(value.generation) || 0,
                kind: value.kind,
                folder: value.folder,
                error: typeof value.error === "string" ? value.error : undefined,
            };
        }
        return result;
    } catch {
        return {};
    }
}

function writePending(userScope: string, pending: FolderPendingMap, expected: CapturedUserScope) {
    assertUserScope(expected);
    if (typeof window === "undefined") return;
    const ids = Object.keys(pending);
    if (!ids.length) {
        window.localStorage?.removeItem(scopedStorageKey(CANVAS_FOLDER_PENDING_KEY, userScope));
        return;
    }
    window.localStorage?.setItem(scopedStorageKey(CANVAS_FOLDER_PENDING_KEY, userScope), JSON.stringify(pending));
}

function nextGeneration(intent?: FolderPendingIntent) {
    return (intent?.generation || 0) + 1;
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

function mapRecord(record: { id: string; name: string; coverResourceId?: string; createdAt: string; updatedAt: string }, previous?: CanvasFolder): CanvasFolder {
    return liveCover({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        coverResourceId: record.coverResourceId,
        coverDataUrl: previous?.coverDataUrl,
        unsaved: undefined,
        saveError: undefined,
    });
}

function projectFolders(canonical: CanvasFolder[], pending: FolderPendingMap): CanvasFolder[] {
    const byId = new Map(canonical.map((folder) => [folder.id, liveCover({ ...folder, unsaved: undefined, saveError: undefined })]));
    for (const [id, intent] of Object.entries(pending)) {
        if (intent.kind === "delete") {
            byId.delete(id);
            continue;
        }
        if (!intent.folder) continue;
        const current = byId.get(id);
        byId.set(id, liveCover({
            ...intent.folder,
            coverResourceId: intent.folder.coverResourceId || current?.coverResourceId,
            unsaved: true,
            saveError: intent.error,
        }));
    }
    return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}

function publishFolders(canonical: CanvasFolder[], pending: FolderPendingMap, expected: CapturedUserScope) {
    assertUserScope(expected);
    useCanvasStore.getState().replaceFolders(projectFolders(canonical, pending));
}

function canonicalFromProjection(pending: FolderPendingMap): CanvasFolder[] {
    const folders = useCanvasStore.getState().folders;
    return folders
        .filter((folder) => {
            const intent = pending[folder.id];
            if (intent?.kind === "delete") return false;
            if (intent?.kind === "upsert") return false;
            return true;
        })
        .map((folder) => liveCover({ ...folder, unsaved: undefined, saveError: undefined }));
}

async function contentDigest(blob: Blob) {
    if (digestDelayForTests) await digestDelayForTests();
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function folderCoverResourceId(folder: CanvasFolder, expected: CapturedUserScope) {
    if (folder.coverResourceId) return folder.coverResourceId;
    const dataUrl = folder.coverDataUrl;
    if (!dataUrl?.startsWith("data:image")) return undefined;
    assertUserScope(expected);
    const blob = await (await fetch(dataUrl)).blob();
    assertUserScope(expected);
    const digest = await contentDigest(blob);
    assertUserScope(expected);
    const resource = await uploadResourceFile(blob, "image", {
        fileName: "folder-cover.jpg",
        idempotencyKey: `canvas-folder-cover:sha256:${digest}`,
        expectedScope: expected,
    });
    assertUserScope(expected);
    return resource.id;
}

function persistErrorMessage(error: unknown) {
    if (isUserScopeAbandonedError(error)) return error.message;
    if (error instanceof Error && error.message) return error.message;
    return "文件夹没有保存成功";
}

async function commitFolderIntent(id: string, generation: number, expected: CapturedUserScope) {
    assertUserScope(expected);
    const pending = readPending(expected.userScope);
    const intent = pending[id];
    if (!intent || intent.generation !== generation) return;
    if (intent.kind === "delete") {
        try {
            await deleteCanvasLibraryFolderRemote(id, { expectedScope: expected });
        } catch (error) {
            if (isUserScopeAbandonedError(error)) throw error;
            if (!(error instanceof ApiError) || (error.status !== 404 && error.code !== 404)) throw error;
        }
        assertUserScope(expected);
        const live = readPending(expected.userScope);
        if (live[id]?.generation !== generation) return;
        writePending(expected.userScope, live, expected);
        publishFolders(canonicalFromProjection(live), live, expected);
        return;
    }
    if (!intent.folder) return;
    const coverResourceId = await folderCoverResourceId(intent.folder, expected);
    assertUserScope(expected);
    const saved = await putCanvasLibraryFolder(id, {
        id,
        name: intent.folder.name,
        coverResourceId,
        createdAt: intent.folder.createdAt,
        updatedAt: intent.folder.updatedAt,
    }, { expectedScope: expected });
    assertUserScope(expected);
    const live = readPending(expected.userScope);
    const current = live[id];
    if (!current || current.generation !== generation) return;
    delete live[id];
    writePending(expected.userScope, live, expected);
    const canonical = canonicalFromProjection(live);
    const receipt = mapRecord(saved.folder, current.folder);
    publishFolders(canonical.some((folder) => folder.id === id) ? canonical.map((folder) => folder.id === id ? receipt : folder) : [receipt, ...canonical], live, expected);
}

async function stageUpsert(folder: CanvasFolder, expected: CapturedUserScope) {
    const pending = readPending(expected.userScope);
    const generation = nextGeneration(pending[folder.id]);
    pending[folder.id] = { generation, kind: "upsert", folder: { ...folder, unsaved: undefined, saveError: undefined } };
    writePending(expected.userScope, pending, expected);
    const canonical = canonicalFromProjection(pending);
    publishFolders(canonical, pending, expected);
    return generation;
}

export async function persistCanvasLibraryFolder(folder: CanvasFolder, expectedScope?: CapturedUserScope): Promise<CanvasFolder> {
    const expected = captureScope(expectedScope);
    if (usesBrowserLocalResourceStore()) {
        publishFolders(useCanvasStore.getState().folders.map((item) => item.id === folder.id ? liveCover(folder) : item), {}, expected);
        return liveCover(folder);
    }
    const generation = await stageUpsert(folder, expected);
    await enqueueFolderCommit(expected.userScope, folder.id, () => commitFolderIntent(folder.id, generation, expected));
    const live = useCanvasStore.getState().folders.find((item) => item.id === folder.id);
    return live || liveCover(folder);
}

export async function createCanvasLibraryFolder(name = "未命名文件夹", expectedScope?: CapturedUserScope) {
    const expected = captureScope(expectedScope);
    const now = new Date().toISOString();
    const folder: CanvasFolder = { id: nanoid(), name: name.trim() || "未命名文件夹", createdAt: now, updatedAt: now };
    if (usesBrowserLocalResourceStore()) {
        const id = useCanvasStore.getState().createFolder(folder.name);
        assertUserScope(expected);
        return id;
    }
    const generation = await stageUpsert(folder, expected);
    try {
        await enqueueFolderCommit(expected.userScope, folder.id, () => commitFolderIntent(folder.id, generation, expected));
        return folder.id;
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        const pending = readPending(expected.userScope);
        if (pending[folder.id]?.generation === generation) {
            pending[folder.id] = { ...pending[folder.id], error: persistErrorMessage(error) };
            writePending(expected.userScope, pending, expected);
            publishFolders(canonicalFromProjection(pending), pending, expected);
        }
        throw error;
    }
}

export async function renameCanvasLibraryFolder(id: string, name: string, expectedScope?: CapturedUserScope) {
    const expected = captureScope(expectedScope);
    const nextName = name.trim() || "未命名文件夹";
    if (usesBrowserLocalResourceStore()) {
        useCanvasStore.getState().renameFolder(id, nextName);
        assertUserScope(expected);
        return;
    }
    const current = useCanvasStore.getState().folders.find((folder) => folder.id === id);
    if (!current) throw new Error("文件夹没有保存成功");
    const generation = await stageUpsert({ ...current, name: nextName, updatedAt: new Date().toISOString() }, expected);
    try {
        await enqueueFolderCommit(expected.userScope, id, () => commitFolderIntent(id, generation, expected));
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        const pending = readPending(expected.userScope);
        if (pending[id]?.generation === generation) {
            pending[id] = { ...pending[id], error: persistErrorMessage(error) };
            writePending(expected.userScope, pending, expected);
            publishFolders(canonicalFromProjection(pending), pending, expected);
        }
        throw error;
    }
}

export async function deleteCanvasLibraryFolder(id: string, expectedScope?: CapturedUserScope) {
    const expected = captureScope(expectedScope);
    if (usesBrowserLocalResourceStore()) {
        useCanvasStore.getState().deleteFolder(id);
        return;
    }
    const pending = readPending(expected.userScope);
    const generation = nextGeneration(pending[id]);
    pending[id] = { generation, kind: "delete" };
    folderRemovedAt.set(`${expected.userScope}:${id}`, ++folderOpClock);
    writePending(expected.userScope, pending, expected);
    publishFolders(canonicalFromProjection(pending), pending, expected);
    try {
        await enqueueFolderCommit(expected.userScope, id, () => commitFolderIntent(id, generation, expected));
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        const live = readPending(expected.userScope);
        if (live[id]?.generation === generation) {
            live[id] = { ...live[id], error: persistErrorMessage(error) };
            writePending(expected.userScope, live, expected);
            publishFolders(canonicalFromProjection(live), live, expected);
        }
        throw error;
    }
}

export async function persistCanvasFolderCover(id: string, coverDataUrl: string, expectedScope?: CapturedUserScope) {
    const expected = captureScope(expectedScope);
    if (usesBrowserLocalResourceStore()) {
        useCanvasStore.getState().setFolderCover(id, coverDataUrl);
        return;
    }
    const current = useCanvasStore.getState().folders.find((folder) => folder.id === id);
    if (!current) throw new Error("封面没有保存成功");
    const generation = await stageUpsert({
        ...current,
        coverResourceId: undefined,
        coverDataUrl,
        updatedAt: new Date().toISOString(),
    }, expected);
    try {
        await enqueueFolderCommit(expected.userScope, id, () => commitFolderIntent(id, generation, expected));
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        const pending = readPending(expected.userScope);
        if (pending[id]?.generation === generation) {
            pending[id] = { ...pending[id], error: persistErrorMessage(error) };
            writePending(expected.userScope, pending, expected);
            publishFolders(canonicalFromProjection(pending), pending, expected);
        }
        throw error;
    }
}

export async function hydrateCanvasLibraryFolders(expectedScope?: CapturedUserScope) {
    const expected = captureScope(expectedScope);
    if (usesBrowserLocalResourceStore()) return;
    const hydrateId = ++folderHydrateGeneration;
    const startedAt = folderOpClock;
    const local = useCanvasStore.getState().folders;
    let remoteFolders: CanvasFolder[] = [];
    let listedIds = new Set<string>();
    try {
        const data = await listCanvasLibraryFoldersRemote({ expectedScope: expected });
        assertUserScope(expected);
        if (hydrateId !== folderHydrateGeneration) return;
        const latestLocal = useCanvasStore.getState().folders;
        listedIds = new Set((data.folders || []).map((folder) => folder.id));
        remoteFolders = (data.folders || []).map((folder) => mapRecord(folder, latestLocal.find((item) => item.id === folder.id)))
            .filter((folder) => (folderRemovedAt.get(`${expected.userScope}:${folder.id}`) || 0) <= startedAt);
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        const covers = useCanvasStore.getState().folders.map(liveCover);
        const livePending = readPending(expected.userScope);
        publishFolders(covers.filter((folder) => livePending[folder.id]?.kind !== "delete"), livePending, expected);
        throw error;
    }

    const remoteIds = new Set(remoteFolders.map((folder) => folder.id));
    const nextPending = { ...readPending(expected.userScope) };
    for (const [id, intent] of Object.entries(nextPending)) {
        if (intent.kind !== "delete") continue;
        const removedAt = folderRemovedAt.get(`${expected.userScope}:${id}`) || 0;
        if (!listedIds.has(id) && removedAt <= startedAt) {
            delete nextPending[id];
            folderRemovedAt.delete(`${expected.userScope}:${id}`);
        }
    }
    for (const [key, removedAt] of [...folderRemovedAt.entries()]) {
        if (!key.startsWith(`${expected.userScope}:`)) continue;
        const id = key.slice(expected.userScope.length + 1);
        if (!listedIds.has(id) && removedAt <= startedAt && nextPending[id]?.kind !== "delete") folderRemovedAt.delete(key);
    }
    for (const folder of [...local, ...useCanvasStore.getState().folders]) {
        if (remoteIds.has(folder.id) || nextPending[folder.id]) continue;
        if ((folderRemovedAt.get(`${expected.userScope}:${folder.id}`) || 0) > startedAt) continue;
        nextPending[folder.id] = {
            generation: 1,
            kind: "upsert",
            folder: { ...folder, unsaved: undefined, saveError: undefined },
        };
    }
    writePending(expected.userScope, nextPending, expected);
    publishFolders(remoteFolders, nextPending, expected);
}

export function peekCanvasFolderPendingForTests(userScope: string) {
    return readPending(userScope);
}

export function setCanvasFolderDigestDelayForTests(delay?: () => Promise<void>) {
    digestDelayForTests = delay;
}

export function resetCanvasFolderStorageForTests() {
    folderCommitChains.clear();
    folderRemovedAt.clear();
    folderOpClock = 0;
    folderHydrateGeneration = 0;
    digestDelayForTests = undefined;
}
