import { expect, test } from "bun:test";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { buildGenerationConfig, buildVideoGenerationMetadata } from "@/lib/canvas/canvas-project-generation";
import { parseBackendGenerationResult } from "@/services/api/generation-task";
import { projectGenerationTaskResult } from "@/services/project-asset-sync";
import { addGenerationOutputNodes, generationOutputMetadata } from "@/lib/canvas/canvas-generation-outputs";
import { canvasWorkflowInputError, workflowSlotReference } from "@/lib/canvas/canvas-workflow-inputs";
import { buildGenerationTaskNodeResult } from "@/lib/canvas/canvas-generation-task-sync";
import { bindBackendCanvasGenerationResult } from "@/services/canvas-generation-consumer";
import { materializedCanvasGenerationOutputs } from "@/services/canvas-generation-outputs";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { GenerationOutput } from "@/lib/generation-outputs";
import type { GenerationTask } from "@/services/api/task-center";

const outputs: GenerationOutput[] = [
    { id: "output:0", outputIndex: 0, mediaType: "image", dataUrl: "/api/resources/preview/file", storageKey: "resource:preview", width: 800, height: 600 },
    { id: "output:1", outputIndex: 1, mediaType: "video", dataUrl: "/api/resources/a/file", storageKey: "resource:a" },
    { id: "output:2", outputIndex: 2, mediaType: "video", dataUrl: "/api/resources/b/file", storageKey: "resource:b" },
    { id: "output:3", outputIndex: 3, mediaType: "audio", dataUrl: "/api/resources/sound/file", storageKey: "resource:sound" },
    { id: "output:4", outputIndex: 4, mediaType: "file", dataUrl: "/api/resources/meta/file", storageKey: "resource:meta" },
].map((output, index) => ({ ...output, assetId: `asset-${index}` })) as GenerationOutput[];
const node: CanvasNodeData = { id: "video-generator", type: CanvasNodeType.Video, title: "镜头", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { workflowProvider: "runninghub", runningHubWorkflowId: "video-flow", runningHubWorkflowKind: "workflow", workflowParameters: { "field:8:steps": 16 }, generationOutputTaskId: "task-mixed", generationOutputs: outputs } };
const task = { id: "task-mixed", type: "canvas_video", status: "succeeded", resultJson: JSON.stringify({ outputs }), outputs: outputs.map((output) => ({ outputIndex: output.outputIndex, mediaType: output.mediaType, resourceId: output.storageKey?.slice(9), materializedAssetId: `asset-${output.outputIndex}` })) } as GenerationTask;

test("ordinary video node reads saved workflow and scoped parameter overrides", () => {
    const config: AiConfig = { ...defaultConfig, runningHub: { ...defaultConfig.runningHub, enabled: true, apiKey: "test", workflows: [{ workflowId: "video-flow", kind: "workflow", capability: "video", fields: [{ nodeId: "8", fieldName: "steps", fieldType: "NUMBER", enabled: true, value: 10 }] }] } };
    const selected = buildGenerationConfig(config, node, "video");
    expect(selected.taskWorkflowProvider).toBe("runninghub");
    expect(selected.model).toBe("video-flow");
    expect(selected.runningHub.workflowId).toBe("video-flow");
    expect(selected.runningHub.workflows[0].fields?.[0].fieldValue).toBe(16);
    const frames = buildVideoGenerationMetadata({ ...node, metadata: { ...node.metadata, videoStartFrameNodeId: "deleted-frame" } }, { referenceImages: [], referenceVideos: [], referenceAudios: [] }, selected);
    expect(frames.videoStartFrameNodeId).toBeUndefined();
    expect(buildGenerationConfig(config, { ...node, metadata: { workflowProvider: "model" } }, "video").taskWorkflowProvider).toBe("model");
});

