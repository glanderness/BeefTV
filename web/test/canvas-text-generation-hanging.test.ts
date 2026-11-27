import { describe, expect, spyOn, test } from "bun:test";

import {
    CANVAS_TEXT_GENERATION_TIMEOUT_MS,
    runBackendCanvasGenerationTask,
} from "@/lib/canvas/canvas-project-generation";
import { executeTextGeneration } from "@/pages/canvas/canvas-text-generation-executor";
import * as generationTaskApi from "@/services/api/generation-task";
import { ApiError } from "@/services/api/request";
import { waitForGenerationTask, type GenerationTask, type WaitForGenerationTaskOptions } from "@/services/api/task-center";
import { bindBackendCanvasGenerationResult } from "@/services/canvas-generation-consumer";
import * as generationTarget from "@/services/canvas-generation-target";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

describe("#356 canvas text generation streaming, bounded timeout, and non-media bind error fast-fail", () => {
    test("runBackendCanvasGenerationTask wires useTextEvents=true, onTextDelta, and bounded timeoutMs for text mode", async () => {
        const capturedWaitOptions: WaitForGenerationTaskOptions[] = [];
        const receivedDeltas: string[] = [];
        const config: AiConfig = {
            ...defaultConfig,
            model: "ch::test-text",
            channels: [{
                id: "ch",
                name: "Test",
                baseUrl: "https://api.example.com/v1",
                apiKey: "key",
                apiFormat: "openai",
                interfaceType: "chat-completion",
                models: ["test-text"],
            }],
        };

        const task: GenerationTask = {
            id: "task-text-1",
            type: "canvas_text",
            status: "succeeded",
            stage: "生成完成",
            resultJson: JSON.stringify({ mode: "text", text: "最终文本" }),
            createdAt: "2026-11-27T00:00:00.000Z",
            updatedAt: "2026-11-27T00:00:01.000Z",
        };

        const result = await runBackendCanvasGenerationTask(
            {
                projectId: "canvas-1",
                nodeId: "node-text-1",
                mode: "text",
                prompt: "写一句台词",
                config,
                onTextDelta: (delta) => receivedDeltas.push(delta),
            },
            {
                createId: () => "op-text-1",
                createTask: async () => ({ ...task, status: "running", resultJson: "" }),
                waitTask: async (_id, options) => {
                    capturedWaitOptions.push(options ?? {});
                    options?.onTextDelta?.("第一段");
                    options?.onTextDelta?.("第一段第二段");
                    options?.onTaskUpdate?.(task);
                    return task;
                },
            },
        );

        expect(result.text).toBe("最终文本");
        expect(receivedDeltas).toEqual(["第一段", "第一段第二段"]);
        expect(capturedWaitOptions).toHaveLength(1);
        expect(capturedWaitOptions[0]?.useTextEvents).toBe(true);
        expect(typeof capturedWaitOptions[0]?.onTextDelta).toBe("function");
        expect(capturedWaitOptions[0]?.timeoutMs).toBe(CANVAS_TEXT_GENERATION_TIMEOUT_MS);
        expect(Number.isFinite(capturedWaitOptions[0]?.timeoutMs)).toBe(true);
    });

    test("canvas_text hitting output_not_ready on bindOutput fails immediately instead of spinning 15 minutes", async () => {
        const textNode: CanvasNodeData = {
            id: "node-text-1",
            type: CanvasNodeType.Text,
            title: "文本",
            position: { x: 0, y: 0 },
            width: 300,
            height: 200,
            metadata: { status: "loading", taskId: "task-text-empty" },
        };
        const nodesRef = { current: [textNode] };
        const textTask: GenerationTask = {
            id: "task-text-empty",
            type: "canvas_text",
            status: "succeeded",
            stage: "生成完成",
            resultJson: JSON.stringify({ mode: "text", text: "   " }),
            createdAt: "2026-11-27T00:00:00.000Z",
            updatedAt: "2026-11-27T00:00:01.000Z",
        };
        let refreshCalls = 0;
        let sleepCalls = 0;
        let bindCalls = 0;

        await expect(
            bindBackendCanvasGenerationResult({
                canvasId: "canvas-1",
                nodeId: "node-text-1",
                task: textTask,
                outputIndex: 0,
                isCurrent: () => true,
                nodesRef,
                setNodes: () => undefined,
                runtime: {
                    hydrateOutputs: async () => undefined,
                    persistDocument: async () => undefined,
                    bindOutput: async () => {
                        bindCalls += 1;
                        throw new ApiError("文本任务还没有可绑定的结果", {
                            status: 412,
                            code: 412,
                            reason: "output_not_ready",
                        });
                    },
                    refreshTask: async () => {
                        refreshCalls += 1;
                        return textTask;
                    },
                    sleep: async () => {
                        sleepCalls += 1;
                    },
                    adoptConfirmedProjection: async () => undefined,
                },
            }),
        ).rejects.toThrow("文本任务还没有可绑定的结果");

        expect(bindCalls).toBe(1);
        expect(refreshCalls).toBe(0);
        expect(sleepCalls).toBe(0);
    });

    test("executeTextGeneration enables useTextEvents, bounded timeoutMs, and streams live deltas into the loading node", async () => {
        const prepareTargetMock = spyOn(generationTarget, "persistCanvasGenerationTarget").mockImplementation(async () => undefined);
        const observedOptions: generationTaskApi.BackendGenerationTaskOptions[] = [];
        const liveContentSnapshots: string[] = [];
        const sourceNode: CanvasNodeData = {
            id: "node-text-exec-1",
            type: CanvasNodeType.Text,
            title: "台词节点",
            position: { x: 100, y: 100 },
            width: 300,
            height: 200,
            metadata: { content: "" },
        };
        const nodesRef = { current: [sourceNode] as CanvasNodeData[] };
        const connectionsRef = { current: [] as CanvasConnection[] };
        const runTaskMock = spyOn(generationTaskApi, "runBackendGenerationTask").mockImplementation(async (options) => {
            observedOptions.push(options);
            options.onTextDelta?.("镜头一：");
            liveContentSnapshots.push(nodesRef.current.find((item) => item.id === sourceNode.id)?.metadata?.content ?? "");
            options.onTextDelta?.("镜头一：雨夜霓虹。");
            liveContentSnapshots.push(nodesRef.current.find((item) => item.id === sourceNode.id)?.metadata?.content ?? "");
            const task: GenerationTask = {
                id: "task-exec-text-1",
                type: "canvas_text",
                status: "succeeded",
                stage: "生成完成",
                resultJson: JSON.stringify({ mode: "text", text: "镜头一：雨夜霓虹。" }),
                createdAt: "2026-11-27T00:00:00.000Z",
                updatedAt: "2026-11-27T00:00:02.000Z",
            };
            options.onTaskUpdate?.(task);
            return { mode: "text" as const, text: "镜头一：雨夜霓虹。", task };
        });

        try {
            useCanvasStore.setState({
                projects: [{
                    id: "canvas-text-exec",
                    title: "Text Exec",
                    nodes: [sourceNode],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    createdAt: "2026-11-27T00:00:00.000Z",
                    updatedAt: "2026-11-27T00:00:00.000Z",
                }],
            });

            await executeTextGeneration({
                nodeId: sourceNode.id,
                sourceNode,
                prompt: "写一段开场镜头",
                effectivePrompt: "写一段开场镜头",
                generationConfig: defaultConfig,
                generationContext: {
                    referenceImages: [],
                    referenceVideos: [],
                    referenceAudios: [],
                    resolvedCharacterVersions: [],
                } as never,
                controller: new AbortController(),
                editingTextNode: false,
                projectId: "canvas-text-exec",
                setNodes: (value) => {
                    nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value;
                },
                setConnections: (value) => {
                    connectionsRef.current = typeof value === "function" ? value(connectionsRef.current) : value;
                },
                startGenerationRequest: () => undefined,
                finishGenerationRequest: () => undefined,
                bindGenerationTask: () => undefined,
                applyGenerationTaskResult: async () => undefined,
                registerPendingNodeIds: () => undefined,
                clientOperationId: "op-exec-text",
                nodesRef,
                canvasNodes: nodesRef.current,
                canvasConnections: connectionsRef.current,
            });

            expect(observedOptions).toHaveLength(1);
            expect(observedOptions[0]?.useTextEvents).toBe(true);
            expect(observedOptions[0]?.timeoutMs).toBe(CANVAS_TEXT_GENERATION_TIMEOUT_MS);
            expect(Number.isFinite(observedOptions[0]?.timeoutMs)).toBe(true);
            expect(liveContentSnapshots).toEqual(["镜头一：", "镜头一：雨夜霓虹。"]);
        } finally {
            runTaskMock.mockRestore();
            prepareTargetMock.mockRestore();
            useCanvasStore.setState({ projects: [] });
        }
    });

    test("waitForGenerationTask enforces timeoutMs inside an open SSE stream sending heartbeats forever", async () => {
        const encoder = new TextEncoder();
        let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
        let streamCancelled = false;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(": heartbeat\n\n"));
                    heartbeatTimer = setInterval(() => {
                        try {
                            controller.enqueue(encoder.encode(": heartbeat\n\n"));
                        } catch {
                            if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
                        }
                    }, 15);
                },
                cancel() {
                    streamCancelled = true;
                    if (heartbeatTimer !== undefined) {
                        clearInterval(heartbeatTimer);
                        heartbeatTimer = undefined;
                    }
                },
            });
            return new Response(stream, {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        }) as unknown as typeof fetch;

        const runningTask: GenerationTask = {
            id: "task-sse-forever",
            type: "canvas_text",
            status: "running",
            stage: "生成中",
            createdAt: "2026-11-27T00:00:00.000Z",
            updatedAt: "2026-11-27T00:00:01.000Z",
        };

        const startedAt = Date.now();
        try {
            let caught: unknown;
            try {
                await waitForGenerationTask(runningTask.id, {
                    initialTask: runningTask,
                    useTextEvents: true,
                    timeoutMs: 50,
                });
            } catch (error) {
                caught = error;
            }
            const elapsed = Date.now() - startedAt;
            expect(caught).toBeInstanceOf(Error);
            expect((caught as Error).name).not.toBe("AbortError");
            expect((caught as Error).message).toContain("超时");
            expect(elapsed).toBeLessThan(500);
            expect(streamCancelled).toBe(true);
        } finally {
            if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
            globalThis.fetch = originalFetch;
        }
    });
});
