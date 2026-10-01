import { describe, expect, test } from "bun:test";

import {
    attachLocalExecutorResult,
    beginLocalExecutorSession,
    isLocalExecutorSessionStop,
    isUncertainLocalExecutorSubmit,
    localExecutorIntentAfterError,
    localExecutorIntentAfterSubmit,
    nextLocalExecutorClientOperationId,
    runOwnedDepthCapture,
    runOwnedTimelineRender,
    runOwnedTimelineTranscription,
    type LocalExecutorIntentState,
} from "@/lib/plugins/builtin/editor/local-executor-session";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
import { apiClient, ApiError } from "@/services/api/request";
import { createDepthCaptureTask } from "@/services/api/depth-capture";
import { createTimelineRenderTask, createTimelineTranscriptionTask } from "@/services/api/timeline-tasks";
import type { GenerationTask } from "@/services/api/task-center";
import type { TimelineProject } from "@/types/timeline";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

const timeline: TimelineProject = { version: 2, tracks: [], clips: [], durationMs: 0 };

function generationTask(partial: Partial<GenerationTask> & Pick<GenerationTask, "id">): GenerationTask {
    return {
        type: "timeline_render",
        status: "queued",
        prompt: "",
        attempts: 0,
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        ...partial,
    };
}

function envelope(data: unknown) {
    return { data: { code: 0, data, msg: "" }, status: 200, statusText: "OK", headers: {}, config: {} as never };
}

async function withAdapter<T>(adapter: NonNullable<typeof apiClient.defaults.adapter>, run: () => Promise<T>) {
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
        return await run();
    } finally {
        apiClient.defaults.adapter = previous;
    }
}

function requestPath(config: { url?: string }) {
    return String(config.url || "");
}

function requestBody(config: { data?: unknown }) {
    if (typeof config.data === "string") {
        try {
            return JSON.parse(config.data) as Record<string, unknown>;
        } catch {
            return undefined;
        }
    }
    return config.data && typeof config.data === "object" ? config.data as Record<string, unknown> : undefined;
}

async function expectSessionStop(pending: Promise<unknown>) {
    const result = await pending.then(() => "fulfilled" as const, (error) => error);
    expect(result).not.toBe("fulfilled");
    expect(isLocalExecutorSessionStop(result)).toBe(true);
}

describe("local-executor clientOperationId intent", () => {
    test("same intent explicit unknown-submit retry maps the same clientOperationId", () => {
        const first = nextLocalExecutorClientOperationId(null);
        const afterUnknown = localExecutorIntentAfterError({ clientOperationId: first }, new Error("Failed to fetch"));
        expect(afterUnknown.submittedTaskId).toBeUndefined();
        expect(nextLocalExecutorClientOperationId(afterUnknown)).toBe(first);
        expect(isUncertainLocalExecutorSubmit(new Error("Failed to fetch"))).toBe(true);
        expect(isUncertainLocalExecutorSubmit(new ApiError("冲突", { status: 409 }))).toBe(true);
    });

    test("explicit new terminal retry differs from the original submit identity", () => {
        const first = nextLocalExecutorClientOperationId(null);
        const submitted = localExecutorIntentAfterSubmit(first, generationTask({ id: "task-terminal", clientOperationId: first }));
        const afterTerminal = localExecutorIntentAfterError(submitted, new Error("任务失败"));
        const next = nextLocalExecutorClientOperationId(afterTerminal);
        expect(afterTerminal.submittedTaskId).toBe("task-terminal");
        expect(next).not.toBe(first);
        expect(isUncertainLocalExecutorSubmit(new Error("任务失败"), "task-terminal")).toBe(false);
        expect(isUncertainLocalExecutorSubmit(new ApiError("缺少媒体", { status: 400 }))).toBe(false);
        expect(isUncertainLocalExecutorSubmit(new DOMException("Aborted", "AbortError"))).toBe(false);
    });
});

