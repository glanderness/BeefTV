import { expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as canvasEmotion from "@/lib/canvas/canvas-emotion";
import * as canvasProjectGeneration from "@/lib/canvas/canvas-project-generation";
import * as modelCapabilities from "@/lib/model-capabilities";
import { notChargedTaskOutcome, readyTaskOutcome, runningTaskOutcome } from "@/lib/task-outcome";
import { useCanvasGenerationRetry } from "@/pages/canvas/use-canvas-generation-retry";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function makeEmotionRetryFixture(maxImages: number) {
    const channel = {
        ...defaultConfig.channels[0]!,
        id: "gemini-custom",
        name: "Gemini Custom",
        interfaceType: "gemini-image" as const,
        baseUrl: "https://api.example.com",
        apiKey: "fixture-key",
        hasApiKey: true,
        models: ["gemini-edit-model"],
    };
    const config = {
        ...defaultConfig,
        model: "gemini-custom::gemini-edit-model",
        imageModel: "gemini-custom::gemini-edit-model",
        channels: [channel],
    };
    const sourceNode: CanvasNodeData = {
        id: "source-img",
        type: CanvasNodeType.Image,
        title: "人物原图",
        position: { x: 0, y: 0 },
        width: 512,
        height: 512,
        metadata: {
            content: "/api/resources/source-1/file",
            storageKey: "resource:source-1",
            naturalWidth: 1024,
            naturalHeight: 1024,
            status: "success",
        },
    };
    const emotionNode: CanvasNodeData = {
        id: "emotion-node",
        type: CanvasNodeType.Image,
        title: "角色1 · 开心",
        position: { x: 600, y: 0 },
        width: 512,
        height: 512,
        metadata: {
            prompt: "仅修改原图中“角色1”脸部的表情",
            status: "error",
            model: "gemini-custom::gemini-edit-model",
            emotionEdit: {
                sourceNodeId: "source-img",
                characterName: "角色1",
                presetId: "emotion-0-0",
                intimacy: 0.4,
                arousal: 0.6,
                label: "开心",
                faceBox: { id: "face-1", x: 300, y: 200, width: 200, height: 220, source: "detected" },
                sourceWidth: 1024,
                sourceHeight: 1024,
                fullImage: true,
            },
        },
    };
    const profile = {
        ...modelCapabilities.defaultImageCapabilityConfig("gemini-image", "gemini-edit-model"),
        references: { maxImages, maskSupported: false },
    };
    return { config, sourceNode, emotionNode, profile };
}

test("useCanvasGenerationRetry retries emotion nodes with local-composite on non-openai single-reference models", async () => {
    const { config, sourceNode, emotionNode, profile } = makeEmotionRetryFixture(1);
    const consumerCalls: Array<Parameters<typeof canvasProjectGeneration.runCanvasGenerationTaskToConsumer>[0]> = [];
    const buildConfigSpy = spyOn(canvasProjectGeneration, "buildGenerationConfig").mockReturnValue(config);
    const capabilitySpy = spyOn(modelCapabilities, "modelCapabilityConfigFor").mockReturnValue({ version: 1, image: profile });
    const maskSpy = spyOn(canvasEmotion, "buildFullImageEmotionEdit").mockReturnValue({
        prompt: "full-image emotion prompt",
        maskDataUrl: "data:image/png;base64,ZmVhdGhlcmVkLW1hc2s=",
    });
    const consumerSpy = spyOn(canvasProjectGeneration, "runCanvasGenerationTaskToConsumer").mockImplementation(async (input) => {
        consumerCalls.push(input);
    });

    const nodesRef = { current: [sourceNode, emotionNode] };
    let retry!: ReturnType<typeof useCanvasGenerationRetry>;
    function Harness() {
        retry = useCanvasGenerationRetry({
            projectId: "project-emotion-retry",
            addedSkills: [],
            assets: [],
            nodesRef,
            connectionsRef: { current: [] },
            setNodes: (updater) => {
                nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
            },
            setRunningNodeId: () => {},
            startGenerationRequest: () => new AbortController(),
            finishGenerationRequest: () => {},
            bindGenerationTask: () => {},
            applyGenerationTaskResult: async () => {},
            regenerateImageBatch: async () => {},
        });
        return null;
    }

    try {
        renderToStaticMarkup(createElement(Harness));
        await retry(emotionNode);
        expect(consumerCalls).toHaveLength(1);
        const submitted = consumerCalls[0]!;
        expect(submitted.mode).toBe("image");
        expect(submitted.referenceImages).toHaveLength(1);
        expect(submitted.mask?.dataUrl).toBe("data:image/png;base64,ZmVhdGhlcmVkLW1hc2s=");
        expect(submitted.metadata?.edit).toBe("emotion");
        expect(submitted.metadata?.maskEditMode).toBe("local-composite");
        const updated = nodesRef.current.find((item) => item.id === "emotion-node");
        expect(updated?.metadata?.emotionEdit?.fullImage).toBe(true);
        expect(updated?.metadata?.emotionEdit?.editMode).toBe("local-composite");
        expect(updated?.metadata?.emotionEdit?.editRegion).toBeUndefined();
    } finally {
        buildConfigSpy.mockRestore();
        capabilitySpy.mockRestore();
        maskSpy.mockRestore();
        consumerSpy.mockRestore();
    }
});

test("useCanvasGenerationRetry rejects text-only models before submitting emotion retry", async () => {
    const { config, sourceNode, emotionNode, profile } = makeEmotionRetryFixture(0);
    const buildConfigSpy = spyOn(canvasProjectGeneration, "buildGenerationConfig").mockReturnValue(config);
    const capabilitySpy = spyOn(modelCapabilities, "modelCapabilityConfigFor").mockReturnValue({ version: 1, image: profile });
    const consumerSpy = spyOn(canvasProjectGeneration, "runCanvasGenerationTaskToConsumer").mockImplementation(async () => {});

    const nodesRef = { current: [sourceNode, emotionNode] };
    let retry!: ReturnType<typeof useCanvasGenerationRetry>;
    function Harness() {
        retry = useCanvasGenerationRetry({
            projectId: "project-emotion-retry-text-only",
            addedSkills: [],
            assets: [],
            nodesRef,
            connectionsRef: { current: [] },
            setNodes: (updater) => {
                nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
            },
            setRunningNodeId: () => {},
            startGenerationRequest: () => new AbortController(),
            finishGenerationRequest: () => {},
            bindGenerationTask: () => {},
            applyGenerationTaskResult: async () => {},
            regenerateImageBatch: async () => {},
        });
        return null;
    }

    try {
        renderToStaticMarkup(createElement(Harness));
        await retry(emotionNode);
        expect(consumerSpy).not.toHaveBeenCalled();
        const updated = nodesRef.current.find((item) => item.id === "emotion-node");
        expect(updated?.metadata?.status).toBe("error");
        expect(updated?.metadata?.errorDetails).toContain("仅支持文生图");
    } finally {
        buildConfigSpy.mockRestore();
        capabilitySpy.mockRestore();
        consumerSpy.mockRestore();
    }
});

test("useCanvasGenerationRetry retries fixedOutputs emotion batch without delegating to plain regenerateImageBatch", async () => {
    const { config, sourceNode, emotionNode, profile } = makeEmotionRetryFixture(1);
    const fixedProfile = { ...profile, maxOutputs: 4, fixedOutputs: 4 };
    const childIds = ["emo-0", "emo-1", "emo-2", "emo-3"];
    const rootNode: CanvasNodeData = {
        ...emotionNode,
        id: "emo-root",
        metadata: {
            ...emotionNode.metadata,
            isBatchRoot: true,
            batchChildIds: childIds,
        },
    };
    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
        ...emotionNode,
        id,
        metadata: {
            ...emotionNode.metadata,
            batchRootId: rootNode.id,
            taskOutputIndex: index,
            taskId: "old-emo-task",
        },
    }));

    const consumerCalls: Array<Parameters<typeof canvasProjectGeneration.runCanvasGenerationTaskToConsumer>[0]> = [];
    let regenerateCalls = 0;
    const buildConfigSpy = spyOn(canvasProjectGeneration, "buildGenerationConfig").mockReturnValue(config);
    const capabilitySpy = spyOn(modelCapabilities, "modelCapabilityConfigFor").mockReturnValue({ version: 1, image: fixedProfile });
    const maskSpy = spyOn(canvasEmotion, "buildFullImageEmotionEdit").mockReturnValue({
        prompt: "full-image emotion prompt",
        maskDataUrl: "data:image/png;base64,ZmVhdGhlcmVkLW1hc2s=",
    });
    const consumerSpy = spyOn(canvasProjectGeneration, "runCanvasGenerationTaskToConsumer").mockImplementation(async (input) => {
        consumerCalls.push(input);
    });

    const nodesRef = { current: [sourceNode, rootNode, ...childNodes] };
    let retry!: ReturnType<typeof useCanvasGenerationRetry>;
    function Harness() {
        retry = useCanvasGenerationRetry({
            projectId: "project-emotion-retry-fixed",
            addedSkills: [],
            assets: [],
            nodesRef,
            connectionsRef: { current: [] },
            setNodes: (updater) => {
                nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
            },
            setRunningNodeId: () => {},
            startGenerationRequest: () => new AbortController(),
            finishGenerationRequest: () => {},
            bindGenerationTask: () => {},
            applyGenerationTaskResult: async () => {},
            regenerateImageBatch: async () => {
                regenerateCalls++;
            },
        });
        return null;
    }

    try {
        renderToStaticMarkup(createElement(Harness));
        await retry(childNodes[1]!);
        expect(regenerateCalls).toBe(0);
        expect(consumerCalls).toHaveLength(1);
        const submitted = consumerCalls[0]!;
        expect(submitted.config.count).toBe("4");
        expect(submitted.referenceImages).toHaveLength(1);
        expect(submitted.mask?.dataUrl).toBe("data:image/png;base64,ZmVhdGhlcmVkLW1hc2s=");
        expect(submitted.metadata?.edit).toBe("emotion");
        expect(submitted.metadata?.maskEditMode).toBe("local-composite");
        expect(submitted.metadata?.outputNodeIds).toEqual(childIds);
        const indices = childIds.map((id) => nodesRef.current.find((item) => item.id === id)?.metadata?.taskOutputIndex);
        expect(indices).toEqual([0, 1, 2, 3]);
    } finally {
        buildConfigSpy.mockRestore();
        capabilitySpy.mockRestore();
        maskSpy.mockRestore();
        consumerSpy.mockRestore();
    }
});

