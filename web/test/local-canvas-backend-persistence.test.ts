import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repository = readFileSync(resolve(import.meta.dir, "../src/services/local-workspace-repository.ts"), "utf8");
const lifecycle = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-project-lifecycle.ts"), "utf8");

test("desktop local canvas creation is durable in the Go repository before navigation", () => {
    const sync = repository.indexOf("await syncLocalCanvasProject(id, false, expected);");
    const returned = repository.indexOf("return { id };");
    expect(sync).toBeGreaterThan(-1);
    expect(returned).toBeGreaterThan(sync);
    expect(repository.slice(0, sync)).not.toContain("await flushCanvasStorePersistence();");
});

test("local canvas edits schedule and explicit saves await backend persistence", () => {
    expect(lifecycle).toContain("if (localMode) scheduleLocalCanvasBackendSync(projectId);");
    expect(lifecycle).toContain("if (localMode) await syncLocalCanvasProjectToBackend(projectId);");
    expect(repository).toContain("const backendSaveTails = new Map<string, Promise<void>>()");
    expect(repository).toContain("commitCanvasDocument");
});

test("canvas save summary never replaces the full node document", () => {
    expect(repository).toContain("type CanvasSaveSummary = Pick<CanvasProject");
    expect(repository).not.toContain("current.updatedAt === project.updatedAt ? saved");
    expect(repository).toContain("revision: saved.revision");
});

test("local canvas deletion removes the canonical backend record", () => {
    expect(repository).toContain("await http.delete(`/canvas-projects/${encodeURIComponent(id)}`, { expectedScope: expected })");
});