describe("local-executor typed HTTP contract", () => {
    test("forwards clientOperationId and expectedScope on all three creates", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const posts: Array<{ path: string; body: unknown }> = [];
        try {
            await withAdapter(async (config) => {
                posts.push({ path: requestPath(config), body: config.data });
                return envelope(generationTask({ id: "created", clientOperationId: (config.data as { clientOperationId?: string }).clientOperationId, status: "queued" }));
            }, async () => {
                await createTimelineRenderTask({ projectId: "proj-a", timeline, clientOperationId: "op-render" }, { expectedScope });
                await createTimelineTranscriptionTask({ resourceId: "res-1", projectId: "proj-a", clientOperationId: "op-transcribe" }, { expectedScope });
                await createDepthCaptureTask({ projectId: "proj-a", resourceId: "res-2", clientOperationId: "op-depth" }, { expectedScope });
            });
            expect(posts.map((item) => item.path)).toEqual(["/timeline/renders", "/timeline/transcriptions", "/depth-captures"]);
            expect(posts.map((item) => requestBody({ data: item.body })?.clientOperationId)).toEqual(["op-render", "op-transcribe", "op-depth"]);
        } finally {
            restore();
        }
    });

    test("handles a durable replay response by observing the returned task id", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const seen: string[] = [];
        try {
            await withAdapter(async (config) => {
                const path = requestPath(config);
                seen.push(`${config.method}:${path}`);
                if (path === "/timeline/renders") {
                    return envelope(generationTask({
                        id: "original-task",
                        clientOperationId: "op-replay",
                        status: "succeeded",
                        resultJson: JSON.stringify({ resourceId: "out-1", fileName: "timeline.mp4" }),
                    }));
                }
                if (path === "/tasks/original-task") {
                    return envelope(generationTask({
                        id: "original-task",
                        clientOperationId: "op-replay",
                        status: "succeeded",
                        resultJson: JSON.stringify({ resourceId: "out-1", fileName: "timeline.mp4" }),
                    }));
                }
                throw new Error(`unexpected ${path}`);
            }, async () => {
                const session = beginLocalExecutorSession("proj-a", {
                    controller: new AbortController(),
                    getLiveProjectId: () => "proj-a",
                    expectedScope,
                });
                const owned = await runOwnedTimelineRender({
                    session,
                    projectId: "proj-a",
                    timeline,
                    clientOperationId: "op-replay",
                    intervalMs: 1,
                    timeoutMs: 1000,
                });
                expect(owned.task.id).toBe("original-task");
                expect(owned.task.clientOperationId).toBe("op-replay");
                expect(owned.result.resourceId).toBe("out-1");
            });
            expect(seen.some((item) => item.includes("DELETE"))).toBe(false);
        } finally {
            restore();
        }
    });
});

