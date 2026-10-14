import { afterEach, expect, spyOn, test } from "bun:test";
import { buildNodeGenerationContext, hydrateNodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import { buildNodeMentionReferences, reorderCanvasResourceConnections } from "../src/lib/canvas/canvas-resource-references";
import { canvasWorkflowInputError, workflowSlotReference } from "../src/lib/canvas/canvas-workflow-inputs";
import { RUNNINGHUB_PLUGIN_ID } from "../src/lib/plugins/builtin/workflows";
import * as projects from "../src/services/api/projects";
import * as images from "../src/services/image-storage";
import { prepareBackendGenerationTask } from "../src/services/api/generation-task";
import { defaultConfig, type WorkflowFieldMapping } from "../src/stores/use-config-store";
import { usePluginStore } from "../src/stores/use-plugin-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../src/types/canvas";

afterEach(() => usePluginStore.getState().setRuntimeStatuses({}));

function fixture(workflow = true) {
    const node = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: `resource:${id}` } });
    const characterA = node("character-a");
    const characterC = node("character-c");
    for (const character of [characterA, characterC]) character.metadata = { workflowKind: "character", characterAssetId: character.id };
    const image = node("image-b");
    const target = { ...node("target"), type: CanvasNodeType.Video, metadata: workflow ? { workflowProvider: "runninghub" as const, runningHubWorkflowId: "workflow-id" } : {} };
    const nodes = [characterA, image, characterC, target];
    const connections: CanvasConnection[] = [characterA, image, characterC].map((source) => ({ id: `conn-${source.id}`, fromNodeId: source.id, toNodeId: target.id }));
    return { nodes, connections, target };
}

function mockCharacterMedia(missing = false) {
    const character = spyOn(projects, "getProjectCharacter").mockImplementation(async (_projectId, assetId) => ({
        asset: { id: assetId, title: assetId },
        character: { versionId: "version", definition: {}, voice: { profile: { sampleResourceId: `${assetId}-voice` }, instructions: "" }, representations: missing ? [] : [
            { id: `${assetId}-primary`, resourceId: `${assetId}-primary`, role: "primary" },
            { id: `${assetId}-front`, resourceId: `${assetId}-front`, role: "front" },
            { id: `${assetId}-side`, resourceId: `${assetId}-side`, role: "side" },
        ] },
    } as Awaited<ReturnType<typeof projects.getProjectCharacter>>));
    const image = spyOn(images, "imageToDataUrl").mockImplementation(async () => "data:image/png;base64,YQ==");
    return () => { character.mockRestore(); image.mockRestore(); };
}

const field = (index: number): WorkflowFieldMapping => ({ nodeId: `load-${index}`, fieldName: "image", source: "referenceImage", sourceIndex: index, enabled: true, required: true });

test("角色卡与图片混排、拖动和重复 @ 后，显示槽位与最终任务顺序一致", async () => {
    const restore = mockCharacterMedia();
    usePluginStore.getState().setRuntimeStatuses({ [RUNNINGHUB_PLUGIN_ID]: "enabled" });
    try {
        for (const order of [["character-a", "image-b", "character-c"], ["character-c", "character-a", "image-b"], ["image-b", "character-c", "character-a"]]) {
            for (const prompt of ["生成视频", "@角色2 与 @图片1，再看 @角色1 和 @角色2", "<Picture 2> 与 <Picture 1>"]) {
                const { nodes, connections, target } = fixture();
                target.metadata.composerContent = prompt;
                const reordered = reorderCanvasResourceConnections(target.id, order, nodes, connections);
                const references = buildNodeMentionReferences(target, nodes, reordered);
                const fields = order.map((_, index) => field(index));
                expect(fields.map((item) => workflowSlotReference(item, references)?.nodeId)).toEqual(order);
                expect(canvasWorkflowInputError(fields, references, {})).toBe("");
                const context = buildNodeGenerationContext(target.id, nodes, reordered, prompt, [], true);
                const hydrated = await hydrateNodeGenerationContext(context, "canvas", "project", "video", false, false, { maxImages: 1, maxVideos: 0, maxAudios: 0 });
                const expected = order.map((id) => `resource:${id}${id.startsWith("character") ? "-primary" : ""}`);
                expect(hydrated.referenceImages.map((image) => image.storageKey)).toEqual(expected);
                expect(hydrated.imageCount).toBe(3);
                const payload = await prepareBackendGenerationTask({ mode: "video", prompt: hydrated.prompt, referenceImages: hydrated.referenceImages, config: {
                    ...defaultConfig, taskWorkflowProvider: "runninghub", runningHub: { ...defaultConfig.runningHub, enabled: true, apiKey: "test-key", workflowId: "workflow-id", selectedKind: "workflow", capability: "video", workflows: [{ workflowId: "workflow-id", kind: "workflow", capability: "video", fields }] },
                } });
                expect(payload.input.referenceImages.map((image) => image.storageKey)).toEqual(expected);
                expect(payload.input.config.workflowFields).toEqual(fields);
            }
        }
    } finally { restore(); }
});

