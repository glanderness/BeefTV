import { expect, test } from "bun:test";

import { normalizeCanvasProjectGraph } from "../src/lib/canvas/canvas-content";
import { mergeCanvasStorageProjects, parseCanvasStorageDocument } from "../src/lib/canvas/canvas-storage-revision";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";

test("loads older canvas records without node arrays so later persistence can continue", () => {
    const document = parseCanvasStorageDocument(JSON.stringify({
        state: {
            projects: [{ id: "legacy-canvas", title: "Legacy canvas" }],
        },
    }));

    expect(document.state.projects).toHaveLength(1);
    expect(document.state.projects[0].title).toBe("Legacy canvas");
    expect(document.state.projects[0].nodes).toEqual([]);
    expect(document.state.projects[0].connections).toEqual([]);
    expect(document.state.projects[0].chatSessions).toEqual([]);
});

test("fills missing messages array on stored chat sessions so legacy records remain readable", () => {
    const document = parseCanvasStorageDocument(JSON.stringify({
        state: {
            projects: [{
                id: "legacy-chat",
                title: "Legacy chat",
                nodes: [],
                connections: [],
                chatSessions: [{ id: "s1", title: "对话" }],
            }],
        },
        storageRevision: 3,
        tombstones: { projects: { old: 1 }, nodes: {}, connections: {}, sessions: {}, messages: {} },
    }));

    expect(document.storageRevision).toBe(3);
    expect(document.deletedProjectIds).toEqual({ old: 1 });
    expect(document.state.projects[0].chatSessions).toHaveLength(1);
    expect(document.state.projects[0].chatSessions[0].messages).toEqual([]);
});

test("normalizes backend canvas payloads missing nodes, connections, and viewport", () => {
    const normalized = normalizeCanvasProjectGraph({
        id: "external-minimal",
        title: "External minimal",
        createdAt: "2026-11-07T00:00:00Z",
        updatedAt: "2026-11-07T00:00:00Z",
        viewport: { x: 0, y: 0, k: 0 },
    } as never);

    expect(normalized.nodes).toEqual([]);
    expect(normalized.connections).toEqual([]);
    expect(normalized.viewport).toEqual({ x: 0, y: 0, k: 1 });
});

function makeProject(id: string, title: string): CanvasProject {
    return {
        id,
        title,
        createdAt: "2026-11-07T00:00:00Z",
        updatedAt: "2026-11-07T00:00:00Z",
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
}

test("project-level cross-tab merge preserves concurrent edits and additions without resurrecting deleted canvases", () => {
    const c1 = makeProject("c1", "画布 1");
    const c2 = makeProject("c2", "画布 2");
    const c3 = makeProject("c3", "将被删除");
    const initial = {
        state: { projects: [c1, c2, c3] },
        version: 0,
        storageRevision: 1,
        deletedProjectIds: {},
    };

    // Tab B edits c2, deletes c3, and adds c4.
    const c2TabB = { ...c2, title: "Tab B 改名" };
    const c4TabB = makeProject("c4", "Tab B 新建");
    const afterTabB = mergeCanvasStorageProjects({
        durable: initial,
        baseProjects: [c1, c2, c3],
        localProjects: [c1, c2TabB, c4TabB],
        baseRevision: 1,
    });
    expect(afterTabB.document.storageRevision).toBe(2);
    expect(afterTabB.document.deletedProjectIds?.c3).toBe(2);
    expect(afterTabB.document.state.projects.map((p) => p.id)).toEqual(["c1", "c2", "c4"]);

    // Stale Tab A (hydrated at revision 1, still holding c3 in memory) edits c1 and commits.
    const c1TabA = { ...c1, title: "Tab A 改名" };
    const afterTabAFirst = mergeCanvasStorageProjects({
        durable: afterTabB.document,
        baseProjects: [c1, c2, c3],
        localProjects: [c1TabA, c2, c3],
        baseRevision: 1,
    });
    expect(afterTabAFirst.droppedDeletedIds).toEqual(["c3"]);
    expect(afterTabAFirst.document.state.projects.map((p) => `${p.id}:${p.title}`)).toEqual([
        "c1:Tab A 改名",
        "c2:Tab B 改名",
        "c4:Tab B 新建",
    ]);

    // A second commit from Tab A (still holding c3 in React memory, whose local baseline is its previous localProjects) must still keep c3 deleted and preserve Tab B's c2 & c4.
    const c1TabASecond = { ...c1, title: "Tab A 二次改名" };
    const afterTabASecond = mergeCanvasStorageProjects({
        durable: afterTabAFirst.document,
        baseProjects: [c1TabA, c2, c3],
        localProjects: [c1TabASecond, c2, c3],
        baseRevision: afterTabAFirst.document.storageRevision,
        ignoredDeletedIds: new Set(afterTabAFirst.droppedDeletedIds),
    });
    expect(afterTabASecond.document.state.projects.map((p) => `${p.id}:${p.title}`)).toEqual([
        "c1:Tab A 二次改名",
        "c2:Tab B 改名",
        "c4:Tab B 新建",
    ]);
});

test("viewport-only cache writes preserve another tab's newer document edits on the same canvas", () => {
    const c1Base = makeProject("c1", "初始标题");
    const initial = {
        state: { projects: [c1Base] },
        version: 0,
        storageRevision: 1,
        deletedProjectIds: {},
    };

    // Tab B edits c1's title and adds a node.
    const c1TabB: CanvasProject = {
        ...c1Base,
        title: "Tab B 改了内容",
        nodes: [{ id: "n-from-b", type: "text" as never, title: "新节点", position: { x: 10, y: 20 }, width: 200, height: 120 }],
    };
    const afterTabB = mergeCanvasStorageProjects({
        durable: initial,
        baseProjects: [c1Base],
        localProjects: [c1TabB],
        baseRevision: 1,
    });

    // Tab A only pans/zooms viewport and toggles showImageInfo on c1 (no content edits).
    const c1TabAViewportOnly: CanvasProject = {
        ...c1Base,
        viewport: { x: 320, y: -140, k: 0.65 },
        showImageInfo: true,
    };
    const afterTabA = mergeCanvasStorageProjects({
        durable: afterTabB.document,
        baseProjects: [c1Base],
        localProjects: [c1TabAViewportOnly],
        baseRevision: 1,
    });

    const merged = afterTabA.document.state.projects[0]!;
    expect(merged.title).toBe("Tab B 改了内容");
    expect(merged.nodes.map((node) => node.id)).toEqual(["n-from-b"]);
    expect(merged.viewport).toEqual({ x: 320, y: -140, k: 0.65 });
    expect(merged.showImageInfo).toBe(true);
});