describe("local-executor submit and attach ownership", () => {
    test("deferred submit plus A to B to A does not attach a result", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const entered = deferred();
        const gate = deferred();
        let attached = 0;
        let created = 0;
        try {
            await withAdapter(async (config) => {
                entered.resolve();
                await gate.promise;
                created += 1;
                return envelope(generationTask({ id: "late-create", status: "succeeded", resultJson: JSON.stringify({ resourceId: "out" }) }));
            }, async () => {
                const session = beginLocalExecutorSession("proj-a", {
                    controller: new AbortController(),
                    getLiveProjectId: () => "proj-a",
                    expectedScope,
                });
                const pending = runOwnedTimelineRender({
                    session,
                    projectId: "proj-a",
                    timeline,
                    clientOperationId: "op-aba",
                    intervalMs: 1,
                    timeoutMs: 1000,
                }).then(async (owned) => {
                    await attachLocalExecutorResult(session, () => {
                        attached += 1;
                        return owned.result;
                    });
                });
                await entered.promise;
                setActiveUserScope("owner-b");
                setActiveUserScope("owner-a");
                gate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(attached).toBe(0);
                expect(created).toBe(1);
            });
        } finally {
            restore();
        }
    });

    test("late task completion after project switch does not write the replacement canvas", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const pollEntered = deferred();
        const pollGate = deferred();
        let liveProject = "proj-a";
        const controller = new AbortController();
        let updates = 0;
        let attached = 0;
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                const path = requestPath(config);
                urls.push(path);
                if (path === "/depth-captures") {
                    return envelope(generationTask({ id: "depth-1", type: "depth_capture", clientOperationId: "op-depth", status: "running" }));
                }
                if (path === "/tasks/depth-1") {
                    pollEntered.resolve();
                    await pollGate.promise;
                    return envelope(generationTask({
                        id: "depth-1",
                        type: "depth_capture",
                        status: "succeeded",
                        resultJson: JSON.stringify({ resourceId: "depth-out", fileName: "depth.mp4", size: 1, durationMs: 1000, width: 16, height: 9 }),
                    }));
                }
                if (path === "/resources/depth-out") {
                    attached += 100;
                    return envelope({ resource: { id: "depth-out", mimeType: "video/mp4", size: 1, width: 16, height: 9, durationMs: 1000 } });
                }
                throw new Error(`unexpected ${path}`);
            }, async () => {
                const session = beginLocalExecutorSession("proj-a", {
                    controller,
                    getLiveProjectId: () => liveProject,
                    expectedScope,
                });
                const pending = runOwnedDepthCapture({
                    session,
                    projectId: "proj-a",
                    resourceId: "src-1",
                    clientOperationId: "op-depth",
                    intervalMs: 1,
                    timeoutMs: 1000,
                    onTaskUpdate: () => {
                        updates += 1;
                    },
                }).then(async (owned) => {
                    await attachLocalExecutorResult(session, () => {
                        attached += 1;
                        return owned.capture;
                    });
                });
                await pollEntered.promise;
                liveProject = "proj-b";
                controller.abort();
                pollGate.resolve();
                await expectSessionStop(pending);
                expect(updates).toBe(0);
                expect(attached).toBe(0);
                expect(urls.some((url) => url.includes("/resources/"))).toBe(false);
                expect(urls.some((url) => String(url).includes("cancel") || url.startsWith("DELETE"))).toBe(false);
            });
        } finally {
            pollGate.resolve();
            restore();
        }
    });

    test("late transcription completion after unmount does not dispatch subtitles", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const pollEntered = deferred();
        const pollGate = deferred();
        const controller = new AbortController();
        let dispatched = 0;
        try {
            await withAdapter(async (config) => {
                const path = requestPath(config);
                if (path === "/timeline/transcriptions") {
                    return envelope(generationTask({ id: "tr-1", type: "timeline_transcription", status: "running", clientOperationId: "op-tr" }));
                }
                if (path === "/tasks/tr-1") {
                    pollEntered.resolve();
                    await pollGate.promise;
                    return envelope(generationTask({
                        id: "tr-1",
                        type: "timeline_transcription",
                        status: "succeeded",
                        resultJson: JSON.stringify({ segments: [{ startMs: 0, endMs: 1000, text: "hello" }], language: "zh" }),
                    }));
                }
                throw new Error(`unexpected ${path}`);
            }, async () => {
                const session = beginLocalExecutorSession("proj-a", {
                    controller,
                    getLiveProjectId: () => "proj-a",
                    expectedScope,
                });
                const pending = runOwnedTimelineTranscription({
                    session,
                    projectId: "proj-a",
                    resourceId: "audio-1",
                    clientOperationId: "op-tr",
                    intervalMs: 1,
                    timeoutMs: 1000,
                }).then(async (owned) => {
                    await attachLocalExecutorResult(session, () => {
                        dispatched += 1;
                        return owned.result;
                    });
                });
                await pollEntered.promise;
                controller.abort();
                pollGate.resolve();
                await expectSessionStop(pending);
                expect(dispatched).toBe(0);
            });
        } finally {
            pollGate.resolve();
            restore();
        }
    });

    test("same intent unknown-submit retry posts the same clientOperationId; terminal retry posts a new one", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const posts: string[] = [];
        let renderPosts = 0;
        try {
            await withAdapter(async (config) => {
                const path = requestPath(config);
                if (path === "/timeline/renders") {
                    const operationId = String(requestBody(config)?.clientOperationId || "");
                    posts.push(operationId);
                    renderPosts += 1;
                    if (renderPosts === 1) {
                        throw new ApiError("network down");
                    }
                    if (renderPosts === 2) {
                        return envelope(generationTask({
                            id: "render-ok",
                            clientOperationId: operationId,
                            status: "failed",
                            error: "编码器失败",
                        }));
                    }
                    return envelope(generationTask({
                        id: "render-retry",
                        clientOperationId: operationId,
                        status: "succeeded",
                        resultJson: JSON.stringify({ resourceId: "out-2" }),
                    }));
                }
                if (path === "/tasks/render-ok") {
                    return envelope(generationTask({ id: "render-ok", status: "failed", error: "编码器失败" }));
                }
                if (path === "/tasks/render-retry") {
                    return envelope(generationTask({
                        id: "render-retry",
                        status: "succeeded",
                        resultJson: JSON.stringify({ resourceId: "out-2" }),
                    }));
                }
                throw new Error(`unexpected ${path}`);
            }, async () => {
                let intent: LocalExecutorIntentState | null = null;
                const firstId = nextLocalExecutorClientOperationId(intent);
                const sessionOf = () => beginLocalExecutorSession("proj-a", {
                    controller: new AbortController(),
                    getLiveProjectId: () => "proj-a",
                    expectedScope,
                });
                await expect(runOwnedTimelineRender({
                    session: sessionOf(),
                    projectId: "proj-a",
                    timeline,
                    clientOperationId: firstId,
                    intervalMs: 1,
                    timeoutMs: 1000,
                })).rejects.toBeTruthy();
                intent = localExecutorIntentAfterError({ clientOperationId: firstId }, new ApiError("network down"));
                const reused = nextLocalExecutorClientOperationId(intent);
                expect(reused).toBe(firstId);
                await expect(runOwnedTimelineRender({
                    session: sessionOf(),
                    projectId: "proj-a",
                    timeline,
                    clientOperationId: reused,
                    intervalMs: 1,
                    timeoutMs: 1000,
                    onCreated: (created) => {
                        intent = localExecutorIntentAfterSubmit(reused, created);
                    },
                })).rejects.toBeTruthy();
                intent = localExecutorIntentAfterError(intent!, new Error("任务失败"));
                const regenerated = nextLocalExecutorClientOperationId(intent);
                expect(regenerated).not.toBe(firstId);
                const owned = await runOwnedTimelineRender({
                    session: sessionOf(),
                    projectId: "proj-a",
                    timeline,
                    clientOperationId: regenerated,
                    intervalMs: 1,
                    timeoutMs: 1000,
                });
                expect(owned.task.id).toBe("render-retry");
                expect(posts).toEqual([firstId, firstId, regenerated]);
            });
        } finally {
            restore();
        }
    });
});
