import { create } from "zustand";
import { persist, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { sameCanvasContent, sameCanvasDocument } from "@/lib/canvas/canvas-content";
import { traceCanvasGraph } from "@/lib/canvas/canvas-graph-trace";
import { DEFAULT_CANVAS_BACKGROUND_MODE, normalizeCanvasAppearance, readCanvasAppearanceDefault } from "@/lib/canvas/canvas-appearance";
import { decideExternalCanvasRevision } from "@/lib/canvas/canvas-external-revision";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope, scopedLocalStorage } from "@/lib/user-scope";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import type { ViewportTransform } from "@/types/canvas";
import {
    CANVAS_DRAFTS_KEY,
    CANVAS_STORE_KEY,
    canvasDocumentBase,
    canvasDurableSnapshot,
    canvasMemoryStates,
    clearCanvasDocumentBase,
    commitPendingCanvasStorePersistenceLocked,
    createCanvasPersistStorage,
    flushCanvasStorePersistence,
    hasActiveCanvasStorePersistence,
    pendingCanvasStorePersistence,
    recordCanvasDocumentBase,
    recordCanvasStorageDocument,
    registerCanvasGenerationPersistenceAttempt,
    samePersistenceValue,
    withCanvasStorePersistenceLock,
    withCanvasStorePersistenceSuppressed,
    type CanvasFolder,
    type CanvasProject,
} from "./canvas-store-persistence";

export {
    CANVAS_DRAFTS_KEY,
    CANVAS_STORE_KEY,
    canvasDocumentBase,
    canvasDurableSnapshot,
    clearCanvasDocumentBase,
    commitPendingCanvasStorePersistenceLocked,
    flushCanvasStorePersistence,
    hasActiveCanvasStorePersistence,
    pendingCanvasStorePersistence,
    recordCanvasDocumentBase,
    recordCanvasStorageDocument,
    registerCanvasGenerationPersistenceAttempt,
    withCanvasStorePersistenceLock,
    withCanvasStorePersistenceSuppressed,
    type CanvasFolder,
    type CanvasProject,
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    folders: CanvasFolder[];
    createProject: (title?: string, projectId?: string, workspaceProjectId?: string) => string;
    createFolder: (name?: string) => string;
    renameFolder: (id: string, name: string) => void;
    deleteFolder: (id: string) => void;
    setFolderCover: (id: string, coverDataUrl: string) => void;
    replaceFolders: (folders: CanvasFolder[]) => void;
    moveProjectsToFolder: (ids: string[], folderId?: string) => void;
    importProject: (project: Partial<CanvasProject>, workspaceProjectId?: string) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    restoreProject: (project: CanvasProject) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "workspaceProjectId" | "projectId" | "folderId" | "title" | "canvasTitle" | "nodes" | "connections" | "chatSessions" | "activeChatId" | "starterMode" | "appearance" | "backgroundMode" | "showImageInfo" | "viewport" | "directorScenes" | "timeline">>) => void;
};

export const CANVAS_FOLDERS_KEY = "infinite-canvas:canvas_folders";

function isStaleProcessCoverUrl(value: string) {
    if (value.startsWith("blob:")) return true;
    try {
        const parsed = new URL(value, "http://127.0.0.1");
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
            && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    } catch {
        return false;
    }
}

function readCanvasFolders(): CanvasFolder[] {
    try {
        const value = scopedLocalStorage.getItem(CANVAS_FOLDERS_KEY);
        const parsed = value ? JSON.parse(value) : [];
        return Array.isArray(parsed) ? parsed.filter((folder): folder is CanvasFolder => Boolean(folder && typeof folder.id === "string" && typeof folder.name === "string")).map((folder) => {
            const coverResourceId = typeof folder.coverResourceId === "string" ? folder.coverResourceId : undefined;
            const coverDataUrl = typeof folder.coverDataUrl === "string" && !isStaleProcessCoverUrl(folder.coverDataUrl) ? folder.coverDataUrl : undefined;
            return {
                ...folder,
                coverResourceId,
                coverDataUrl,
                unsaved: folder.unsaved === true ? true : undefined,
                saveError: typeof folder.saveError === "string" && folder.saveError ? folder.saveError : undefined,
            };
        }) : [];
    } catch {
        return [];
    }
}

