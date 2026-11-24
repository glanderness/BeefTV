import "./helpers/localforage-bun-memory";
import { describe, expect, test } from "bun:test";
import type { Dispatch, SetStateAction } from "react";
import { createCanvasPageUiStore } from "../src/stores/canvas/use-canvas-page-ui-store";
import { useCanvasStore } from "../src/stores/canvas/use-canvas-store";
import { defaultConfig } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../src/types/canvas";
import { executeImageGeneration } from "../src/pages/canvas/canvas-image-generation-executor";
import { CANVAS_LEAVE_ABORT_REASON } from "../src/pages/canvas/canvas-generation-executor-types";
import { createCanvasOwnerLifetime } from "../src/pages/canvas/canvas-owner-epoch";
import { apiClient } from "../src/services/api/request";

describe("switching canvases during image generation preserves generating nodes (#623)", () => {
    test("switching from canvas A to canvas B does not cancel canvas A generating nodes or overwrite canvas A with canvas B nodes", async () => {
        const promptNodeA: CanvasNodeData = {
            id: "prompt-a",
            type: CanvasNodeType.Text,
            title: "分镜提示词",
            position: { x: 100, y: 100 },
            width: 320,
            height: 220,
            metadata: { content: "赛博朋克雨夜猫", prompt: "赛博朋克雨夜猫", status: "idle" },
        };
        const nodeB: CanvasNodeData = {
            id: "existing-b",
            type: CanvasNodeType.Text,
            title: "画布 B 节点",
            position: { x: 50, y: 50 },
            width: 320,
            height: 220,
            metadata: { content: "画布 B 内容", status: "success" },
        };

        useCanvasStore.setState({
            projects: [
                {
                    id: "canvas-a",
                    title: "画布 A",
                    revision: 1,
                    nodes: [promptNodeA],
                    connections: [],
                    viewport: { x: 0, y: 0, k: 1 },
                    updatedAt: "2026-11-24T00:00:00Z",
                },
                {
                    id: "canvas-b",
                    title: "画布 B",
                    revision: 1,
                    nodes: [nodeB],
                    connections: [],
                    viewport: { x: 0, y: 0, k: 1 },
                    updatedAt: "2026-11-24T00:00:00Z",
                },
            ],
        });

        let activeProjectId = "canvas-a";
        let liveNodes: CanvasNodeData[] = [promptNodeA];
        let liveConnections: CanvasConnection[] = [];
        const nodesRef = { current: liveNodes };
        const setNodes: Dispatch<SetStateAction<CanvasNodeData[]>> = (updater) => {
            liveNodes = typeof updater === "function" ? updater(liveNodes) : updater;
            nodesRef.current = liveNodes;
        };
        const setConnections: Dispatch<SetStateAction<CanvasConnection[]>> = (updater) => {
            liveConnections = typeof updater === "function" ? updater(liveConnections) : updater;
        };

        const controller = new AbortController();
        const prevAdapter = apiClient.defaults.adapter;
        let taskRequestStarted!: () => void;
        const requestStartedPromise = new Promise<void>((resolve) => {
            taskRequestStarted = resolve;
        });
        let createdTasks = 0;
        apiClient.defaults.adapter = (config) => {
            const url = config.url || "";
            if (url.includes("/canvas-projects") || url.includes("/ops/canvas.document")) {
                return Promise.resolve({
                    data: { code: 0, data: { id: "canvas-a", revision: 2 }, msg: "ok" },
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    config,
                });
            }
            if (config.method?.toLowerCase() === "post" && url === "/tasks") {
                createdTasks += 1;
                const taskId = `task-canvas-a-${createdTasks}`;
                return Promise.resolve({
                    data: {
                        code: 0,
                        data: {
                            id: taskId,
                            type: "canvas_image",
                            status: "running",
                            prompt: "赛博朋克雨夜猫",
                            attempts: 1,
                            createdAt: "2026-11-24T00:00:00Z",
                            updatedAt: "2026-11-24T00:00:00Z",
                        },
                        msg: "ok",
                    },
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    config,
                });
            }
            taskRequestStarted();
            return new Promise((_resolve, reject) => {
                const signal = config.signal as AbortSignal | undefined;
                if (signal?.aborted) {
                    reject(new DOMException("Aborted", "AbortError"));
                    return;
                }
                signal?.addEventListener(
                    "abort",
                    () => reject(new DOMException("Aborted", "AbortError")),
                    { once: true },
                );
            });
        };

        try {
            const runPromise = executeImageGeneration({
                pageUi: createCanvasPageUiStore(),
                projectId: "canvas-a",
                isActiveProject: () => activeProjectId === "canvas-a",
                nodeId: promptNodeA.id,
                sourceNode: promptNodeA,
                canvasNodes: [promptNodeA],
                canvasConnections: [],
                prompt: "赛博朋克雨夜猫",
                effectivePrompt: "赛博朋克雨夜猫",
                generationConfig: { ...defaultConfig, count: "2", imageModel: "beeftv::test-image", model: "beeftv::test-image" },
                generationContext: {
                    prompt: "赛博朋克雨夜猫",
                    referenceImages: [],
                    referenceVideos: [],
                    referenceAudios: [],
                    resolvedCharacterVersions: [],
                    resolvedCharacterVoices: [],
                },
                controller,
                editingTextNode: false,
                nodesRef,
                setNodes,
                setConnections,
                startGenerationRequest: () => controller,
                finishGenerationRequest: () => {},
                bindGenerationTask: () => {},
                applyGenerationTaskResult: async () => {},
                showError: () => {},
                styleMetadata: {},
                skillMetadata: {},
                registerPendingNodeIds: () => {},
            });

            await requestStartedPromise;
            // Confirm generating root + 2 children were placed on canvas A before switching.
            const canvasABeforeSwitch = useCanvasStore.getState().projects.find((p) => p.id === "canvas-a")!;
            expect(canvasABeforeSwitch.nodes.length).toBe(4);
            expect(canvasABeforeSwitch.nodes.filter((n) => n.type === CanvasNodeType.Image && n.metadata?.status === "loading").length).toBe(3);

            // Simulate switching to canvas B in the same project while canvas A is still generating.
            activeProjectId = "canvas-b";
            liveNodes = [nodeB];
            liveConnections = [];
            nodesRef.current = liveNodes;
            controller.abort(CANVAS_LEAVE_ABORT_REASON);

            await runPromise;

            // Canvas A must retain its 4 nodes (prompt + generating root + 2 batch children) and NOT be overwritten with canvas B!
            const canvasAAfterSwitch = useCanvasStore.getState().projects.find((p) => p.id === "canvas-a")!;
            expect(canvasAAfterSwitch.nodes.map((n) => n.id)).toEqual(canvasABeforeSwitch.nodes.map((n) => n.id));
            expect(canvasAAfterSwitch.nodes.filter((n) => n.type === CanvasNodeType.Image && n.metadata?.status === "loading").length).toBe(3);

            // Canvas B live state must remain untouched.
            expect(liveNodes.map((n) => n.id)).toEqual(["existing-b"]);
        } finally {
            apiClient.defaults.adapter = prevAdapter;
        }
    });

    test("explicit cancel while staying on canvas A still removes incomplete generating batch children", async () => {
        const promptNodeA: CanvasNodeData = {
            id: "prompt-cancel-a",
            type: CanvasNodeType.Text,
            title: "分镜提示词",
            position: { x: 100, y: 100 },
            width: 320,
            height: 220,
            metadata: { content: "极光雪原", prompt: "极光雪原", status: "idle" },
        };

        useCanvasStore.setState({
            projects: [
                {
                    id: "canvas-cancel-a",
                    title: "画布 A",
                    revision: 1,
                    nodes: [promptNodeA],
                    connections: [],
                    viewport: { x: 0, y: 0, k: 1 },
                    updatedAt: "2026-11-24T00:00:00Z",
                },
            ],
        });

        let liveNodes: CanvasNodeData[] = [promptNodeA];
        let liveConnections: CanvasConnection[] = [];
        const nodesRef = { current: liveNodes };
        const setNodes: Dispatch<SetStateAction<CanvasNodeData[]>> = (updater) => {
            liveNodes = typeof updater === "function" ? updater(liveNodes) : updater;
            nodesRef.current = liveNodes;
        };
        const setConnections: Dispatch<SetStateAction<CanvasConnection[]>> = (updater) => {
            liveConnections = typeof updater === "function" ? updater(liveConnections) : updater;
        };

        const controller = new AbortController();
        const prevAdapter = apiClient.defaults.adapter;
        let taskRequestStarted!: () => void;
        const requestStartedPromise = new Promise<void>((resolve) => {
            taskRequestStarted = resolve;
        });
        let createdTasks = 0;
        apiClient.defaults.adapter = (config) => {
            const url = config.url || "";
            if (url.includes("/canvas-projects") || url.includes("/ops/canvas.document")) {
                return Promise.resolve({
                    data: { code: 0, data: { id: "canvas-a", revision: 2 }, msg: "ok" },
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    config,
                });
            }
            if (config.method?.toLowerCase() === "post" && url === "/tasks") {
                createdTasks += 1;
                const taskId = `task-canvas-a-${createdTasks}`;
                return Promise.resolve({
                    data: {
                        code: 0,
                        data: {
                            id: taskId,
                            type: "canvas_image",
                            status: "running",
                            prompt: "赛博朋克雨夜猫",
                            attempts: 1,
                            createdAt: "2026-11-24T00:00:00Z",
                            updatedAt: "2026-11-24T00:00:00Z",
                        },
                        msg: "ok",
                    },
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    config,
                });
            }
            taskRequestStarted();
            return new Promise((_resolve, reject) => {
                const signal = config.signal as AbortSignal | undefined;
                if (signal?.aborted) {
                    reject(new DOMException("Aborted", "AbortError"));
                    return;
                }
                signal?.addEventListener(
                    "abort",
                    () => reject(new DOMException("Aborted", "AbortError")),
                    { once: true },
                );
            });
        };

        try {
            const runPromise = executeImageGeneration({
                pageUi: createCanvasPageUiStore(),
                projectId: "canvas-cancel-a",
                isActiveProject: () => true,
                nodeId: promptNodeA.id,
                sourceNode: promptNodeA,
                canvasNodes: [promptNodeA],
                canvasConnections: [],
                prompt: "极光雪原",
                effectivePrompt: "极光雪原",
                generationConfig: { ...defaultConfig, count: "2", imageModel: "beeftv::test-image", model: "beeftv::test-image" },
                generationContext: {
                    prompt: "极光雪原",
                    referenceImages: [],
                    referenceVideos: [],
                    referenceAudios: [],
                    resolvedCharacterVersions: [],
                    resolvedCharacterVoices: [],
                },
                controller,
                editingTextNode: false,
                nodesRef,
                setNodes,
                setConnections,
                startGenerationRequest: () => controller,
                finishGenerationRequest: () => {},
                bindGenerationTask: () => {},
                applyGenerationTaskResult: async () => {},
                showError: () => {},
                styleMetadata: {},
                skillMetadata: {},
                registerPendingNodeIds: () => {},
            });

            await requestStartedPromise;
            expect(liveNodes.length).toBe(4);

            // Explicit user cancel without leaving the canvas removes the 2 incomplete batch children and resets the root to idle.
            controller.abort();
            await runPromise;

            expect(liveNodes.length).toBe(2);
            expect(liveNodes[0]?.id).toBe("prompt-cancel-a");
            expect(liveNodes[1]?.type).toBe(CanvasNodeType.Image);
            expect(liveNodes[1]?.metadata?.status).toBe("idle");
            expect(liveNodes[1]?.metadata?.batchChildIds).toBeUndefined();
            const stored = useCanvasStore.getState().projects.find((p) => p.id === "canvas-cancel-a")!;
            expect(stored.nodes.map((n) => n.id)).toEqual(liveNodes.map((n) => n.id));
        } finally {
            apiClient.defaults.adapter = prevAdapter;
        }
    });

    test("switching canvases during async onSubmissionPlan before abort fires never writes canvas A placeholders into canvas B live state", async () => {
        const promptNodeA: CanvasNodeData = {
            id: "prompt-prep-a",
            type: CanvasNodeType.Text,
            title: "分镜提示词 A",
            position: { x: 100, y: 100 },
            width: 320,
            height: 220,
            metadata: { content: "日落海边", prompt: "日落海边", status: "idle" },
        };
        const nodeB: CanvasNodeData = {
            id: "existing-prep-b",
            type: CanvasNodeType.Text,
            title: "画布 B 节点",
            position: { x: 50, y: 50 },
            width: 320,
            height: 220,
            metadata: { content: "画布 B 内容", status: "success" },
        };

        useCanvasStore.setState({
            projects: [
                {
                    id: "canvas-prep-a",
                    title: "画布 A",
                    revision: 1,
                    nodes: [promptNodeA],
                    connections: [],
                    viewport: { x: 0, y: 0, k: 1 },
                    updatedAt: "2026-11-24T00:00:00Z",
                },
                {
                    id: "canvas-prep-b",
                    title: "画布 B",
                    revision: 1,
                    nodes: [nodeB],
                    connections: [],
                    viewport: { x: 0, y: 0, k: 1 },
                    updatedAt: "2026-11-24T00:00:00Z",
                },
            ],
        });

        const lifetime = createCanvasOwnerLifetime();
        let activeProjectId = "canvas-prep-a";
        const capturedOwner = lifetime.capture("canvas-prep-a");
        const isActiveProject = () => lifetime.matches(capturedOwner, activeProjectId);

        let liveNodes: CanvasNodeData[] = [promptNodeA];
        let liveConnections: CanvasConnection[] = [];
        const nodesRef = { current: liveNodes };
        const setNodes: Dispatch<SetStateAction<CanvasNodeData[]>> = (updater) => {
            liveNodes = typeof updater === "function" ? updater(liveNodes) : updater;
            nodesRef.current = liveNodes;
        };
        const setConnections: Dispatch<SetStateAction<CanvasConnection[]>> = (updater) => {
            liveConnections = typeof updater === "function" ? updater(liveConnections) : updater;
        };

        const controller = new AbortController();
        await expect(
            executeImageGeneration({
                pageUi: createCanvasPageUiStore(),
                projectId: "canvas-prep-a",
                isActiveProject,
                nodeId: promptNodeA.id,
                sourceNode: promptNodeA,
                canvasNodes: [promptNodeA],
                canvasConnections: [],
                prompt: "日落海边",
                effectivePrompt: "日落海边",
                clientOperationId: "op-prep-switch-1",
                generationConfig: { ...defaultConfig, count: "2", imageModel: "beeftv::test-image", model: "beeftv::test-image" },
                generationContext: {
                    prompt: "日落海边",
                    referenceImages: [],
                    referenceVideos: [],
                    referenceAudios: [],
                    resolvedCharacterVersions: [],
                    resolvedCharacterVoices: [],
                },
                controller,
                editingTextNode: false,
                nodesRef,
                setNodes,
                setConnections,
                startGenerationRequest: () => controller,
                finishGenerationRequest: () => {},
                bindGenerationTask: () => {},
                applyGenerationTaskResult: async () => {},
                showError: () => {},
                styleMetadata: {},
                skillMetadata: {},
                registerPendingNodeIds: () => {},
                onSubmissionPlan: async () => {
                    // Simulate render-phase route switch & owner lifetime invalidation BEFORE useEffect cleanup calls controller.abort().
                    activeProjectId = "canvas-prep-b";
                    lifetime.invalidate();
                    liveNodes = [nodeB];
                    liveConnections = [];
                    nodesRef.current = liveNodes;
                },
            }),
        ).rejects.toMatchObject({ name: "AbortError" });

        // Canvas B live state must remain completely untouched.
        expect(liveNodes.map((n) => n.id)).toEqual(["existing-prep-b"]);
        expect(liveConnections).toEqual([]);
    });
});
