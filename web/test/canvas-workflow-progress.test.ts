import { expect, test } from "bun:test";
import { workflowProgress } from "@/lib/canvas/workflow-progress";
import type { WorkflowDefinition, WorkflowRun } from "@/services/api/canvas-workflows";

const definition: WorkflowDefinition = { version: 1, nodes: [{ id: "input", title: "输入", role: "input", mediaType: "video" }, { id: "one", title: "步骤一", role: "operation", operationId: "video.replace-character", mediaType: "video" }, { id: "two", title: "步骤二", role: "operation", operationId: "video.frame-rate", mediaType: "video" }], edges: [], outputNodeIds: ["two"] };
test("workflow percentage includes real substep progress and excludes inputs", () => {
    const run = { status: "running", steps: [{ nodeId: "input", status: "succeeded" }, { nodeId: "one", status: "succeeded" }, { nodeId: "two", status: "running", progress: 40, stage: "正在合成并校验视频" }] } as WorkflowRun;
    expect(workflowProgress(definition, run)).toEqual({ percent: 70, stage: "正在合成并校验视频" });
    expect(workflowProgress(definition, run, true)).toEqual({ percent: 0, stage: "等待运行" });
});
test("workflow never claims full completion while running or shows stale progress for new inputs", () => {
    const run = { status: "running", steps: [{ nodeId: "one", status: "succeeded" }, { nodeId: "two", status: "running", progress: 100 }] } as WorkflowRun;
    expect(workflowProgress(definition, run).percent).toBeLessThan(100);
    expect(workflowProgress(definition, { ...run, status: "succeeded" }).percent).toBe(100);
    expect(workflowProgress(definition, { ...run, status: "cancelled" }).stage).toBe("已停止处理");
    expect(workflowProgress(definition, { ...run, status: "failed" }).stage).toBe("处理失败");
    expect(workflowProgress(definition)).toEqual({ percent: 0, stage: "等待运行" });
});
