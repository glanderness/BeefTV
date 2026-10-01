import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { bindBackendCanvasGenerationResult } from "@/services/canvas-generation-consumer";
import { hydrateBackendGeneratedAsset, hydrateBackendGeneratedOutputs } from "@/services/project-asset-sync";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";
import type { Asset } from "@/stores/use-asset-store";

const generationSource = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-generation.ts"), "utf8");
const consumerSource = readFileSync(resolve(import.meta.dir, "../src/services/canvas-generation-consumer.ts"), "utf8");
const syncSource = readFileSync(resolve(import.meta.dir, "../src/services/project-asset-sync.ts"), "utf8");

const completeImageAsset = {
    id: "generation_abc",
    kind: "image",
    title: "生成图",
    coverUrl: "https://example.com/a.png",
    tags: ["生成"],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    data: { dataUrl: "https://example.com/a.png", width: 8, height: 8, bytes: 12, mimeType: "image/png" },
} as Asset;

function canvasNode(id: string, title: string, metadata: CanvasNodeData["metadata"], position = { x: 11, y: 22 }): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title,
        position,
        width: 320,
        height: 220,
        metadata,
    };
}

function canvasProject(id: string, nodes: CanvasNodeData[], revision = 3): CanvasProject {
    return {
        id,
        revision,
        title: "画布",
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

function succeededTask(): GenerationTask {
    return {
        id: "task-1",
        type: "canvas_image",
        status: "succeeded",
        prompt: "猫",
        attempts: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        outputs: [{ outputIndex: 0, mediaType: "image", materializedAssetId: "generation_abc" }],
    };
}

describe("backend canvas bind cutover", () => {
    test("use-canvas-generation binds succeeded backend tasks without snapshot doublewrite", () => {
        const applyStart = generationSource.indexOf("const applyGenerationTaskResult = useCallback(");
        const applyEnd = generationSource.indexOf("const retrieveTaskResult = useCallback", applyStart);
        const apply = generationSource.slice(applyStart, applyEnd);
        expect(apply).toContain("bindBackendCanvasGenerationResult");
        expect(apply).not.toContain("applyStoredTaskResult");
        expect(apply).not.toContain("persistCanvasGenerationEffect");
        expect(apply).not.toContain("consumeGenerationTaskNode");
        expect(apply).not.toContain("applyRecoveredGenerationTaskResultToNodes");

        const recoverStart = generationSource.indexOf("export async function recoverCanvasGenerationTaskNode");
        const recoverEnd = generationSource.indexOf("export function useCanvasGeneration", recoverStart);
        const recover = generationSource.slice(recoverStart, recoverEnd);
        expect(recover).toContain("await input.applyGenerationTaskResult");
        expect(recover).not.toContain("storyboardRowsFromTask");
    });

    test("bind helper flushes the journal then binds generation fields only", () => {
        const bindStart = consumerSource.indexOf("export async function bindBackendCanvasGenerationResult");
        const bindEnd = consumerSource.indexOf("function overlayBoundGenerationOnLiveCanvas", bindStart);
        const bind = consumerSource.slice(bindStart, bindEnd);
        expect(bind).toContain("persistDocument");
        expect(bind).toContain("bindOutput");
        expect(bind).toContain("recordConfirmedBindProjection");
        expect(bind).not.toContain("persistCanvasGenerationEffect");
        expect(bind).not.toContain("applyExternalCanvasRevision");
    });

    test("message consumers hydrate backend outputs instead of rematerializing", () => {
        const start = syncSource.indexOf("export async function consumeGenerationTaskMessage");
        const end = syncSource.indexOf("export function generationTaskMaterializedUrls", start);
        const consume = syncSource.slice(start, end);
        expect(consume).toContain("hasBackendDeliveredGenerationOutputs");
        expect(consume).toContain("hydrateBackendGeneratedOutputs");
        expect(consume).not.toContain("uploadGeneratedAssetToConfiguredSources");
    });
});

describe("hydrateBackendGeneratedAsset", () => {
    test("inserts the backend asset without downloading or uploading a blob", async () => {
        const written: Asset[] = [];
        const fetched: string[] = [];
        const asset = await hydrateBackendGeneratedAsset("generation_abc", undefined, {
            getAsset: async (id) => {
                fetched.push(id);
                return { asset: completeImageAsset };
            },
            readAssets: () => [],
            writeAsset: (item) => {
                written.push(item);
            },
        });
        expect(fetched).toEqual(["generation_abc"]);
        expect(asset.id).toBe("generation_abc");
        expect(written).toHaveLength(1);
        expect(written[0]?.id).toBe("generation_abc");
    });

    test("reuses an already hydrated asset and does not refetch", async () => {
        let fetches = 0;
        const asset = await hydrateBackendGeneratedAsset("generation_abc", undefined, {
            getAsset: async () => {
                fetches += 1;
                return { asset: completeImageAsset };
            },
            readAssets: () => [completeImageAsset],
            writeAsset: () => {
                throw new Error("should not rewrite");
            },
        });
        expect(fetches).toBe(0);
        expect(asset.id).toBe("generation_abc");
    });

    test("hydrates every delivered output id", async () => {
        const fetched: string[] = [];
        await hydrateBackendGeneratedOutputs(
            {
                outputs: [
                    { outputIndex: 0, mediaType: "image", materializedAssetId: "generation_abc" },
                    { outputIndex: 1, mediaType: "image", materializedAssetId: "generation_def" },
                ],
            },
            undefined,
            {
                getAsset: async (id) => {
                    fetched.push(id);
                    return { asset: { ...completeImageAsset, id } };
                },
                readAssets: () => [],
                writeAsset: () => undefined,
            },
        );
        expect(fetched).toEqual(["generation_abc", "generation_def"]);
    });
});

describe("bindBackendCanvasGenerationResult", () => {
    beforeEach(() => {
        useCanvasStore.setState({ projects: [] });
    });

    test("flushes drafts then overlays generation fields without replacing title or sibling drafts", async () => {
        const bound = canvasNode("node-1", "手工标题", { taskId: "task-1", status: "loading", prompt: "猫" }, { x: 11, y: 22 });
        const sibling = canvasNode("node-2", "未提交草稿", { status: "idle", prompt: "本地改过" }, { x: 40, y: 50 });
        const live = canvasProject("canvas-1", [bound, sibling], 3);
        useCanvasStore.setState({ projects: [live] });
        const nodesRef = { current: [bound, sibling] };
        const setNodesLog: CanvasNodeData[][] = [];
        const order: string[] = [];
        let confirmed: CanvasProject | undefined;

        await bindBackendCanvasGenerationResult({
            canvasId: "canvas-1",
            nodeId: "node-1",
            task: succeededTask(),
            isCurrent: () => true,
            nodesRef,
            setNodes: (value) => {
                const next = typeof value === "function" ? value(nodesRef.current) : value;
                nodesRef.current = next;
                setNodesLog.push(next);
            },
            runtime: {
                hydrateOutputs: async () => undefined,
                persistDocument: async () => {
                    order.push("flush");
                },
                bindOutput: async (input) => {
                    order.push("bind");
                    return {
                        op: "canvas.task.bind",
                        opId: input.operationId,
                        replayed: false,
                        revision: 4,
                        result: {
                            applied: true,
                            canvasId: "canvas-1",
                            nodeId: "node-1",
                            taskId: "task-1",
                            content: "/api/resources/res-1/file",
                            storageKey: "resource:res-1",
                            assetId: "generation_abc",
                            effectKey: input.operationId,
                            revision: 4,
                        },
                    };
                },
                loadJournal: async () => ({
                    userScope: "user-a",
                    canvasId: "canvas-1",
                    confirmedRevision: 3,
                    confirmedSnapshot: live,
                    inFlight: null,
                }),
                recordConfirmed: async (project) => {
                    order.push("receipt");
                    confirmed = project;
                },
                activeScope: () => "user-a",
            },
        });

        expect(order).toEqual(["flush", "bind", "receipt"]);
        const nextBound = nodesRef.current.find((item) => item.id === "node-1");
        const nextSibling = nodesRef.current.find((item) => item.id === "node-2");
        expect(nextBound?.title).toBe("手工标题");
        expect(nextBound?.position).toEqual({ x: 11, y: 22 });
        expect(nextBound?.metadata?.prompt).toBe("猫");
        expect(nextBound?.metadata?.status).toBe("success");
        expect(nextBound?.metadata?.content).toBe("/api/resources/res-1/file");
        expect(nextSibling?.title).toBe("未提交草稿");
        expect(nextSibling?.metadata?.prompt).toBe("本地改过");
        expect(confirmed?.nodes.find((item) => item.id === "node-1")?.metadata?.content).toBe("/api/resources/res-1/file");
        expect(confirmed?.nodes.find((item) => item.id === "node-2")?.title).toBe("未提交草稿");
        expect(useCanvasStore.getState().projects[0]?.revision).toBe(4);
        expect(setNodesLog.length).toBeGreaterThan(0);
    });

    test("late response after canvas switch still binds the original canvas and leaves the next canvas untouched", async () => {
        const originalNode = canvasNode("node-1", "原画布节点", { taskId: "task-1", status: "loading" });
        const nextNode = canvasNode("node-next", "下一张画布", { status: "idle", prompt: "精确草稿" });
        const original = canvasProject("canvas-1", [originalNode], 3);
        const next = canvasProject("canvas-2", [nextNode], 1);
        useCanvasStore.setState({ projects: [original, next] });
        const nodesRef = { current: [originalNode] };
        let liveCurrent = true;

        await bindBackendCanvasGenerationResult({
            canvasId: "canvas-1",
            nodeId: "node-1",
            task: succeededTask(),
            isCurrent: () => liveCurrent,
            nodesRef,
            setNodes: (value) => {
                const nextNodes = typeof value === "function" ? value(nodesRef.current) : value;
                nodesRef.current = nextNodes;
            },
            runtime: {
                hydrateOutputs: async () => undefined,
                persistDocument: async (id) => {
                    expect(id).toBe("canvas-1");
                },
                bindOutput: async (input) => {
                    liveCurrent = false;
                    nodesRef.current = [nextNode];
                    return {
                        op: "canvas.task.bind",
                        opId: input.operationId,
                        replayed: false,
                        revision: 4,
                        result: {
                            content: "/api/resources/res-1/file",
                            storageKey: "resource:res-1",
                            assetId: "generation_abc",
                            effectKey: input.operationId,
                            revision: 4,
                        },
                    };
                },
                loadJournal: async (canvasId) => ({
                    userScope: "user-a",
                    canvasId,
                    confirmedRevision: 3,
                    confirmedSnapshot: original,
                    inFlight: null,
                }),
                recordConfirmed: async () => undefined,
                activeScope: () => "user-a",
            },
        });

        expect(nodesRef.current[0]?.id).toBe("node-next");
        expect(nodesRef.current[0]?.title).toBe("下一张画布");
        expect(nodesRef.current[0]?.metadata?.prompt).toBe("精确草稿");
        expect(nodesRef.current[0]?.metadata?.content).toBeUndefined();
        const storedOriginal = useCanvasStore.getState().projects.find((project) => project.id === "canvas-1");
        const storedNext = useCanvasStore.getState().projects.find((project) => project.id === "canvas-2");
        expect(storedOriginal?.nodes[0]?.metadata?.content).toBe("/api/resources/res-1/file");
        expect(storedOriginal?.nodes[0]?.title).toBe("原画布节点");
        expect(storedNext?.nodes[0]?.title).toBe("下一张画布");
        expect(storedNext?.nodes[0]?.metadata?.prompt).toBe("精确草稿");
        expect(storedNext?.nodes[0]?.metadata?.content).toBeUndefined();
    });

    test("attach errors do not fall back to a full snapshot write", async () => {
        const bound = canvasNode("node-1", "手工标题", { taskId: "task-1", status: "loading" });
        useCanvasStore.setState({ projects: [canvasProject("canvas-1", [bound])] });
        const nodesRef = { current: [bound] };
        let confirmed = 0;

        await expect(
            bindBackendCanvasGenerationResult({
                canvasId: "canvas-1",
                nodeId: "node-1",
                task: succeededTask(),
                isCurrent: () => true,
                nodesRef,
                setNodes: (value) => {
                    nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value;
                },
                runtime: {
                    hydrateOutputs: async () => undefined,
                    persistDocument: async () => undefined,
                    bindOutput: async () => {
                        throw new Error("绑定失败");
                    },
                    loadJournal: async () => ({
                        userScope: "user-a",
                        canvasId: "canvas-1",
                        confirmedRevision: 3,
                        confirmedSnapshot: canvasProject("canvas-1", [bound]),
                        inFlight: null,
                    }),
                    recordConfirmed: async () => {
                        confirmed += 1;
                    },
                    activeScope: () => "user-a",
                },
            }),
        ).rejects.toThrow("绑定失败");

        expect(confirmed).toBe(0);
        expect(nodesRef.current[0]?.metadata?.status).toBe("loading");
        expect(nodesRef.current[0]?.title).toBe("手工标题");
    });

    test("account switch after a deferred await does not write the next user canvas", async () => {
        const originalNode = canvasNode("node-1", "原用户节点", { taskId: "task-1", status: "loading" });
        const nextNode = canvasNode("node-next", "下一账号草稿", { status: "idle", prompt: "不可覆盖" });
        useCanvasStore.setState({
            projects: [canvasProject("canvas-1", [originalNode]), canvasProject("canvas-2", [nextNode])],
        });
        const nodesRef = { current: [originalNode] };
        let scope = "user-a";
        let confirmedScope: string | undefined;

        await bindBackendCanvasGenerationResult({
            canvasId: "canvas-1",
            nodeId: "node-1",
            task: succeededTask(),
            isCurrent: () => scope === "user-a",
            nodesRef,
            setNodes: (value) => {
                nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value;
            },
            runtime: {
                hydrateOutputs: async () => undefined,
                persistDocument: async () => undefined,
                bindOutput: async (input) => {
                    scope = "user-b";
                    nodesRef.current = [nextNode];
                    return {
                        op: "canvas.task.bind",
                        opId: input.operationId,
                        replayed: false,
                        revision: 4,
                        result: { content: "/api/resources/res-1/file", revision: 4 },
                    };
                },
                loadJournal: async () => ({
                    userScope: "user-a",
                    canvasId: "canvas-1",
                    confirmedRevision: 3,
                    confirmedSnapshot: canvasProject("canvas-1", [originalNode]),
                    inFlight: null,
                }),
                recordConfirmed: async (_project, nextScope) => {
                    confirmedScope = nextScope;
                },
                activeScope: () => scope,
            },
        });

        expect(confirmedScope).toBeUndefined();
        expect(nodesRef.current[0]?.title).toBe("下一账号草稿");
        expect(nodesRef.current[0]?.metadata?.prompt).toBe("不可覆盖");
        expect(useCanvasStore.getState().projects.find((project) => project.id === "canvas-2")?.nodes[0]?.metadata?.prompt).toBe("不可覆盖");
        expect(useCanvasStore.getState().projects.find((project) => project.id === "canvas-1")?.nodes[0]?.metadata?.status).toBe("loading");
    });
});