test("useCanvasGenerationRetry retries fixedOutputs local-composite maskEdit reusing stored maskStorageKey and reconciling root", async () => {
    const { config, sourceNode, profile } = makeEmotionRetryFixture(1);
    const fixedProfile = { ...profile, maxOutputs: 4, fixedOutputs: 4 };
    const storageOnlySource: CanvasNodeData = {
        ...sourceNode,
        metadata: { storageKey: "resource:source-1", naturalWidth: 1024, naturalHeight: 1024, status: "success" },
    };
    const childIds = ["mask-0", "mask-1", "mask-2", "mask-3"];
    const rootNode: CanvasNodeData = {
        id: "mask-root",
        type: CanvasNodeType.Image,
        title: "局部重绘结果",
        position: { x: 600, y: 0 },
        width: 512,
        height: 512,
        metadata: {
            prompt: "只修改蒙版透明区域，其他区域保持不变。换一件红色外套",
            status: "error",
            errorDetails: "上次超时失败",
            taskOutcome: notChargedTaskOutcome(),
            model: config.model,
            isBatchRoot: true,
            batchChildIds: childIds,
            maskEdit: { sourceNodeId: storageOnlySource.id, editMode: "local-composite", maskStorageKey: "resource:saved-mask-1" },
        },
    };
    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
        ...rootNode,
        id,
        metadata: {
            prompt: rootNode.metadata?.prompt,
            status: "error",
            model: config.model,
            batchRootId: rootNode.id,
            taskOutputIndex: index,
            taskId: "old-mask-task",
            maskEdit: { sourceNodeId: storageOnlySource.id, editMode: "local-composite", maskStorageKey: "resource:saved-mask-1" },
        },
    }));

    const consumerCalls: Array<Parameters<typeof canvasProjectGeneration.runCanvasGenerationTaskToConsumer>[0]> = [];
    let regenerateCalls = 0;
    const buildConfigSpy = spyOn(canvasProjectGeneration, "buildGenerationConfig").mockReturnValue(config);
    const capabilitySpy = spyOn(modelCapabilities, "modelCapabilityConfigFor").mockReturnValue({ version: 1, image: fixedProfile });
    const consumerSpy = spyOn(canvasProjectGeneration, "runCanvasGenerationTaskToConsumer").mockImplementation(async (input, deps) => {
        consumerCalls.push(input);
        await deps.consumeTask({
            id: "new-mask-task",
            type: "canvas_image",
            status: "succeeded",
            prompt: input.prompt,
            attempts: 1,
            createdAt: "2026-11-23T00:00:00Z",
            updatedAt: "2026-11-23T00:00:00Z",
            inputJson: JSON.stringify({ mode: "image", metadata: input.metadata }),
        });
    });

    const nodesRef = { current: [storageOnlySource, rootNode, ...childNodes] };
    const setNodes = (updater: CanvasNodeData[] | ((prev: CanvasNodeData[]) => CanvasNodeData[])) => {
        nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
    };
    let retry!: ReturnType<typeof useCanvasGenerationRetry>;
    function Harness() {
        retry = useCanvasGenerationRetry({
            projectId: "project-mask-retry-fixed",
            addedSkills: [],
            assets: [],
            nodesRef,
            connectionsRef: { current: [] },
            setNodes,
            setRunningNodeId: () => {},
            startGenerationRequest: () => new AbortController(),
            finishGenerationRequest: () => {},
            bindGenerationTask: () => {},
            applyGenerationTaskResult: async (targetId) => {
                const idx = childIds.indexOf(targetId);
                setNodes((current) =>
                    current.map((item) =>
                        item.id === targetId
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: "success",
                                      content: `/api/resources/out-${idx}/file`,
                                      storageKey: `resource:out-${idx}`,
                                      naturalWidth: 1024,
                                      naturalHeight: 1024,
                                  },
                              }
                            : item,
                    ),
                );
            },
            regenerateImageBatch: async () => {
                regenerateCalls++;
            },
        });
        return null;
    }

    try {
        renderToStaticMarkup(createElement(Harness));
        await retry(rootNode);
        expect(regenerateCalls).toBe(0);
        expect(consumerCalls).toHaveLength(1);
        const submitted = consumerCalls[0]!;
        expect(submitted.config.count).toBe("4");
        expect(submitted.prompt).toBe("换一件红色外套");
        expect(submitted.referenceImages).toHaveLength(1);
        expect(submitted.mask?.storageKey).toBe("resource:saved-mask-1");
        expect(submitted.metadata?.edit).toBe("mask");
        expect(submitted.metadata?.maskEditMode).toBe("local-composite");
        expect(submitted.metadata?.outputNodeIds).toEqual(childIds);
        const indices = childIds.map((id) => nodesRef.current.find((item) => item.id === id)?.metadata?.taskOutputIndex);
        expect(indices).toEqual([0, 1, 2, 3]);
        const updatedRoot = nodesRef.current.find((item) => item.id === rootNode.id);
        expect(updatedRoot?.metadata?.status).toBe("success");
        expect(updatedRoot?.metadata?.primaryImageId).toBe("mask-0");
        expect(updatedRoot?.metadata?.content).toBe("/api/resources/out-0/file");
        expect(updatedRoot?.metadata?.storageKey).toBe("resource:out-0");
        expect(updatedRoot?.metadata?.taskOutcome).toBeUndefined();
        expect(updatedRoot?.metadata?.errorDetails).toBeUndefined();
    } finally {
        buildConfigSpy.mockRestore();
        capabilitySpy.mockRestore();
        consumerSpy.mockRestore();
    }
});

