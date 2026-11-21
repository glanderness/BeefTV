import { describe, expect, test } from "bun:test";
import type { AxiosRequestConfig, AxiosResponse } from "axios";

import { apiClient, type BackendEnvelope } from "@/services/api/request";
import { recoverTask, TASK_RECOVER_TIMEOUT_MS, type GenerationTask } from "@/services/api/task-center";

describe("recoverTask request configuration", () => {
    test("uses a long finite recovery timeout instead of the 4s default while forwarding AbortSignal", async () => {
        const originalRequest = apiClient.request.bind(apiClient);
        const captured: AxiosRequestConfig[] = [];
        const controller = new AbortController();

        apiClient.request = (async <T, R = AxiosResponse<T>>(config: AxiosRequestConfig) => {
            captured.push(config);
            const task: GenerationTask = {
                id: "task-video-1",
                type: "canvas_video",
                status: "succeeded",
                stage: "生成完成",
                progress: 100,
                prompt: "测试恢复",
                outcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
                attempts: 1,
                createdAt: "2026-11-21T12:00:00Z",
                updatedAt: "2026-11-21T12:05:00Z",
            };
            const envelope: BackendEnvelope<GenerationTask> = { code: 0, data: task, msg: "ok" };
            return { data: envelope, status: 200, statusText: "OK", headers: {}, config } as unknown as R;
        }) as typeof apiClient.request;

        try {
            expect(apiClient.defaults.timeout).toBe(4_000);
            const result = await recoverTask("task-video-1", { signal: controller.signal });
            expect(result.id).toBe("task-video-1");
            expect(captured).toHaveLength(1);
            expect(captured[0].method).toBe("post");
            expect(captured[0].url).toBe("/tasks/task-video-1/recover");
            expect(captured[0].timeout).toBe(TASK_RECOVER_TIMEOUT_MS);
            expect(TASK_RECOVER_TIMEOUT_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
            expect(captured[0].signal).toBe(controller.signal);
        } finally {
            apiClient.request = originalRequest;
        }
    });
});
