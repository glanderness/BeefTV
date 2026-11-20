import { expect, test } from "bun:test";
import { generationTaskShowsProgress, generationTaskStageLabel, generationTaskStatusLabel } from "@/lib/generation-task-display";
import { providerCancelStatusLabel, taskAttentionReason } from "@/pages/tasks/task-shared";
import type { GenerationTask } from "@/services/api/task-center";

test("cancelled image with unconfirmed result does not claim recovery is running", () => {
    const task = {
        id: "cancelled-1",
        type: "canvas_image",
        status: "cancelled" as const,
        stage: "任务已取消",
        createdAt: "2026-11-20T00:00:00Z",
        updatedAt: "2026-11-20T00:00:00Z",
        attempts: 1,
        outcome: { phase: "failed" as const, regenerate: "confirm" as const, reason: "cancelled_result_unconfirmed" },
    } as GenerationTask;
    expect(generationTaskStatusLabel(task)).toBe("结果待确认");
    expect(generationTaskStageLabel(task)).toBe("任务已取消，无法确认上游是否已生成或扣费");
    expect(generationTaskShowsProgress(task)).toBe(false);
    expect(taskAttentionReason(task)).toContain("核对原请求状态");
    expect(providerCancelStatusLabel(task)).toContain("核对原请求状态");
    expect(providerCancelStatusLabel({ ...task, providerCancelStatus: "confirmed" })).toBe("上游已确认取消，请核对渠道后台确认是否已扣费");
    expect(providerCancelStatusLabel({ ...task, outcome: undefined, providerCancelStatus: "confirmed" })).toBe("上游已确认取消");
    expect(providerCancelStatusLabel({ ...task, outcome: undefined })).toBe("任务已取消，请核对原任务的结果与扣费状态");
});

for (const [stage, label] of [["delivery_paused", "已暂停取回结果"], ["delivery_timed_out", "下载超时，可继续取回原结果"]]) {
    test(`${stage} keeps generation success separate from result delivery`, () => {
        const task = { status: "succeeded" as const, stage };
        expect(generationTaskStatusLabel(task)).toBe("待取回结果");
        expect(generationTaskStageLabel(task)).toBe(label);
        expect(generationTaskShowsProgress(task)).toBe(false);
    });
}