test("没有 composer 或 @ 的工作流也保留角色与图片混排顺序", async () => {
    const restore = mockCharacterMedia();
    try {
        const { nodes, connections, target } = fixture();
        const context = buildNodeGenerationContext(target.id, nodes, connections, "生成视频", [], false);
        const hydrated = await hydrateNodeGenerationContext(context, "canvas", "project", "video");
        expect(hydrated.referenceImages.map((image) => image.storageKey)).toEqual(["resource:character-a-primary", "resource:image-b", "resource:character-c-primary"]);
    } finally { restore(); }
});

test("普通模型继续按原策略追加角色主图和补充视图", async () => {
    const restore = mockCharacterMedia();
    try {
        const { nodes, connections, target } = fixture(false);
        const context = buildNodeGenerationContext(target.id, nodes, connections, "生成视频", [], true);
        const hydrated = await hydrateNodeGenerationContext(context, "canvas", "project", "video");
        expect(context.workflowImageSlots).toBeUndefined();
        expect(hydrated.referenceImages.map((image) => image.storageKey)).toEqual(["resource:image-b", "resource:character-a-primary", "resource:character-c-primary", "resource:character-a-front", "resource:character-a-side", "resource:character-c-front", "resource:character-c-side"]);
    } finally { restore(); }
});

test("缺少角色主图时拒绝提交，不能跳过角色造成后续槽位错位", async () => {
    const restore = mockCharacterMedia(true);
    try {
        const { nodes, connections, target } = fixture();
        const context = buildNodeGenerationContext(target.id, nodes, connections, "生成视频", [], true);
        await expect(hydrateNodeGenerationContext(context, "canvas", "project", "video")).rejects.toThrow("没有可用的主参考图");
    } finally { restore(); }
});

test("工作流混用角色卡时也不继承默认九张图片和三个音频的容量", async () => {
    const restore = mockCharacterMedia();
    try {
        const { nodes, connections, target } = fixture();
        const context = buildNodeGenerationContext(target.id, nodes, connections, "生成视频", [], true);
        const additionalImages = Array.from({ length: 10 }, (_, index) => ({ id: `extra-${index}`, name: `extra-${index}.png`, type: "image/png", dataUrl: "", storageKey: `resource:extra-${index}` }));
        context.referenceImages.push(...additionalImages);
        context.workflowImageSlots!.push(...additionalImages.map((image) => ({ image })));
        context.referenceAudios = Array.from({ length: 4 }, (_, index) => ({ id: `audio-${index}`, name: `audio-${index}.wav`, type: "audio/wav", url: "", durationMs: 1000 }));
        const hydrated = await hydrateNodeGenerationContext(context, "canvas", "project", "video", true);
        expect(hydrated.referenceImages).toHaveLength(13);
        expect(hydrated.referenceAudios).toHaveLength(4);
        expect(hydrated.referenceImages[0]?.storageKey).toBe("resource:character-a-primary");
        expect(hydrated.referenceImages[12]?.storageKey).toBe("resource:extra-9");
    } finally { restore(); }
});