function writeCanvasFolders(folders: CanvasFolder[]) {
    const persistable = usesBrowserLocalResourceStore()
        ? folders
        : folders.map((folder) => ({
            ...folder,
            coverDataUrl: folder.coverDataUrl?.startsWith("data:") ? undefined : folder.coverDataUrl,
        }));
    try {
        scopedLocalStorage.setItem(CANVAS_FOLDERS_KEY, JSON.stringify(persistable));
    } catch {
        // Pending folder intents and covers live in IndexedDB (canvas_folder_pending).
    }
}

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };

function cloneCanvasValue<T>(value: T): T {
    if (value == null) return value;
    try {
        return structuredClone(value);
    } catch {
        if (Array.isArray(value)) return [...value] as T;
        if (typeof value === "object") return { ...value } as T;
        return value;
    }
}

export type CanvasExternalRevisionConflict = {
    projectId: string;
    localRevision: number;
    remoteRevision: number;
    detectedAt: string;
    /** 被挡下的外部内容：保留为候选，用户选择「以最新为准」时使用它。 */
    candidate: CanvasProject;
};

type CanvasExternalRevisionState = {
    conflicts: Map<string, CanvasExternalRevisionConflict>;
    version: number;
};

const canvasExternalRevisionState: CanvasExternalRevisionState = { conflicts: new Map(), version: 0 };
const canvasExternalRevisionListeners = new Set<() => void>();

function canvasExternalRevisionKey(scope: string, projectId: string) {
    return `${scope}\0${projectId}`;
}

export function canvasExternalRevisionVersion() {
    return canvasExternalRevisionState.version;
}

export function subscribeCanvasExternalRevision(listener: () => void) {
    canvasExternalRevisionListeners.add(listener);
    return () => { canvasExternalRevisionListeners.delete(listener); };
}

function publishCanvasExternalRevision() {
    canvasExternalRevisionState.version += 1;
    for (const listener of [...canvasExternalRevisionListeners]) listener();
}

export function canvasExternalRevisionConflict(scope: string, projectId: string) {
    const key = canvasExternalRevisionKey(scope, projectId);
    const conflict = canvasExternalRevisionState.conflicts.get(key);
    if (!conflict) return undefined;
    const localRevision = useCanvasStore.getState().projects.find((project) => project.id === projectId)?.revision ?? 0;
    if (localRevision > conflict.remoteRevision) {
        canvasExternalRevisionState.conflicts.delete(key);
        return undefined;
    }
    return conflict;
}

export function clearCanvasExternalRevisionConflict(scope: string, projectId: string) {
    if (!canvasExternalRevisionState.conflicts.delete(canvasExternalRevisionKey(scope, projectId))) return;
    publishCanvasExternalRevision();
}

function markCanvasExternalRevisionConflict(scope: string, conflict: CanvasExternalRevisionConflict) {
    const key = canvasExternalRevisionKey(scope, conflict.projectId);
    const previous = canvasExternalRevisionState.conflicts.get(key);
    if (previous && previous.localRevision === conflict.localRevision && previous.remoteRevision === conflict.remoteRevision && sameCanvasDocument(previous.candidate, conflict.candidate)) return;
    canvasExternalRevisionState.conflicts.set(key, conflict);
    publishCanvasExternalRevision();
}

type ApplyExternalCanvasRevisionOptions = {
    scope?: string;
    hasUnsyncedEdits: boolean;
    onApplied?: (project: CanvasProject, previous: CanvasProject | undefined) => void;
};

export function applyExternalCanvasRevision(remote: CanvasProject, options: ApplyExternalCanvasRevisionOptions) {
    const scope = options.scope ?? getActiveUserScope();
    const previous = useCanvasStore.getState().projects.find((project) => project.id === remote.id)
        ?? canvasMemoryStates.get(scope)?.projects.find((project) => project.id === remote.id);
    return applyCanvasExternalDecision(scope, decideExternalCanvasRevision({
        remote,
        local: previous,
        hasLocalEdits: options.hasUnsyncedEdits,
    }), previous, options.onApplied);
}

