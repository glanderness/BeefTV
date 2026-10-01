import localforage from "localforage";
import { nanoid } from "nanoid";

import { scopedStorageKey } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { ApiError } from "@/services/api/request";
import { resourceFileUrl, uploadResourceFile } from "@/services/api/resources";
import { deleteCanvasLibraryFolder as deleteCanvasLibraryFolderRemote, listCanvasLibraryFolders as listCanvasLibraryFoldersRemote, putCanvasLibraryFolder } from "@/services/api/workspace-data";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";

export const CANVAS_FOLDER_PENDING_KEY = "infinite-canvas:canvas_folder_pending";

export class FolderPendingUnreadableError extends Error {
    constructor() {
        super("文件夹未保存的修改无法读取");
        this.name = "FolderPendingUnreadableError";
    }
}

type FolderPendingIntent = {
    generation: number;
    kind: "upsert" | "delete";
    folder?: CanvasFolder;
    error?: string;
    blockedReimport?: boolean;
};

type FolderPendingMap = Record<string, FolderPendingIntent>;

type FolderPendingStore = {
    getItem(key: string): Promise<FolderPendingMap | null>;
    setItem(key: string, value: FolderPendingMap): Promise<FolderPendingMap>;
    removeItem(key: string): Promise<void>;
};

const defaultFolderPendingStore: FolderPendingStore = localforage.createInstance({
    name: "infinite-canvas",
    storeName: "canvas_folder_pending",
});

let folderPendingStore: FolderPendingStore = defaultFolderPendingStore;
const folderCommitChains = new Map<string, Promise<unknown>>();
const pendingLocks = new Map<string, Promise<unknown>>();
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

function withPendingLock<T>(userScope: string, job: () => Promise<T>): Promise<T> {
    const previous = pendingLocks.get(userScope) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(job);
    pendingLocks.set(userScope, run.then(() => undefined, () => undefined));
    return run;
}

function parsePendingMap(raw: unknown): FolderPendingMap {
    if (raw == null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) throw new FolderPendingUnreadableError();
    const result: FolderPendingMap = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!id || !value || typeof value !== "object" || Array.isArray(value)) throw new FolderPendingUnreadableError();
        const intent = value as FolderPendingIntent;
        if (intent.kind !== "upsert" && intent.kind !== "delete") throw new FolderPendingUnreadableError();
        result[id] = {
            generation: Number(intent.generation) || 0,
            kind: intent.kind,
            folder: intent.folder,
            error: typeof intent.error === "string" ? intent.error : undefined,
            blockedReimport: intent.blockedReimport === true,
        };
    }
    return result;
}

function migrateLegacyPending(userScope: string): FolderPendingMap | null {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage?.getItem(scopedStorageKey(CANVAS_FOLDER_PENDING_KEY, userScope));
    if (!raw) return null;
    try {
        return parsePendingMap(JSON.parse(raw));
    } catch (error) {
        if (error instanceof FolderPendingUnreadableError) throw error;
        throw new FolderPendingUnreadableError();
    }
}

async function readPending(userScope: string): Promise<FolderPendingMap> {
    let raw: unknown;
    try {
        raw = await folderPendingStore.getItem(userScope);
    } catch {
        throw new FolderPendingUnreadableError();
    }
    if (raw != null) return parsePendingMap(raw);
    const migrated = migrateLegacyPending(userScope);
    if (!migrated) return {};
    try {
        await folderPendingStore.setItem(userScope, migrated);
        window.localStorage?.removeItem(scopedStorageKey(CANVAS_FOLDER_PENDING_KEY, userScope));
    } catch {
        throw new FolderPendingUnreadableError();
    }
    return migrated;
}