test("useCanvasGenerationRetry refuses partial-success, missing-child, and non-batch fixedOutputs mask/emotion retries", async () => {
    const { config, sourceNode, emotionNode, profile } = makeEmotionRetryFixture(1);
    const fixedProfile = { ...profile, maxOutputs: 4, fixedOutputs: 4 };
    const buildConfigSpy = spyOn(canvasProjectGeneration, "buildGenerationConfig").mockReturnValue(config);
    const capabilitySpy = spyOn(modelCapabilities, "modelCapabilityConfigFor").mockReturnValue({ version: 1, image: fixedProfile });
    const consumerSpy = spyOn(canvasProjectGeneration, "runCanvasGenerationTaskToConsumer").mockImplementation(async () => {});

    const runCase = async (nodes: CanvasNodeData[], target: CanvasNodeData) => {
        const nodesRef = { current: nodes };
        let regenerateCalls = 0;
        let retry!: ReturnType<typeof useCanvasGenerationRetry>;
        function Harness() {
            retry = useCanvasGenerationRetry({
                projectId: "project-fixed-guard",
                addedSkills: [],
                assets: [],
                nodesRef,
                connectionsRef: { current: [] },
                setNodes: (updater) => {
                    nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
                },
                setRunningNodeId: () => {},
                startGenerationRequest: () => new AbortController(),
                finishGenerationRequest: () => {},
                bindGenerationTask: () => {},
                applyGenerationTaskResult: async () => {},
                regenerateImageBatch: async () => {
                    regenerateCalls++;
                },
            });
            return null;
        }
        renderToStaticMarkup(createElement(Harness));
        await retry(target);
        return { nodes: nodesRef.current, regenerateCalls };
    };

    try {
        // 1. Partial success: c0 already succeeded with content; retrying failed c1 must not overwrite c0 or submit count=4.
        const childIds = ["p-0", "p-1", "p-2", "p-3"];
        const partialRoot: CanvasNodeData = {
            ...emotionNode,
            id: "p-root",
            metadata: { ...emotionNode.metadata, isBatchRoot: true, batchChildIds: childIds },
        };
        const partialChildren: CanvasNodeData[] = childIds.map((id, index) => ({
            ...emotionNode,
            id,
            metadata: {
                ...emotionNode.metadata,
                batchRootId: partialRoot.id,
                taskOutputIndex: index,
                status: index === 0 ? "success" : "error",
                ...(index === 0 ? { content: "/api/resources/existing/file", storageKey: "resource:existing" } : {}),
            },
        }));
        const partialRes = await runCase([sourceNode, partialRoot, ...partialChildren], partialChildren[1]!);
        expect(partialRes.regenerateCalls).toBe(0);
        expect(consumerSpy).not.toHaveBeenCalled();
        expect(partialRes.nodes.find((n) => n.id === "p-0")?.metadata?.content).toBe("/api/resources/existing/file");
        expect(partialRes.nodes.find((n) => n.id === "p-1")?.metadata?.errorDetails).toContain("该批次已有结果或任务状态不完整");

        // 2. Missing child: only 3 of 4 children exist on canvas.
        const missingRes = await runCase([sourceNode, partialRoot, ...partialChildren.slice(1)], partialChildren[1]!);
        expect(missingRes.regenerateCalls).toBe(0);
        expect(consumerSpy).not.toHaveBeenCalled();
        expect(missingRes.nodes.find((n) => n.id === "p-1")?.metadata?.errorDetails).toContain("该批次已有结果或任务状态不完整");

        // 3. Single legacy node switched onto fixedOutputs=4 model.
        const singleRes = await runCase([sourceNode, emotionNode], emotionNode);
        expect(singleRes.regenerateCalls).toBe(0);
        expect(consumerSpy).not.toHaveBeenCalled();
        expect(singleRes.nodes.find((n) => n.id === emotionNode.id)?.metadata?.errorDetails).toContain("固定输出多张图片");

        // 4. Child with live taskOutcome (running) or uncertain submission state even if status is error.
        const liveChildren: CanvasNodeData[] = childIds.map((id, index) => ({
            ...emotionNode,
            id,
            metadata: {
                ...emotionNode.metadata,
                batchRootId: partialRoot.id,
                taskOutputIndex: index,
                status: "error",
                ...(index === 2 ? { taskOutcome: runningTaskOutcome() } : {}),
            },
        }));
        const liveRes = await runCase([sourceNode, partialRoot, ...liveChildren], liveChildren[0]!);
        expect(liveRes.regenerateCalls).toBe(0);
        expect(consumerSpy).not.toHaveBeenCalled();
        expect(liveRes.nodes.find((n) => n.id === "p-0")?.metadata?.errorDetails).toContain("仍在生成或结果待确认");

        // 5. Root in uncertain submission state must also block retry.
        const uncertainRoot: CanvasNodeData = {
            ...partialRoot,
            metadata: { ...partialRoot.metadata, generationSubmissionState: "unknown" },
        };
        const failedChildren: CanvasNodeData[] = childIds.map((id, index) => ({
            ...emotionNode,
            id,
            metadata: { ...emotionNode.metadata, batchRootId: uncertainRoot.id, taskOutputIndex: index, status: "error" },
        }));
        const rootLiveRes = await runCase([sourceNode, uncertainRoot, ...failedChildren], failedChildren[0]!);
        expect(rootLiveRes.regenerateCalls).toBe(0);
        expect(consumerSpy).not.toHaveBeenCalled();
        expect(rootLiveRes.nodes.find((n) => n.id === "p-0")?.metadata?.errorDetails).toContain("仍在生成或结果待确认");

        // 6. status=error with taskStatus=running or ready outcome without content must also block retry.
        const runningStatusChildren: CanvasNodeData[] = childIds.map((id, index) => ({
            ...emotionNode,
            id,
            metadata: {
                ...emotionNode.metadata,
                batchRootId: partialRoot.id,
                taskOutputIndex: index,
                status: "error",
                ...(index === 1 ? { taskStatus: "running" as const } : {}),
            },
        }));
        const runningStatusRes = await runCase([sourceNode, partialRoot, ...runningStatusChildren], runningStatusChildren[0]!);
        expect(runningStatusRes.regenerateCalls).toBe(0);
        expect(consumerSpy).not.toHaveBeenCalled();

        const readyNoContentChildren: CanvasNodeData[] = childIds.map((id, index) => ({
            ...emotionNode,
            id,
            metadata: {
                ...emotionNode.metadata,
                batchRootId: partialRoot.id,
                taskOutputIndex: index,
                status: index === 3 ? "success" : "error",
                ...(index === 3 ? { taskOutcome: readyTaskOutcome() } : {}),
            },
        }));
        const readyRes = await runCase([sourceNode, partialRoot, ...readyNoContentChildren], readyNoContentChildren[0]!);
        expect(readyRes.regenerateCalls).toBe(0);
        expect(consumerSpy).not.toHaveBeenCalled();

        // 7. Child in generationSubmissionState="submitting" without taskId must block fixedOutputs batch retry.
        const submittingChildren: CanvasNodeData[] = childIds.map((id, index) => ({
            ...emotionNode,
            id,
            metadata: {
                ...emotionNode.metadata,
                batchRootId: partialRoot.id,
                taskOutputIndex: index,
                status: "error",
                ...(index === 2 ? { generationSubmissionState: "submitting" as const } : {}),
            },
        }));
        const submittingRes = await runCase([sourceNode, partialRoot, ...submittingChildren], submittingChildren[0]!);
        expect(submittingRes.regenerateCalls).toBe(0);
        expect(consumerSpy).not.toHaveBeenCalled();
        expect(submittingRes.nodes.find((n) => n.id === "p-0")?.metadata?.errorDetails).toContain("仍在生成或结果待确认");
    } finally {
        buildConfigSpy.mockRestore();
        capabilitySpy.mockRestore();
        consumerSpy.mockRestore();
    }
});

