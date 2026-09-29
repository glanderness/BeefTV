import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type Project = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    revision?: number;
    nodes: Array<{ id: string }>;
    connections: unknown[];
    chatSessions: unknown[];
    activeChatId: null;
    backgroundMode: "grid";
    showImageInfo: boolean;
    viewport: { x: number; y: number; k: number };
    directorScenes: unknown[];
};

const dir = mkdtempSync(join(import.meta.dir, ".local-workspace-stale-"));
const repositorySource = readFileSync(new URL("../src/services/local-workspace-repository.ts", import.meta.url), "utf8");
const storePath = join(dir, "store.ts");
const historyPath = join(dir, "history.ts");
const requestPath = join(dir, "request.ts");
// 画布刷新接缝引入了跨模块依赖；这个用例只关心「陈旧后端不覆盖较新本地内容」，
// 因此把与判据无关的边界替换成最薄替身，而不是让它们把浏览器 API 拉进用例。
const syncStubPath = join(dir, "local-workspace-sync.ts");
const conflictStubPath = join(dir, "canvas-revision-conflict.ts");
const assetStubPath = join(dir, "use-asset-store.ts");
const modeStubPath = join(dir, "workspace-mode.ts");
const resourcesStubPath = join(dir, "api-resources.ts");
const userScopeStubPath = join(dir, "user-scope.ts");
const canvasContentStubPath = join(dir, "canvas-content.ts");

writeFileSync(storePath, `
export type CanvasProject = any;
export let projects: any[] = [];
export const resetProjects = (next: any[]) => { projects = next; };
const getState = () => ({
  projects,
  openProject: (id: string) => projects.find((project) => project.id === id) ?? null,
  createProject: () => "unused",
  updateProject: () => {},
  deleteProjects: () => {},
});
export const useCanvasStore = {
  getState,
  setState: (update: any) => {
    const patch = typeof update === "function" ? update(getState()) : update;
    if (patch.projects) projects = patch.projects;
  },
};
export const flushCanvasStorePersistence = async () => {};
export const applyExternalCanvasRevision = (remote: any, options: any) => {
  const local = projects.find((project: any) => project.id === remote.id);
  if (options?.hasUnsyncedEdits) {
    return { kind: "keep-local", projectId: remote.id, candidate: remote, localRevision: local?.revision ?? 0, remoteRevision: remote.revision ?? 0 };
  }
  const merged = local ? { ...remote, viewport: local.viewport } : remote;
  projects = projects.some((project: any) => project.id === merged.id)
    ? projects.map((project: any) => project.id === merged.id ? merged : project)
    : [...projects, merged];
  options?.onApplied?.(merged, local);
  return { kind: "apply", project: merged, localRevision: local?.revision ?? 0, remoteRevision: merged.revision ?? 0 };
};
export const acceptCanvasExternalRevisionCandidate = () => undefined;
export const canvasDurableSnapshot = () => undefined;
export const canvasExternalRevisionConflict = () => undefined;
export const canvasExternalRevisionVersion = () => 0;
export const subscribeCanvasExternalRevision = () => () => {};
`);
writeFileSync(historyPath, "export const useCanvasHistoryStore = { getState: () => ({ recordDeletedProjects: () => {} }) };\n");
writeFileSync(syncStubPath, "export const notifyCanvasRefresh = () => {};\n");
writeFileSync(conflictStubPath, `
export const isCanvasRevisionConflict = () => false;
export const canvasBackendSubmitPaused = () => false;
export const resumeCanvasBackendSubmit = () => {};
export const handleRejectedCanvasBackendSave = async () => false;
`);
writeFileSync(assetStubPath, "export const useAssetStore = { getState: () => ({ assets: [] }) };\n");
writeFileSync(modeStubPath, "export const isLocalWorkspaceMode = () => true;\n");
writeFileSync(resourcesStubPath, "export const resourceIdFromStorageKey = () => '';\n");
writeFileSync(userScopeStubPath, "export const getActiveUserScope = () => 'guest';\n");
writeFileSync(canvasContentStubPath, "export const sameCanvasDocument = () => true;\n");
writeFileSync(requestPath, `
export let remoteProject: any;
export let remoteProjects: any[] = [];
export const setRemoteProject = (next: any) => { remoteProject = next; remoteProjects = next ? [{ id: next.id }] : []; };
export const http = { get: async (path: string) => path === "/canvas-projects" ? { projects: remoteProjects } : { project: remoteProject } };
`);
writeFileSync(join(dir, "repository.ts"), repositorySource
    .replace('"@/stores/canvas/use-canvas-store"', JSON.stringify(pathToFileURL(storePath).href))
    .replace('"@/stores/canvas/use-canvas-history-store"', JSON.stringify(pathToFileURL(historyPath).href))
    .replace('"@/services/api/request"', JSON.stringify(pathToFileURL(requestPath).href))
    .replace('"@/services/local-workspace-sync"', JSON.stringify(pathToFileURL(syncStubPath).href))
    .replace('"@/services/canvas-revision-conflict"', JSON.stringify(pathToFileURL(conflictStubPath).href))
    .replace('"@/stores/use-asset-store"', JSON.stringify(pathToFileURL(assetStubPath).href))
    .replace('"@/services/workspace-mode"', JSON.stringify(pathToFileURL(modeStubPath).href))
    .replace('"@/lib/user-scope"', JSON.stringify(pathToFileURL(userScopeStubPath).href))
    .replace('"@/lib/canvas/canvas-content"', JSON.stringify(pathToFileURL(canvasContentStubPath).href))
    .replace('"@/services/api/resources"', JSON.stringify(pathToFileURL(resourcesStubPath).href)));

