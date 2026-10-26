import { expect, test } from "bun:test";
import { ApiError } from "@/services/api/request";
import { recoverCanvasTaskResult } from "@/services/canvas-task-result-recovery";
import type { GenerationTask } from "@/services/api/task-center";

function task(status: GenerationTask["status"], stage = "任务失败"): GenerationTask {
    return { id: "task-1", type: "canvas_image", status, stage, prompt: "draw", attempts: 1, createdAt: "2026-10-26", updatedAt: "2026-10-26" };
}

const signal = () => new AbortController().signal;

test("a failed image task takes back its original receipt result instead of submitting again", async () => {
    const calls: string[] = [];
    const restored = task("succeeded", "等待取回结果");
    const result = await recoverCanvasTaskResult("task-1", signal(), () => calls.push("update"), {
        queryGenerationTask: async () => { calls.push("query"); return task("failed"); },
        retryGenerationTask: async () => { calls.push("retry"); return restored; },
        waitForGenerationTask: async () => { calls.push("wait"); return restored; },
    });
    expect(result?.status).toBe("succeeded");
    expect(calls).toEqual(["query", "retry", "update"]);
});

test("a running task is waited for rather than resubmitted", async () => {
    const calls: string[] = [];
    const result = await recoverCanvasTaskResult("task-1", signal(), () => calls.push("update"), {
        queryGenerationTask: async () => { calls.push("query"); return task("running", "生成中"); },
        retryGenerationTask: async () => { calls.push("retry"); return task("running", "生成中"); },
        waitForGenerationTask: async (_id, options) => { calls.push(`wait:${options?.initialTask?.status}`); return task("succeeded"); },
    });
    expect(result?.status).toBe("succeeded");
    expect(calls).toEqual(["query", "update", "wait:running"]);
});

test("a backend refusal means the result is gone, and no result is reported", async () => {
    const calls: string[] = [];
    const result = await recoverCanvasTaskResult("task-1", signal(), () => calls.push("update"), {
        queryGenerationTask: async () => { calls.push("query"); return task("failed"); },
        retryGenerationTask: async () => {
            calls.push("retry");
            throw new ApiError("图片请求可能已经生成，请保留任务记录并联系支持查询结果，不要重复提交", { status: 400, reason: "bad_request" });
        },
        waitForGenerationTask: async () => { calls.push("wait"); return task("succeeded"); },
    });
    expect(result).toBeUndefined();
    expect(calls).toEqual(["query", "retry"]);
});

test("infrastructure failures propagate so callers never read them as a refusal", async () => {
    await expect(recoverCanvasTaskResult("task-1", signal(), () => {}, {
        queryGenerationTask: async () => task("failed"),
        retryGenerationTask: async () => { throw new Error("网络不可用"); },
        waitForGenerationTask: async () => task("succeeded"),
    })).rejects.toThrow("网络不可用");
    await expect(recoverCanvasTaskResult("task-1", signal(), () => {}, {
        queryGenerationTask: async () => { throw new Error("读取任务失败"); },
        retryGenerationTask: async () => task("succeeded"),
        waitForGenerationTask: async () => task("succeeded"),
    })).rejects.toThrow("读取任务失败");
});

test("an aborted request stops before touching the backend", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    await expect(recoverCanvasTaskResult("task-1", controller.signal, () => calls.push("update"), {
        queryGenerationTask: async () => { calls.push("query"); return task("failed"); },
        retryGenerationTask: async () => { calls.push("retry"); return task("succeeded"); },
        waitForGenerationTask: async () => { calls.push("wait"); return task("succeeded"); },
    })).rejects.toThrow();
    expect(calls).toEqual([]);
});