test("useCanvasGenerationRetry keeps already-applied outputs intact when fixedOutputs consumeTask fails partway through", async () => {
    const { config, sourceNode, profile } = makeEmotionRetryFixture(1);
    const fixedProfile = { ...profile, maxOutputs: 4, fixedOutputs: 4 };
    const childIds = ["part-0", "part-1", "part-2", "part-3"];
    const rootNode: CanvasNodeData = {
        id: "part-root",
        type: CanvasNodeType.Image,
        title: "局部重绘结果",
        position: { x: 600, y: 0 },
        width: 512,
        height: 512,
        metadata: {
            prompt: "换一件蓝色外套",
            status: "error",
            model: config.model,
            isBatchRoot: true,
            batchChildIds: childIds,
            maskEdit: { sourceNodeId: sourceNode.id, editMode: "local-composite", maskStorageKey: "resource:saved-mask-2" },
        },
    };
    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
        ...rootNode,
        id,
        metadata: {
            prompt: rootNode.metadata?.prompt,
            status: "error",
            model: config.model,
            batchRootId: rootNode.id,
            taskOutputIndex: index,
            maskEdit: { sourceNodeId: sourceNode.id, editMode: "local-composite", maskStorageKey: "resource:saved-mask-2" },
        },
    }));

    const buildConfigSpy = spyOn(canvasProjectGeneration, "buildGenerationConfig").mockReturnValue(config);
    const capabilitySpy = spyOn(modelCapabilities, "modelCapabilityConfigFor").mockReturnValue({ version: 1, image: fixedProfile });
    const consumerSpy = spyOn(canvasProjectGeneration, "runCanvasGenerationTaskToConsumer").mockImplementation(async (input, deps) => {
        await deps.consumeTask({
            id: "partial-task",
            type: "canvas_image",
            status: "succeeded",
            prompt: input.prompt,
            attempts: 1,
            createdAt: "2026-11-23T00:00:00Z",
            updatedAt: "2026-11-23T00:00:00Z",
        });
    });

    const nodesRef = { current: [sourceNode, rootNode, ...childNodes] };
    const setNodes = (updater: CanvasNodeData[] | ((prev: CanvasNodeData[]) => CanvasNodeData[])) => {
        nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
    };
    let retry!: ReturnType<typeof useCanvasGenerationRetry>;
    function Harness() {
        retry = useCanvasGenerationRetry({
            projectId: "project-partial-consume",
            addedSkills: [],
            assets: [],
            nodesRef,
            connectionsRef: { current: [] },
            setNodes,
            setRunningNodeId: () => {},
            startGenerationRequest: () => new AbortController(),
            finishGenerationRequest: () => {},
            bindGenerationTask: () => {},
            applyGenerationTaskResult: async (targetId) => {
                const idx = childIds.indexOf(targetId);
                if (idx === 3) throw new Error("后端任务只返回了 3 张图片");
                setNodes((current) =>
                    current.map((item) =>
                        item.id === targetId
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: "success",
                                      content: `/api/resources/part-${idx}/file`,
                                      storageKey: `resource:part-${idx}`,
                                  },
                              }
                            : item,
                    ),
                );
            },
            regenerateImageBatch: async () => {},
        });
        return null;
    }

    try {
        renderToStaticMarkup(createElement(Harness));
        await retry(rootNode);
        for (let i = 0; i < 3; i++) {
            const child = nodesRef.current.find((item) => item.id === childIds[i]);
            expect(child?.metadata?.status).toBe("success");
            expect(child?.metadata?.content).toBe(`/api/resources/part-${i}/file`);
        }
        const failedChild = nodesRef.current.find((item) => item.id === childIds[3]);
        expect(failedChild?.metadata?.status).toBe("error");
        expect(failedChild?.metadata?.errorDetails).toContain("只返回了 3 张图片");
        const updatedRoot = nodesRef.current.find((item) => item.id === rootNode.id);
        expect(updatedRoot?.metadata?.status).toBe("success");
        expect(updatedRoot?.metadata?.primaryImageId).toBe("part-0");
        expect(updatedRoot?.metadata?.batchFailedCount).toBe(1);
    } finally {
        buildConfigSpy.mockRestore();
        capabilitySpy.mockRestore();
        consumerSpy.mockRestore();
    }
});

