import { expect, test } from "bun:test";
import { upscaleInput, upscaleModel, runUpscaleTask, type UpscaleParams } from "@/services/api/media-upscale";
import { canRetrieveVideoResult, type CreateTaskInput, type GenerationTask } from "@/services/api/task-center";
import { ApiError } from "@/services/api/request";
import { GenerationSubmissionUnknownError } from "@/services/api/generation-submission";
import { createUpscaleResultNodes } from "@/lib/canvas/canvas-upscale";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const params: UpscaleParams = { variant: "precision", factor: 2, outputFormat: "png" };
const source = { storageKey: "resource:owned-source", name: "素材" };
const queued: GenerationTask = { id: "original-local-task", projectId: "canvas", type: "canvas_image", status: "queued", prompt: "AI 超分", attempts: 0, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z" };
const completed: GenerationTask = { ...queued, status: "succeeded", resultJson: JSON.stringify({ mode: "image", images: [{ dataUrl: "data:image/png;base64,cG5n", storageKey: "resource:result" }] }) };

test("batch upscale reserves separate results around existing nodes and keeps sources unchanged", () => {
    const source = (id: string, x: number, type = CanvasNodeType.Image): CanvasNodeData => ({ id, type, title: id, position: { x, y: 0 }, width: 420, height: 315, metadata: { content: "owned source", storageKey: `resource:${id}` } });
    const origins = [source("image", 0), source("video", 0, CanvasNodeType.Video), source("existing-result", 516)];
    const before = JSON.stringify(origins);
    const targets = createUpscaleResultNodes(origins, origins, 2);
    expect(targets).toHaveLength(3);
    expect(new Set(targets.map((node) => node.id)).size).toBe(3);
    expect(JSON.stringify(origins)).toBe(before);
    targets.forEach((target, index) => {
        expect(target.metadata?.generatedFromNodeId).toBe(origins[index].id);
        expect(target.metadata?.content).toBeUndefined();
        for (const other of [...origins, ...targets.filter((node) => node !== target)]) {
            const overlap = target.position.x < other.position.x + other.width && target.position.x + target.width > other.position.x && target.position.y < other.position.y + other.height && target.position.y + target.height > other.position.y;
            expect(overlap).toBe(false);
        }
    });
});

test("four media models use official managed credentials and exactly one owned source", () => {
    for (const mode of ["image", "video"] as const)
        for (const variant of ["precision", "generative"] as const) {
            const input = upscaleInput(mode, source, { ...params, variant });
            expect(input.config.model).toBe(upscaleModel(mode, variant));
            expect(input.config.credentialRef).toBe("beefapi-enterprise");
            expect(JSON.stringify(input)).not.toContain("apiKey");
            expect(JSON.stringify(input)).not.toContain("baseUrl");
            expect(input.upscale.factor).toBe(2);
            if (mode === "image") expect(input.referenceImages).toEqual([source]);
            else {
                expect(input.referenceVideos).toEqual([source]);
                expect(input.upscale).not.toHaveProperty("outputFormat");
            }
        }
    expect(() => upscaleInput("image", { storageKey: "blob:local" }, params)).toThrow();
    expect(() => upscaleInput("image", source, { ...params, factor: 1.5 })).toThrow();
});

test("lost local admission response finds original task and waits without a second create", async () => {
    const sent: CreateTaskInput[] = [];
    const observed: string[] = [];
    const result = await runUpscaleTask(
        { projectId: "canvas", nodeId: "target", mode: "image", source, params, clientOperationId: "upscale-stable-op", onTaskCreated: (task) => observed.push(task.id) },
        {
            createGenerationTask: async (input) => {
                sent.push(structuredClone(input));
                throw new ApiError("response lost");
            },
            findGenerationTaskByOperation: async (operationId, projectId) => {
                expect(operationId).toBe("upscale-stable-op");
                expect(projectId).toBe("canvas");
                return queued;
            },
            waitForGenerationTask: async (id, options) => {
                expect(id).toBe(queued.id);
                options?.onTaskUpdate?.(completed);
                return completed;
            },
        },
    );
    expect(sent.length).toBe(1);
    expect(sent[0].input?.metadata).toEqual({ source: "canvas", nodeId: "target", edit: "upscale", clientOperationId: "upscale-stable-op" });
    expect(sent[0].input?.referenceImages).toEqual([source]);
    expect(observed).toEqual([queued.id, queued.id]);
    expect(result.images?.[0]?.storageKey).toBe("resource:result");
});

test("unreadable admission receipt retains operation id and never starts polling a new task", async () => {
    let posts = 0,
        waits = 0;
    try {
        await runUpscaleTask(
            { projectId: "canvas", nodeId: "target", mode: "video", source, params, clientOperationId: "unknown-operation" },
            {
                createGenerationTask: async () => {
                    posts++;
                    throw new ApiError("response lost");
                },
                findGenerationTaskByOperation: async () => {
                    throw new ApiError("offline");
                },
                waitForGenerationTask: async () => {
                    waits++;
                    return completed;
                },
            },
        );
        throw new Error("expected unknown submission");
    } catch (error) {
        expect(error).toBeInstanceOf(GenerationSubmissionUnknownError);
        expect((error as GenerationSubmissionUnknownError).operationId).toBe("unknown-operation");
    }
    expect(posts).toBe(1);
    expect(waits).toBe(0);
});

test("image upscale delivery failures offer original-task retrieval", () => {
    expect(canRetrieveVideoResult({ ...queued, status: "failed", model: "topaz-standard-v2", providerRequestId: "paid-original" })).toBe(true);
    expect(canRetrieveVideoResult({ ...queued, status: "failed", model: "topaz-wonder-3.5" })).toBe(false);
    expect(canRetrieveVideoResult({ ...queued, status: "failed", model: "other-image", providerRequestId: "other" })).toBe(false);
});
