import { expect, test } from "bun:test";
import { canConvertCanvasVideoDraft, resolveCanvasVideoDraftSource } from "@/lib/canvas/canvas-video-draft";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

const node: CanvasNodeData = {
    id: "draft-node", type: CanvasNodeType.Video, title: "既有样片", position: { x: 0, y: 0 }, width: 640, height: 360,
    metadata: { draft: "true", status: "success", storageKey: "resource:draft", taskId: "local-task", model: "beeftv::seedance-2.5" },
};
const task: GenerationTask = {
    id: "local-task", projectId: "canvas", type: "canvas_video", status: "succeeded",
    model: "beeftv::seedance-2.5", providerRequestId: "remote-draft", prompt: "", attempts: 1, createdAt: "", updatedAt: "",
};

test("a completed stored draft exposes conversion and recovers its original remote reference", async () => {
    expect(canConvertCanvasVideoDraft(node)).toBe(true);
    const calls: string[] = [];
    const source = await resolveCanvasVideoDraftSource(node, "canvas", async (id) => {
        calls.push(id);
        return task;
    });
    expect(calls).toEqual(["local-task"]);
    expect(source).toEqual({ providerRequestId: "remote-draft", model: task.model });
});

test("conversion cannot use a foreign, unfinished or mismatched task", async () => {
    for (const invalid of [{ ...task, projectId: "foreign" }, { ...task, id: "other" }, { ...task, status: "running" as const }]) {
        expect(await resolveCanvasVideoDraftSource(node, "canvas", async () => invalid)).toBeUndefined();
    }
    expect(canConvertCanvasVideoDraft({ ...node, metadata: { ...node.metadata, draft: "false" } })).toBe(false);
});