test("mixed output projection keeps every stable index and derives first video for video consumers", () => {
    const result = parseBackendGenerationResult(task);
    expect(result.outputs).toHaveLength(5);
    expect(result.video?.storageKey).toBe("resource:a");
    expect(result.audio?.storageKey).toBe("resource:sound");
    expect(projectGenerationTaskResult(task).outputs?.map((item) => [item.outputIndex, item.mediaType, item.materializedAssetId])).toEqual(outputs.map((item) => [item.outputIndex, item.mediaType, `asset-${item.outputIndex}`]));
});

test("expanding stored workflow results preserves resources and creates each media node once", () => {
    const expanded = addGenerationOutputNodes([node], node, outputs);
    expect(expanded).toHaveLength(5);
    expect(expanded.slice(1).map((item) => item.type)).toEqual([CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Video, CanvasNodeType.Audio]);
    expect(addGenerationOutputNodes(expanded, node, outputs)).toBe(expanded);
    expect(expanded[1].width / expanded[1].height).toBeCloseTo(800 / 600);
    expect(expanded[2].metadata?.storageKey).toBe("resource:a");
    expect(expanded[2].metadata?.assetId).toBe("asset-1");
    expect(expanded[2].metadata?.workflowProvider).toBe("model");
    expect(generationOutputMetadata(outputs[2]).content).toBe("/api/resources/b/file");
    expect(node.metadata?.primaryOutputId).toBeUndefined();
});

test("result actions use the canonical asset for each output and fail before changing the canvas if undelivered", () => {
    const stale = outputs.map((output) => ({ ...output, assetId: "wrong-parent-asset" }));
    const delivered = materializedCanvasGenerationOutputs(task, stale);
    expect(delivered.map((output) => output.assetId)).toEqual(["asset-0", "asset-1", "asset-2", "asset-3"]);
    const expanded = addGenerationOutputNodes([node], node, delivered);
    const restored = JSON.parse(JSON.stringify(expanded)) as CanvasNodeData[];
    expect(restored.slice(1).map((item) => [item.metadata?.assetId, item.metadata?.storageKey])).toEqual(delivered.map((output) => [output.assetId, output.storageKey]));
    expect(() => materializedCanvasGenerationOutputs({ ...task, outputs: task.outputs?.map((item) => ({ ...item, materializedAssetId: undefined })) }, stale)).toThrow("尚未就绪");
    expect(() => materializedCanvasGenerationOutputs(task, [{ ...outputs[1], storageKey: "resource:foreign" }])).toThrow("发生变化");
    expect(() => generationOutputMetadata({ ...outputs[1], assetId: undefined })).toThrow("尚未就绪");
});

test("repeated primary selection swaps the asset and resource together including A to B to A", () => {
    let current = node;
    for (const selection of [outputs[1], outputs[2], outputs[1]]) {
        const [output] = materializedCanvasGenerationOutputs(task, [selection]);
        current = { ...current, metadata: { ...current.metadata, ...generationOutputMetadata(output) } };
        current = JSON.parse(JSON.stringify(current));
        expect(current.metadata?.assetId).toBe(`asset-${selection.outputIndex}`);
        expect(current.metadata?.storageKey).toBe(selection.storageKey);
        expect(current.metadata?.primaryOutputId).toBe(selection.id);
        expect(current.metadata?.generationOutputs).toHaveLength(5);
    }
});

test("retrying add repairs an old result node without moving or renaming it", () => {
    const expanded = addGenerationOutputNodes([node], node, [outputs[1]]);
    const old = { ...expanded[1], title: "自定义标题", position: { x: 1000, y: 500 }, metadata: { ...expanded[1].metadata, assetId: undefined } };
    const repaired = addGenerationOutputNodes([node, old], node, [outputs[1]]);
    expect(repaired).toHaveLength(2);
    expect(repaired[1].metadata?.assetId).toBe("asset-1");
    expect(repaired[1].title).toBe(old.title);
    expect(repaired[1].position).toEqual(old.position);
    expect(addGenerationOutputNodes(repaired, node, [outputs[1]])).toBe(repaired);
});