const repository: typeof import("../src/services/local-workspace-repository") = await import(join(dir, "repository.ts"));
const store = await import(storePath);
const request = await import(requestPath);

const project = (overrides: Partial<Project> = {}): Project => ({
    id: "canvas-a",
    title: "画布 A",
    createdAt: "2026-09-22T08:00:00.000Z",
    updatedAt: "2026-09-22T08:00:00.000Z",
    revision: 0,
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "grid",
    showImageInfo: true,
    viewport: { x: 0, y: 0, k: 1 },
    directorScenes: [],
    ...overrides,
});

beforeEach(() => {
    store.resetProjects([]);
    request.setRemoteProject(undefined);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("local workspace stale backend protection", () => {
    it("keeps newer local canvas content when opening an older backend snapshot", async () => {
        const local = project({ updatedAt: "2026-09-22T09:00:00.000Z", nodes: [{ id: "kept-node" }] });
        const staleRemote = project({ updatedAt: "2026-09-22T08:00:00.000Z", nodes: [] });
        store.resetProjects([local]);
        request.setRemoteProject(staleRemote);

        expect(await repository.openLocalCanvasProjectFromBackend(local.id)).toEqual(local);
        expect(store.projects[0].nodes).toEqual([{ id: "kept-node" }]);
    });

    it("keeps newer local canvas content during backend hydration", async () => {
        const local = project({ updatedAt: "2026-09-22T09:00:00.000Z", nodes: [{ id: "kept-node" }] });
        const staleRemote = project({ updatedAt: "2026-09-22T08:00:00.000Z", nodes: [] });
        store.resetProjects([local]);
        request.setRemoteProject(staleRemote);

        await repository.hydrateLocalCanvasProjectsFromBackend();
        expect(store.projects[0].nodes).toEqual([{ id: "kept-node" }]);
    });

    it("accepts a genuinely newer backend snapshot", async () => {
        const local = project({ updatedAt: "2026-09-22T08:00:00.000Z", nodes: [] });
        const remote = project({ updatedAt: "2026-09-22T09:00:00.000Z", revision: 1, nodes: [{ id: "remote-node" }] });
        store.resetProjects([local]);
        request.setRemoteProject(remote);

        expect(await repository.openLocalCanvasProjectFromBackend(local.id)).toEqual(remote);
        expect(store.projects[0].nodes).toEqual([{ id: "remote-node" }]);
    });
});
