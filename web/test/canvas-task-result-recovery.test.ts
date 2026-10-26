import { expect, test } from "bun:test";
import { ApiError } from "@/services/api/request";
import { recoverCanvasTaskResult } from "@/services/canvas-task-result-recovery";
import type { GenerationTask } from "@/services/api/task-center";

function task(status: GenerationTask["status"], stage = "任务失败"): GenerationTask {
    return { id: "task-1", type: "canvas_image", status, stage, prompt: "draw", attempts: 1, createdAt: "2026-10-26", updatedAt: "2026-10-26" };
}

const signal = () => new AbortController().signal;
const refusal = () => new ApiError("提交结果尚未确认，请先查询原任务，不要立即重新提交", { status: 400, reason: "result_unrecoverable" });

test("a failed image task takes back its original receipt result instead of submitting again", async () => {
    const calls: string[] = [];
    const result = await recoverCanvasTaskResult("task-1", signal(), {
        queryGenerationTask: async () => { calls.push("query"); return task("failed"); },
        retryGenerationTask: async () => { calls.push("retry"); return task("succeeded", "等待取回结果"); },
    });
    expect(result?.status).toBe("succeeded");
    expect(calls).toEqual(["retry"]);
});

test("a backend refusal means the result is gone only after the task still reads as failed", async () => {
    const calls: string[] = [];
    const result = await recoverCanvasTaskResult("task-1", signal(), {
        queryGenerationTask: async () => { calls.push("query"); return task("failed"); },
        retryGenerationTask: async () => { calls.push("retry"); throw refusal(); },
    });
    expect(result).toBeUndefined();
    expect(calls).toEqual(["retry", "query"]);
});

test("temporary refusals such as a recovery lock or storage quota are errors, never a lost result", async () => {
    for (const temporary of [
        new ApiError("task provider recovery is already running", { status: 400, reason: "bad_request" }),
        new ApiError("存储空间已用完，请清理后重试", { status: 403, reason: "quota_exceeded" }),
        // 读回执时数据库临时失败：文案和「确认取不回」一样，但不带 result_unrecoverable。
        new ApiError("图片结果尚未确认，已停止自动重发；请保留任务记录并联系支持查询结果", { status: 400, reason: "invalid_argument" }),
    ]) {
        await expect(recoverCanvasTaskResult("task-1", signal(), {
            queryGenerationTask: async () => task("failed"),
            retryGenerationTask: async () => { throw temporary; },
        })).rejects.toBe(temporary);
    }
});

test("a lost recovery response is consumed as the existing result, not read as a lost result", async () => {
    // 第一次恢复已在后端成功、只是响应没回来：再发一次会被拒（任务已成功），重读任务必须拿到成功结果。
    const result = await recoverCanvasTaskResult("task-1", signal(), {
        queryGenerationTask: async () => task("succeeded", "等待取回结果"),
        retryGenerationTask: async () => { throw new ApiError("只有失败的任务可以重试", { status: 400, reason: "bad_request" }); },
    });
    expect(result?.status).toBe("succeeded");
});

test("a refusal with the task already running again hands back the running task to watch", async () => {
    const result = await recoverCanvasTaskResult("task-1", signal(), {
        queryGenerationTask: async () => task("running", "正在取回生成结果"),
        retryGenerationTask: async () => { throw refusal(); },
    });
    expect(result?.status).toBe("running");
});

test("an unreadable task after a refusal is an error, never a lost result", async () => {
    await expect(recoverCanvasTaskResult("task-1", signal(), {
        queryGenerationTask: async () => { throw new Error("读取任务失败"); },
        retryGenerationTask: async () => { throw refusal(); },
    })).rejects.toThrow("读取任务失败");
});

test("network and server failures propagate once, never read as a refusal or retried here", async () => {
    const calls: string[] = [];
    await expect(recoverCanvasTaskResult("task-1", signal(), {
        queryGenerationTask: async () => { calls.push("query"); return task("failed"); },
        retryGenerationTask: async () => { calls.push("retry"); throw new ApiError("上游暂时不可用", { status: 503 }); },
    })).rejects.toThrow("上游暂时不可用");
    expect(calls).toEqual(["retry"]);
});

test("an aborted request stops before touching the backend", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    await expect(recoverCanvasTaskResult("task-1", controller.signal, {
        queryGenerationTask: async () => { calls.push("query"); return task("failed"); },
        retryGenerationTask: async () => { calls.push("retry"); return task("succeeded"); },
    })).rejects.toThrow();
    expect(calls).toEqual([]);
});
