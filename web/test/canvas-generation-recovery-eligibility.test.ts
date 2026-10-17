import { expect, test } from "bun:test";
import { canvasNodeNeedsGenerationRecovery, consumeGenerationRecoveryRestore, isGenerationRecoveryRestored, resetInterruptedGeneration } from "@/lib/canvas/canvas-project-generation";
import { normalizeCanvasMediaNodeSemanticsList } from "@/lib/canvas/canvas-node-semantics";
import { proposalCanvasContent } from "@/pages/canvas/canvas-assistant-proposal-snapshot";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

const node = (id: string, metadata?: CanvasNodeMetadata, type = CanvasNodeType.Image): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 320, metadata });

const recoverable: Array<[string, CanvasNodeData]> = [
    ["loading without a task", node("loading", { status: "loading" })],
    ["loading with a task", node("loading-task", { status: "loading", taskId: "t1" })],
    ["failed with a task", node("error-task", { status: "error", taskId: "t2", taskStatus: "failed" })],
    ["succeeded without content", node("empty", { status: "success", taskId: "t3", taskStatus: "succeeded" })],
    ["pending agent continuation", node("continuation", { status: "success", content: "/c", agentGenerationContinuation: { id: "c", taskId: "t4", status: "pending" } })],
    ["older interrupted node", node("legacy", { status: "error", errorDetails: "页面刷新后生成已中断，请重新生成。" })],
];
const settled: Array<[string, CanvasNodeData]> = [
    ["finished with content", node("done", { status: "success", taskId: "t5", taskStatus: "succeeded", content: "/x", storageKey: "resource:x" })],
    ["upload in progress", node("upload", { fileUpload: "uploading", fileUploadProgress: 30 })],
    ["aggregate batch root", node("root", { status: "loading", isBatchRoot: true, batchChildIds: ["a", "b"] })],
    ["plain error without a task", node("plain-error", { status: "error", errorDetails: "生成失败" })],
    ["no metadata", node("empty-meta")],
];

for (const [label, item] of recoverable) test(`recovery covers: ${label}`, () => {
    expect(canvasNodeNeedsGenerationRecovery(item)).toBe(true);
});
for (const [label, item] of settled) test(`recovery skips: ${label}`, () => {
    expect(canvasNodeNeedsGenerationRecovery(item)).toBe(false);
});

test("restoring a snapshot hands exactly the recoverable nodes to recovery", () => {
    const restored = resetInterruptedGeneration([...recoverable, ...settled].map(([, item]) => item));
    for (const item of restored) expect(isGenerationRecoveryRestored(item)).toBe(canvasNodeNeedsGenerationRecovery(item));
    // The visible restore text stays as before; it is not the control signal.
    expect(restored.find((item) => item.id === "loading")?.metadata?.errorDetails).toBe("正在从任务中心恢复生成状态...");
});

test("the restore record survives the load normalization and is handed out once, in every copy", () => {
    const [restored] = normalizeCanvasMediaNodeSemanticsList(resetInterruptedGeneration([node("video", { status: "loading", taskId: "t6" }, CanvasNodeType.Video)]));
    expect(isGenerationRecoveryRestored(restored)).toBe(true);
    const copy = { ...restored, metadata: { ...restored.metadata, taskProgress: 10 } };
    consumeGenerationRecoveryRestore([restored]);
    expect(isGenerationRecoveryRestored(restored)).toBe(false);
    expect(isGenerationRecoveryRestored(copy)).toBe(false);
});

test("nodes that did not come from a restore are never treated as restored", () => {
    const live = node("live", { status: "loading" });
    expect(isGenerationRecoveryRestored(live)).toBe(false);
    // The proposal check runs the same restore step on the live nodes; that must not mark them.
    proposalCanvasContent([live], []);
    expect(isGenerationRecoveryRestored(live)).toBe(false);
    // A saved or cloned copy (what a refresh brings back) carries no record.
    const [restored] = resetInterruptedGeneration([node("saved", { status: "loading", taskId: "t7" })]);
    expect(isGenerationRecoveryRestored(JSON.parse(JSON.stringify(restored)))).toBe(false);
    expect(isGenerationRecoveryRestored(structuredClone(restored))).toBe(false);
});

test("the restore record adds nothing to the saved node", () => {
    const source = node("pending", { status: "error", taskId: "t8", taskStatus: "failed" });
    const [restored] = resetInterruptedGeneration([source]);
    expect(isGenerationRecoveryRestored(restored)).toBe(true);
    expect(Object.keys(restored.metadata!)).toEqual(Object.keys(source.metadata!));
    expect(JSON.stringify(restored.metadata)).toBe(JSON.stringify(source.metadata));
    expect(proposalCanvasContent([restored], [])).toBe(proposalCanvasContent([source], []));
});
