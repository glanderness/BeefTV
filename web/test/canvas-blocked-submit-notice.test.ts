import { expect, test } from "bun:test";

import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { executeImageGeneration } from "@/pages/canvas/canvas-image-generation-executor";
import { blockCanvasGenerationSubmit } from "@/pages/canvas/canvas-generation-failure";
import type { CanvasGenerationExecution } from "@/pages/canvas/canvas-generation-executor-types";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

// 右上角 Toast 被全局 CSS 隐藏（.ant-message display:none），所以提交前被拦下的原因必须落到节点上，
// 由提示词面板渲染成「未开始生成：…」。这些用例锁定「点生成没有任何反应」不会回归。

const model = "relay::limited-image";

function limitedImageConfig(): AiConfig {
    const profile = defaultModelCapabilityConfig(undefined, "limited-image");
    profile.image!.references.maxImages = 1;
    return {
        ...defaultConfig,
        channels: [{
            id: "relay",
            name: "中转渠道",
            baseUrl: "https://api.example.com",
            apiKey: "test-key",
            apiFormat: "openai",
            models: ["limited-image"],
            modelProfiles: [{ model: "limited-image", capability: "image", billingMode: "fixed_request", unitPriceMicrocredits: 1, capabilityConfig: profile }],
        }],
        models: [model],
        imageModels: [model],
        imageModel: model,
        model,
    };
}

function imageNode(id: string, metadata?: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 320, height: 320, metadata: metadata ?? { status: "idle" } };
}

function blockedExecution(nodes: CanvasNodeData[], target: CanvasNodeData, config: AiConfig, referenceImages: { id: string; name: string; type: string; dataUrl: string }[]) {
    const state: { nodes?: CanvasNodeData[]; errors: string[]; submissions: number } = { errors: [], submissions: 0 };
    const execution = {
        sourceNode: target,
        nodeId: target.id,
        canvasNodes: nodes,
        canvasConnections: [],
        prompt: "把三张参考图合成一张",
        effectivePrompt: "把三张参考图合成一张",
        projectId: "canvas-1",
        clientOperationId: "test-blocked-submit",
        generationConfig: config,
        generationContext: { referenceImages },
        controller: new AbortController(),
        setNodes: (update: CanvasNodeData[] | ((current: CanvasNodeData[]) => CanvasNodeData[])) => {
            state.nodes = typeof update === "function" ? update(nodes) : update;
        },
        setConnections: () => undefined,
        registerPendingNodeIds: () => undefined,
        startGenerationRequest: () => { state.submissions++; },
        showError: (content: string) => { state.errors.push(content); },
    } as unknown as CanvasGenerationExecution;
    return { execution, state };
}

test("超过模型参考图上限时，拦截原因写到节点上而不只是隐藏的 Toast", async () => {
    const config = limitedImageConfig();
    const target = imageNode("target");
    const references = [
        { id: "image-a", name: "a.png", type: "image/png", dataUrl: "data:image/png;base64,YQ==" },
        { id: "image-b", name: "b.png", type: "image/png", dataUrl: "data:image/png;base64,Yg==" },
        { id: "image-c", name: "c.png", type: "image/png", dataUrl: "data:image/png;base64,Yw==" },
    ];
    const { execution, state } = blockedExecution([target], target, config, references);

    await executeImageGeneration(execution);

    expect(state.submissions).toBe(0);
    expect(state.errors[0]).toContain("最多支持 1 张参考图，当前已连接 3 张");
    const blocked = state.nodes?.find((node) => node.id === target.id);
    expect(blocked?.metadata?.generationPreflightError).toBe(state.errors[0]);
});

test("已有待取回结果时，拦截原因写到节点上", async () => {
    const target = imageNode("target", { status: "error", taskId: "task-kept", taskStatus: "succeeded", resourceReloadAvailable: true, generationErrorCode: "canvas_conflict" });
    const { execution, state } = blockedExecution([target], target, limitedImageConfig(), []);

    await executeImageGeneration(execution);

    expect(state.submissions).toBe(0);
    expect(state.errors[0]).toContain("继续取回");
    expect(state.nodes?.find((node) => node.id === target.id)?.metadata?.generationPreflightError).toBe(state.errors[0]);
});

test("拦截提示只写目标节点，不污染其他节点", () => {
    const other = imageNode("other");
    const target = imageNode("target");

    const next = blockCanvasGenerationSubmit([other, target], target.id, "该节点已有生成请求正在提交或执行，请勿重复点击");

    expect(next.find((node) => node.id === other.id)?.metadata?.generationPreflightError).toBeUndefined();
    expect(next.find((node) => node.id === target.id)?.metadata?.generationPreflightError).toBe("该节点已有生成请求正在提交或执行，请勿重复点击");
});