export function acceptCanvasExternalRevisionCandidate(
    projectId: string,
    options: { scope?: string; onApplied?: (project: CanvasProject, previous: CanvasProject | undefined) => void } = {},
) {
    const scope = options.scope ?? getActiveUserScope();
    const conflict = canvasExternalRevisionState.conflicts.get(canvasExternalRevisionKey(scope, projectId));
    if (!conflict) return undefined;
    const previous = useCanvasStore.getState().projects.find((project) => project.id === projectId);
    return applyCanvasExternalDecision(scope, decideExternalCanvasRevision({
        remote: conflict.candidate,
        local: previous,
        hasLocalEdits: false,
    }), previous, options.onApplied);
}

function applyCanvasExternalDecision(
    scope: string,
    decision: ReturnType<typeof decideExternalCanvasRevision>,
    previous: CanvasProject | undefined,
    onApplied?: (project: CanvasProject, previous: CanvasProject | undefined) => void,
) {
    if (decision.kind === "keep-local") {
        markCanvasExternalRevisionConflict(scope, {
            projectId: decision.projectId,
            localRevision: decision.localRevision,
            remoteRevision: decision.remoteRevision,
            detectedAt: new Date().toISOString(),
            candidate: decision.candidate,
        });
        return decision;
    }
    const applied = decision.project;
    useCanvasStore.setState((state) => ({
        projects: state.projects.some((project) => project.id === applied.id)
            ? state.projects.map((project) => project.id === applied.id ? applied : project)
            : [...state.projects, applied],
    }));
    canvasMemoryStates.set(scope, { projects: useCanvasStore.getState().projects });
    clearCanvasExternalRevisionConflict(scope, applied.id);
    try {
        onApplied?.(applied, previous);
    } catch (error) {
        console.error("画布刷新通知失败", { id: applied.id, error });
    }
    return decision;
}