test("separate output additions and partial batch expansion avoid existing and moved nodes", () => {
    const blocker = { ...node, id: "unrelated", position: { x: node.width + 64, y: 0 }, width: 450, height: 240 };
    let expanded = addGenerationOutputNodes([node, blocker], node, [outputs[1]]);
    const first = expanded.at(-1)!;
    expanded = expanded.map((item) => item.id === first.id ? { ...item, position: { x: 384, y: 400 } } : item);
    expanded = addGenerationOutputNodes(expanded, node, [outputs[2]]);
    expanded = addGenerationOutputNodes(expanded, node, outputs);
    expect(expanded).toHaveLength(6);
    for (let i = 0; i < expanded.length; i++) {
        for (let j = i + 1; j < expanded.length; j++) {
            const a = expanded[i], b = expanded[j];
            const overlaps = a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x
                && a.position.y < b.position.y + b.height && a.position.y + a.height > b.position.y;
            expect(overlaps).toBe(false);
        }
    }
    expect(expanded.find((item) => item.id === first.id)?.position).toEqual({ x: 384, y: 400 });
    expect(addGenerationOutputNodes(expanded, node, outputs)).toBe(expanded);
});

test("slot labels and required input validation follow the saved media order", () => {
    const field = { nodeId:"4",fieldName:"image",source:"referenceImage",sourceIndex:1,enabled:true,required:true,label:"角色参考" };
    const references = [{id:"a",nodeId:"a",kind:"image" as const,title:"参考 A",label:"图片1",active:true},{id:"b",nodeId:"b",kind:"image" as const,title:"参考 B",label:"图片2",active:true}];
    expect(workflowSlotReference(field,references)?.title).toBe("参考 B");
    expect(canvasWorkflowInputError([field],references.slice(0,1),{})).toContain("角色参考");
    expect(canvasWorkflowInputError([field],references,{})).toBe("");
    expect(canvasWorkflowInputError([{...field,enabled:false}],[],{})).toBe("");
});

test("workflow with only other output types keeps a result list and clears the old preview", async () => {
    const recovered = await buildGenerationTaskNodeResult({...node,metadata:{...node.metadata,content:"old-video",storageKey:"resource:old"}},{...task,resultJson:JSON.stringify({outputs:[outputs[0],outputs[4]]})});
    expect(recovered.type).toBe(CanvasNodeType.Video);
    expect(recovered.metadata?.content).toBeUndefined();
    expect(recovered.metadata?.generationOutputs).toHaveLength(2);
    expect(recovered.metadata?.status).toBe("success");
    expect(recovered.metadata?.outputParameterWarning).toContain("结果列表");
});

test("durable canvas binding selects first matching video and preserves a chosen output on reread", async () => {
    const indices: number[] = [];
    for (const primaryOutputId of [undefined,"output:2"]) {
        await bindBackendCanvasGenerationResult({
            canvasId:"canvas-output-binding-test",nodeId:node.id,task,isCurrent:()=>true,
            nodesRef:{current:[{...node,metadata:{...node.metadata,primaryOutputId}}]},setNodes:()=>{},
            runtime:{
                captureScope:()=>({userScope:"workflow-test",epoch:1}),liveScope:()=>({userScope:"workflow-test",epoch:1}),
                hydrateOutputs:async()=>{},persistDocument:async()=>{},adoptConfirmedProjection:async()=>null,
                bindOutput:async(input)=>{
                    indices.push(input.outputIndex);
                    expect(input.operationId).toBe(`attach-node:${task.id}:${node.id}:${input.outputIndex}`);
                    return {op:"canvas.task.bind",replayed:false,result:{bindingStatus:"bound",revision:1,canvas:{id:"canvas-output-binding-test",nodes:[],connections:[]}}};
                },
            },
        });
    }
    expect(indices).toEqual([1,2]);
});