test("useCanvasGenerationRetry refuses maskEdit retry when mask cannot be recovered", async () => {
    const { config, sourceNode, profile } = makeEmotionRetryFixture(1);
    const maskNode: CanvasNodeData = {
        id: "mask-missing",
        type: CanvasNodeType.Image,
        title: "局部重绘结果",
        position: { x: 600, y: 0 },
        width: 512,
        height: 512,
        metadata: {
            prompt: "换一件红色外套",
            status: "error",
            model: config.model,
            maskEdit: { sourceNodeId: sourceNode.id, editMode: "local-composite" },
        },
    };
    const buildConfigSpy = spyOn(canvasProjectGeneration, "buildGenerationConfig").mockReturnValue(config);
    const capabilitySpy = spyOn(modelCapabilities, "modelCapabilityConfigFor").mockReturnValue({ version: 1, image: profile });
    const consumerSpy = spyOn(canvasProjectGeneration, "runCanvasGenerationTaskToConsumer").mockImplementation(async () => {});

    const nodesRef = { current: [sourceNode, maskNode] };
    let retry!: ReturnType<typeof useCanvasGenerationRetry>;
    function Harness() {
        retry = useCanvasGenerationRetry({
            projectId: "project-mask-retry-missing",
            addedSkills: [],
            assets: [],
            nodesRef,
            connectionsRef: { current: [] },
            setNodes: (updater) => {
                nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
            },
            setRunningNodeId: () => {},
            startGenerationRequest: () => new AbortController(),
            finishGenerationRequest: () => {},
            bindGenerationTask: () => {},
            applyGenerationTaskResult: async () => {},
            regenerateImageBatch: async () => {},
        });
        return null;
    }

    try {
        renderToStaticMarkup(createElement(Harness));
        await retry(maskNode);
        expect(consumerSpy).not.toHaveBeenCalled();
        const updated = nodesRef.current.find((item) => item.id === "mask-missing");
        expect(updated?.metadata?.status).toBe("error");
        expect(updated?.metadata?.errorDetails).toContain("局部重绘蒙版已丢失");
    } finally {
        buildConfigSpy.mockRestore();
        capabilitySpy.mockRestore();
        consumerSpy.mockRestore();
    }
});