async function mutatePending(
    userScope: string,
    expected: CapturedUserScope,
    mutator: (live: FolderPendingMap) => FolderPendingMap,
): Promise<FolderPendingMap> {
    return withPendingLock(userScope, async () => {
        assertUserScope(expected);
        const live = await readPending(userScope);
        assertUserScope(expected);
        const next = mutator({ ...live });
        const ids = Object.keys(next);
        if (!ids.length) await folderPendingStore.removeItem(userScope);
        else await folderPendingStore.setItem(userScope, next);
        assertUserScope(expected);
        return next;
    });
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

function isFailedPrecondition(error: unknown) {
    return error instanceof ApiError && error.reason === "failed_precondition";
}

function persistErrorMessage(error: unknown) {
    if (isUserScopeAbandonedError(error)) return error.message;
    if (isFailedPrecondition(error)) return "文件夹已删除，未保存的修改还在本机";
    if (error instanceof Error && error.message) return error.message;
    return "文件夹没有保存成功";
}

async function commitFolderIntent(id: string, generation: number, expected: CapturedUserScope) {
    assertUserScope(expected);
    const pending = await readPending(expected.userScope);
    const intent = pending[id];
    if (!intent || intent.generation !== generation) return;
    if (intent.blockedReimport) throw new Error(intent.error || "文件夹已删除，未保存的修改还在本机");
    if (intent.kind === "delete") {
        try {
            await deleteCanvasLibraryFolderRemote(id, { expectedScope: expected });
        } catch (error) {
            if (isUserScopeAbandonedError(error)) throw error;
            if (!(error instanceof ApiError) || (error.status !== 404 && error.code !== 404)) throw error;
        }
        assertUserScope(expected);
        const live = await readPending(expected.userScope);
        if (live[id]?.generation !== generation) return;
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
    const live = await mutatePending(expected.userScope, expected, (current) => {
        if (current[id]?.generation !== generation) return current;
        const next = { ...current };
        delete next[id];
        return next;
    });
    const canonical = canonicalFromProjection(live);
    const receipt = mapRecord(saved.folder, intent.folder);
    publishFolders(canonical.some((folder) => folder.id === id) ? canonical.map((folder) => folder.id === id ? receipt : folder) : [receipt, ...canonical], live, expected);
}

async function stageUpsert(folder: CanvasFolder, expected: CapturedUserScope) {
    let generation = 0;
    const pending = await mutatePending(expected.userScope, expected, (live) => {
        generation = nextGeneration(live[folder.id]);
        live[folder.id] = {
            generation,
            kind: "upsert",
            folder: { ...folder, unsaved: undefined, saveError: undefined },
            blockedReimport: live[folder.id]?.blockedReimport === true,
        };
        return live;
    });
    publishFolders(canonicalFromProjection(pending), pending, expected);
    return generation;
}

async function markPendingError(id: string, generation: number, error: unknown, expected: CapturedUserScope) {
    const pending = await mutatePending(expected.userScope, expected, (live) => {
        if (live[id]?.generation !== generation) return live;
        live[id] = {
            ...live[id],
            error: persistErrorMessage(error),
            blockedReimport: live[id].blockedReimport === true || isFailedPrecondition(error),
        };
        return live;
    });
    publishFolders(canonicalFromProjection(pending), pending, expected);
}

export async function persistCanvasLibraryFolder(folder: CanvasFolder, expectedScope?: CapturedUserScope): Promise<CanvasFolder> {
    const expected = captureScope(expectedScope);
    if (usesBrowserLocalResourceStore()) {
        publishFolders(useCanvasStore.getState().folders.map((item) => item.id === folder.id ? liveCover(folder) : item), {}, expected);
        return liveCover(folder);
    }
    const generation = await stageUpsert(folder, expected);
    try {
        await enqueueFolderCommit(expected.userScope, folder.id, () => commitFolderIntent(folder.id, generation, expected));
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        await markPendingError(folder.id, generation, error, expected);
        if (isFailedPrecondition(error)) throw new Error(persistErrorMessage(error));
        throw error;
    }
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
        await markPendingError(folder.id, generation, error, expected);
        if (isFailedPrecondition(error)) throw new Error(persistErrorMessage(error));
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
        await markPendingError(id, generation, error, expected);
        if (isFailedPrecondition(error)) throw new Error(persistErrorMessage(error));
        throw error;
    }
}

export async function deleteCanvasLibraryFolder(id: string, expectedScope?: CapturedUserScope) {
    const expected = captureScope(expectedScope);
    if (usesBrowserLocalResourceStore()) {
        useCanvasStore.getState().deleteFolder(id);
        return;
    }
    let generation = 0;
    folderRemovedAt.set(`${expected.userScope}:${id}`, ++folderOpClock);
    const pending = await mutatePending(expected.userScope, expected, (live) => {
        generation = nextGeneration(live[id]);
        live[id] = { generation, kind: "delete" };
        return live;
    });
    publishFolders(canonicalFromProjection(pending), pending, expected);
    try {
        await enqueueFolderCommit(expected.userScope, id, () => commitFolderIntent(id, generation, expected));
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        await markPendingError(id, generation, error, expected);
        if (isFailedPrecondition(error)) throw new Error(persistErrorMessage(error));
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
        await markPendingError(id, generation, error, expected);
        if (isFailedPrecondition(error)) throw new Error(persistErrorMessage(error));
        throw error;
    }
}

export async function hydrateCanvasLibraryFolders(expectedScope?: CapturedUserScope) {
    const expected = captureScope(expectedScope);
    if (usesBrowserLocalResourceStore()) return;
    const hydrateId = ++folderHydrateGeneration;
    const startedAt = folderOpClock;
    const local = useCanvasStore.getState().folders;
    const existingPending = await readPending(expected.userScope);
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
        const livePending = await readPending(expected.userScope);
        publishFolders(covers.filter((folder) => livePending[folder.id]?.kind !== "delete"), livePending, expected);
        throw error;
    }

    const remoteIds = new Set(remoteFolders.map((folder) => folder.id));
    const nextPending = await mutatePending(expected.userScope, expected, (live) => {
        for (const [id, intent] of Object.entries(live)) {
            if (intent.kind !== "delete") continue;
            const removedAt = folderRemovedAt.get(`${expected.userScope}:${id}`) || 0;
            if (!listedIds.has(id) && removedAt <= startedAt) {
                delete live[id];
                folderRemovedAt.delete(`${expected.userScope}:${id}`);
            }
        }
        for (const [key, removedAt] of [...folderRemovedAt.entries()]) {
            if (!key.startsWith(`${expected.userScope}:`)) continue;
            const id = key.slice(expected.userScope.length + 1);
            if (!listedIds.has(id) && removedAt <= startedAt && live[id]?.kind !== "delete") folderRemovedAt.delete(key);
        }
        for (const folder of [...local, ...useCanvasStore.getState().folders]) {
            if (remoteIds.has(folder.id) || live[folder.id]) continue;
            if ((folderRemovedAt.get(`${expected.userScope}:${folder.id}`) || 0) > startedAt) continue;
            if (existingPending[folder.id]?.kind === "delete") continue;
            live[folder.id] = {
                generation: 1,
                kind: "upsert",
                folder: { ...folder, unsaved: undefined, saveError: undefined },
            };
        }
        return live;
    });
    publishFolders(remoteFolders, nextPending, expected);
}

export async function peekCanvasFolderPendingForTests(userScope: string) {
    return readPending(userScope);
}

export function setCanvasFolderDigestDelayForTests(delay?: () => Promise<void>) {
    digestDelayForTests = delay;
}

export function replaceCanvasFolderPendingStoreForTests(store?: FolderPendingStore) {
    folderPendingStore = store ?? defaultFolderPendingStore;
}

export function resetCanvasFolderStorageForTests() {
    folderCommitChains.clear();
    pendingLocks.clear();
    folderRemovedAt.clear();
    folderOpClock = 0;
    folderHydrateGeneration = 0;
    digestDelayForTests = undefined;
    folderPendingStore = defaultFolderPendingStore;
}