const canvasStorage = createCanvasPersistStorage<CanvasStore>();

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            folders: [],
            createProject: (title = "未命名画布", projectId, workspaceProjectId) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const appearanceDefault = readCanvasAppearanceDefault();
                const project: CanvasProject = {
                    id,
                    revision: 0,
                    workspaceProjectId: workspaceProjectId || id,
                    projectId,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    appearance: appearanceDefault?.appearance ?? { mode: "follow" },
                    backgroundMode: appearanceDefault?.backgroundMode || DEFAULT_CANVAS_BACKGROUND_MODE,
                    showImageInfo: false,
                    viewport: initialViewport,
                    directorScenes: [],
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            createFolder: (name = "未命名文件夹") => {
                const now = new Date().toISOString();
                const folder = { id: nanoid(), name: name.trim() || "未命名文件夹", createdAt: now, updatedAt: now };
                set((state) => {
                    const folders = [folder, ...state.folders];
                    writeCanvasFolders(folders);
                    return { folders };
                });
                return folder.id;
            },
            renameFolder: (id, name) => set((state) => {
                const nextName = name.trim();
                if (!nextName) return state;
                const folders = state.folders.map((folder) => folder.id === id ? { ...folder, name: nextName, updatedAt: new Date().toISOString() } : folder);
                writeCanvasFolders(folders);
                return { folders };
            }),
            deleteFolder: (id) => set((state) => {
                const folders = state.folders.filter((folder) => folder.id !== id);
                const projects = state.projects.map((project) => project.folderId === id ? { ...project, folderId: undefined, updatedAt: new Date().toISOString() } : project);
                writeCanvasFolders(folders);
                return { folders, projects };
            }),
            setFolderCover: (id, coverDataUrl) => set((state) => {
                const folders = state.folders.map((folder) => folder.id === id ? { ...folder, coverDataUrl, updatedAt: new Date().toISOString() } : folder);
                writeCanvasFolders(folders);
                return { folders };
            }),
            replaceFolders: (folders) => {
                writeCanvasFolders(folders);
                set({ folders });
            },
            moveProjectsToFolder: (ids, folderId) => set((state) => ({ projects: state.projects.map((project) => ids.includes(project.id) ? { ...project, folderId, updatedAt: new Date().toISOString() } : project) })),
            importProject: (source, workspaceProjectId) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    revision: 0,
                    workspaceProjectId: undefined,
                    projectId: source.projectId,
                    folderId: source.folderId,
                    title: source.title || "导入画布",
                    canvasTitle: source.canvasTitle,
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: cloneCanvasValue(source.nodes || []),
                    connections: cloneCanvasValue(source.connections || []),
                    chatSessions: cloneCanvasValue(source.chatSessions || []),
                    activeChatId: source.activeChatId || null,
                    starterMode: source.starterMode,
                    appearance: source.appearance ? normalizeCanvasAppearance(source.appearance, "dark") : undefined,
                    backgroundMode: source.backgroundMode || DEFAULT_CANVAS_BACKGROUND_MODE,
                    showImageInfo: source.showImageInfo || false,
                    viewport: cloneCanvasValue(source.viewport || initialViewport),
                    directorScenes: cloneCanvasValue(source.directorScenes || []),
                    timeline: source.timeline ? cloneCanvasValue(source.timeline) : undefined,
                };
                project.workspaceProjectId = workspaceProjectId || project.id;
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) => set((state) => {
                const current = state.projects.find((project) => project.id === id);
                const nextTitle = title.trim() || current?.title;
                if (!current || current.title === nextTitle) return state;
                return { projects: state.projects.map((project) => project === current ? { ...project, title: nextTitle!, updatedAt: new Date().toISOString() } : project) };
            }),
            deleteProjects: (ids) =>
                set((state) => {
                    ids.forEach((id) => { void localForageStorageForScope().removeItem(`beeftv-project-cover:${id}`); try { window.localStorage.removeItem(`beeftv-project-cover:${id}`); } catch { /* ignore */ } });
                    return { projects: state.projects.filter((project) => !ids.includes(project.id)) };
                }),
            restoreProject: (project) => set((state) => {
                if (state.projects.some((item) => item.id === project.id)) return state;
                return { projects: [project, ...state.projects] };
            }),
            replaceProjects: (projects) => set({ projects }),
            updateProject: (id, patch) => set((state) => {
                const current = state.projects.find((project) => project.id === id);
                if (!current) return state;
                const next = { ...current, ...patch };
                const contentChanged = !sameCanvasContent(current, next);
                if (!contentChanged && samePersistenceValue(current.viewport, next.viewport)) return state;
                if (patch.connections && current.connections.length !== patch.connections.length) traceCanvasGraph("store.updateProject", { previous: current, next });
                if (contentChanged) next.updatedAt = new Date().toISOString();
                return { projects: state.projects.map((project) => project === current ? next : project) };
            }),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            merge: (persisted, current) => {
                const persistedState = (persisted ?? {}) as Partial<CanvasStore>;
                const cachedProjects = persistedState.projects;
                if (!Array.isArray(cachedProjects) || cachedProjects.length === 0 || current.projects.length === 0) {
                    return { ...current, ...persistedState };
                }
                const appliedById = new Map(current.projects.map((project) => [project.id, project]));
                const seen = new Set<string>();
                const projects: CanvasProject[] = [];
                for (const project of cachedProjects) {
                    if (seen.has(project.id)) continue;
                    seen.add(project.id);
                    const applied = appliedById.get(project.id);
                    projects.push(applied && (project.revision ?? 0) < (applied.revision ?? 0) ? applied : project);
                }
                for (const project of current.projects) {
                    if (!seen.has(project.id)) {
                        seen.add(project.id);
                        projects.push(project);
                    }
                }
                return { ...current, ...persistedState, projects };
            },
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ folders: readCanvasFolders(), hydrated: true });
            },
        },
    ),
);