test("useCanvasGenerationRetry trusts authoritative taskOutcome over stale legacy taskStatus on fixedOutputs batch children", async () => {
    const { config, sourceNode, profile } = makeEmotionRetryFixture(1);
    const fixedProfile = { ...profile, maxOutputs: 4, fixedOutputs: 4 };
    const childIds = ["auth-0", "auth-1", "auth-2", "auth-3"];
    const rootNode: CanvasNodeData = {
        id: "auth-root",
        type: CanvasNodeType.Image,
        title: "局部重绘结果",
        position: { x: 600, y: 0 },
        width: 512,
        height: 512,
        metadata: {
            prompt: "换一件黑色风衣",
            status: "error",
            taskOutcome: notChargedTaskOutcome(),
            model: config.model,
            isBatchRoot: true,
            batchChildIds: childIds,
            maskEdit: { sourceNodeId: sourceNode.id, editMode: "local-composite", maskStorageKey: "resource:saved-mask-auth" },
        },
    };
    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
        ...rootNode,
        id,
        metadata: {
            prompt: rootNode.metadata?.prompt,
            status: "error",
            // 陈旧遗留字段残留 taskStatus=running，但后端权威 taskOutcome 已明确判定 not_charged 可重试
            taskStatus: index === 1 ? ("running" as const) : ("failed" as const),
            taskOutcome: notChargedTaskOutcome(),
            model: config.model,
            batchRootId: rootNode.id,
            taskOutputIndex: index,
            maskEdit: { sourceNodeId: sourceNode.id, editMode: "local-composite", maskStorageKey: "resource:saved-mask-auth" },
        },
    }));

    const consumerCalls: Array<Parameters<typeof canvasProjectGeneration.runCanvasGenerationTaskToConsumer>[0]> = [];
    const buildConfigSpy = spyOn(canvasProjectGeneration, "buildGenerationConfig").mockReturnValue(config);
    const capabilitySpy = spyOn(modelCapabilities, "modelCapabilityConfigFor").mockReturnValue({ version: 1, image: fixedProfile });
    const consumerSpy = spyOn(canvasProjectGeneration, "runCanvasGenerationTaskToConsumer").mockImplementation(async (input) => {
        consumerCalls.push(input);
    });

    const nodesRef = { current: [sourceNode, rootNode, ...childNodes] };
    let retry!: ReturnType<typeof useCanvasGenerationRetry>;
    function Harness() {
        retry = useCanvasGenerationRetry({
            projectId: "project-auth-outcome",
            addedSkills: [],
            assets: [],
            nodesRef,
            connectionsRef: { current: [] },
            setNodes: (updater) => {
                nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
            },
            setRunningNodeId: () => {},
            startGenerationRequest: () => new AbortController(),
            finishGenerationRequest: () => {},
            bindGenerationTask: () => {},
            applyGenerationTaskResult: async () => {},
            regenerateImageBatch: async () => {},
        });
        return null;
    }

    try {
        renderToStaticMarkup(createElement(Harness));
        await retry(childNodes[0]!);
        expect(consumerCalls).toHaveLength(1);
        expect(consumerCalls[0]?.config.count).toBe("4");
        expect(consumerCalls[0]?.metadata?.edit).toBe("mask");
    } finally {
        buildConfigSpy.mockRestore();
        capabilitySpy.mockRestore();
        consumerSpy.mockRestore();
    }
});
