import { describe, expect, test } from "bun:test";

import { rebaseCanvasDocumentThreeWay, settleInFlightGenerationOverlay } from "../src/lib/canvas/canvas-document-rebase";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function node(id: string, title: string, metadata: CanvasNodeData["metadata"] = {}, position = { x: 0, y: 0 }): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title, position, width: 320, height: 220, metadata };
}

function project(nodes: CanvasNodeData[], revision: number, title = "画布"): CanvasProject {
    return {
        id: "c1",
        revision,
        title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes,
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
}

describe("settleInFlightGenerationOverlay", () => {
    test("in-flight loading overlay adopts remote success and keeps Agent sibling nodes", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", prompt: "猫" });
        const camp = node("node-camp", "秋日旅行·露营桌", { status: "idle" }, { x: 80, y: 40 });
        const lake = node("node-lake", "秋日旅行·湖畔横移", { status: "idle" }, { x: 160, y: 40 });
        const base = project([original, camp, lake], 10);
        const local = project([
            { ...original, metadata: { taskId: "task-1", status: "loading", taskStatus: "running", taskProgress: 42, taskStage: "出图中", prompt: "猫" } },
            camp,
            lake,
        ], 10);
        const remote = project([
            { ...original, metadata: { taskId: "task-1", status: "success", taskStatus: "succeeded", taskProgress: 100, content: "https://media/gen", storageKey: "res-gen", prompt: "猫" } },
            camp,
            lake,
        ], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes.map((item) => item.id)).toEqual(["image-origin", "node-camp", "node-lake"]);
        expect(rebased.project.nodes[0]?.metadata?.status).toBe("success");
        expect(rebased.project.nodes[0]?.metadata?.content).toBe("https://media/gen");
        expect(rebased.project.nodes[1]?.title).toBe("秋日旅行·露营桌");
        expect(rebased.project.nodes[2]?.title).toBe("秋日旅行·湖畔横移");
    });

    test("same-field human content edit keeps local value and remains a recoverable conflict", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", content: "旧图" });
        const base = project([original], 10);
        const local = project([{ ...original, metadata: { taskId: "task-1", status: "loading", content: "人类改过的内容" } }], 10);
        const remote = project([{ ...original, metadata: { taskId: "task-1", status: "success", content: "https://media/gen", storageKey: "res-gen" } }], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]?.metadata?.content).toBe("人类改过的内容");
        expect(settled.nodes[0]?.metadata?.status).toBe("loading");
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(true);
        expect(rebased.project.nodes[0]?.metadata?.content).toBe("人类改过的内容");
        expect(rebased.project.nodes[0]?.metadata?.status).not.toBe("success");
    });
});
