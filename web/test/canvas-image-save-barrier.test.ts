import { beforeEach, expect, test } from "bun:test";
import { runCanvasGenerationTaskToConsumer } from "@/lib/canvas/canvas-project-generation";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
import { canvasGenerationFailureMetadata, canvasGenerationRetryBlocked, canvasTaskFailureMetadata } from "@/pages/canvas/canvas-generation-failure";
import { ApiError } from "@/services/api/request";
import { CanvasGenerationDurableAckError, persistCanvasGenerationTarget } from "@/services/canvas-generation-consumer";
import { CanvasBackendSubmitPausedError } from "@/services/canvas-revision-conflict";
import type { GenerationTask } from "@/services/api/task-center";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType } from "@/types/canvas";
import { executeImageGeneration } from "@/pages/canvas/canvas-image-generation-executor";
import type { CanvasGenerationExecution } from "@/pages/canvas/canvas-generation-executor-types";

const project: CanvasProject = { id: "canvas-1", title: "画布", createdAt: "2026-01-01", updatedAt: "2026-01-01", revision: 3, nodes: [{ id: "new-image", type: CanvasNodeType.Image, title: "新结果", position: { x: 0, y: 0 }, width: 320, height: 320, metadata: { status: "loading" } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "grid", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [] };
const input = { projectId: project.id, nodeId: "new-image", mode: "image" as const, prompt: "小猫", config: {} as never, clientOperationId: "test-image-save" };
const task: GenerationTask = { id: "task-original", type: "canvas_image", status: "succeeded", prompt: input.prompt, attempts: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01", failureDiagnostics: { source: "unknown", requests: [{ operation: "image_generate", method: "POST", dispatched: true, outcome: "response_received", httpStatus: 200, startedAt: "2026-01-01", durationMs: 10 }] } };

beforeEach(() => useCanvasStore.setState({ projects: [structuredClone(project)] }));

test("image submission waits for the target node save and shares one submission for a rapid double click", async () => {
    const events: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const dependencies = {
        prepareTarget: async (options: Parameters<typeof persistCanvasGenerationTarget>[0]) => persistCanvasGenerationTarget(options, async (_id, patch) => {
            expect(patch.nodes?.map((node) => node.id)).toEqual([input.nodeId]);
            events.push("save"); await pending; events.push("saved");
        }),
        bindTask: () => undefined,
        consumeTask: async () => { events.push("consume"); },
        runTask: async (options: Parameters<NonNullable<Parameters<typeof runCanvasGenerationTaskToConsumer>[1]["runTask"]>>[0]) => {
            events.push("submit"); options.onTaskCreated?.(task); return { images: [] };
        },
    };
    const first = runCanvasGenerationTaskToConsumer(input, dependencies);
    const second = runCanvasGenerationTaskToConsumer(input, dependencies);
    expect(events).toEqual(["save"]);
    release(); await Promise.all([first, second]);
    expect(events).toEqual(["save", "saved", "submit", "consume"]);
});

for (const error of [new ApiError("保存冲突", { status: 409, reason: "conflict" }), new CanvasBackendSubmitPausedError(), new Error("disk failure")]) {
    test(`a rejected target save creates no paid task: ${error.name}`, async () => {
        let submissions = 0;
        await expect(runCanvasGenerationTaskToConsumer(input, {
            prepareTarget: (options) => persistCanvasGenerationTarget(options, async () => { throw error; }),
            bindTask: () => undefined, consumeTask: async () => undefined,
            runTask: async () => { submissions++; return { images: [] }; },
        })).rejects.toThrow("未开始生成");
        expect(submissions).toBe(0);
        expect(useCanvasStore.getState().projects[0]?.nodes.map((node) => node.id)).toEqual([input.nodeId]);
    });
}

test("a target deleted while saving stops before submission and is not recreated", async () => {
    await expect(persistCanvasGenerationTarget({ ...input, expectedScope: captureUserScope() }, async () => {
        useCanvasStore.setState({ projects: [{ ...project, nodes: [] }] });
    })).rejects.toThrow("生成节点已不存在");
    expect(useCanvasStore.getState().projects[0]?.nodes).toEqual([]);
});

test("abort and abandoned account saves cannot proceed to a paid task", async () => {
    const controller = new AbortController();
    await expect(persistCanvasGenerationTarget({ ...input, signal: controller.signal, expectedScope: captureUserScope() }, async () => { controller.abort(); })).rejects.toMatchObject({ name: "AbortError" });
    await expect(persistCanvasGenerationTarget({ ...input, expectedScope: captureUserScope() }, async () => { throw new UserScopeAbandonedError(); })).rejects.toBeInstanceOf(UserScopeAbandonedError);
});

test("account abandonment or cancellation during result consumption cannot report success", async () => {
    for (const error of [new UserScopeAbandonedError(), new DOMException("Aborted", "AbortError")]) {
        let binds = 0;
        await expect(runCanvasGenerationTaskToConsumer(input, {
            prepareTarget: async () => undefined,
            bindTask: () => { binds++; },
            runTask: async (options) => { options.onTaskCreated?.(task); return { images: [] }; },
            consumeTask: async () => { throw error; },
        })).rejects.toBe(error);
        expect(binds).toBe(1);
    }
});

test("main generation and batch generation stop before changing nodes when a paid result awaits recovery", async () => {
    for (const batch of [false, true]) {
        const target = { ...project.nodes[0], metadata: { taskId: task.id, taskStatus: "succeeded" as const, status: "error" as const, resourceReloadAvailable: true, generationErrorCode: "canvas_conflict" as const } };
        const root = batch ? { ...target, id: "batch-root", metadata: { batchChildIds: [target.id], status: "success" as const } } : target;
        let mutations = 0;
        const notices: string[] = [];
        const unexpected = () => { mutations++; };
        await executeImageGeneration({
            sourceNode: root, nodeId: root.id, canvasNodes: batch ? [root, target] : [target], canvasConnections: [],
            prompt: "修改后再点生成", effectivePrompt: "修改后再点生成", projectId: project.id,
            generationConfig: { count: batch ? "2" : "1" }, generationContext: { referenceImages: [] }, controller: new AbortController(),
            setNodes: unexpected, setConnections: unexpected, registerPendingNodeIds: unexpected,
            showError: (value: string) => notices.push(value),
        } as unknown as CanvasGenerationExecution);
        expect(mutations).toBe(0);
        expect(notices).toEqual(["生成结果已保留，请重新加载资源"]);
    }
});

test("a succeeded image with a bind failure keeps its original task and HTTP evidence and blocks another paid generation", async () => {
    let submissions = 0;
    const updates: GenerationTask[] = [];
    let caught: unknown;
    try {
        await runCanvasGenerationTaskToConsumer(input, {
            prepareTarget: async () => undefined,
            bindTask: (value) => updates.push(value),
            runTask: async (options) => { submissions++; options.onTaskCreated?.(task); return { images: [] }; },
            consumeTask: async () => { throw new ApiError("原任务节点已删除，未重新创建节点", { status: 404, reason: "node_deleted" }); },
        });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CanvasGenerationDurableAckError);
    const terminal = updates.at(-1)!;
    expect(terminal.id).toBe(task.id);
    expect(terminal.status).toBe("succeeded");
    expect(terminal.failureDiagnostics?.source).toBe("client_result");
    expect(terminal.failureDiagnostics?.requests?.[0]?.httpStatus).toBe(200);
    expect(terminal.failureDiagnostics?.summary).toContain("原任务节点已删除");
    const recovered = canvasTaskFailureMetadata(terminal, undefined, caught);
    expect(recovered.taskFailureDiagnostics?.summary).toContain("原任务节点已删除");
    expect(recovered.taskFailureDiagnostics?.executionResult).toBe("completed");
    expect(recovered.taskFailureDiagnostics?.requests?.[0]?.httpStatus).toBe(200);
    const metadata = canvasGenerationFailureMetadata(caught, { prompt: input.prompt, mode: "image" });
    expect(metadata.resourceReloadAvailable).toBe(true);
    expect(canvasGenerationRetryBlocked(metadata, { prompt: "已修改提示词", mode: "image" })).toBe(true);
    expect(submissions).toBe(1);
});
