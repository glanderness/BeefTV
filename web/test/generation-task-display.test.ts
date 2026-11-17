import { expect, test } from "bun:test";
import { generationTaskShowsProgress, generationTaskStageLabel, generationTaskStatusLabel } from "@/lib/generation-task-display";

test("cancelled image with unconfirmed result does not claim recovery is running", () => {
    const task = {
        status: "cancelled" as const,
        stage: "任务已取消",
        outcome: { phase: "failed" as const, regenerate: "blocked" as const, reason: "cancelled_result_unconfirmed" },
    };
    expect(generationTaskStatusLabel(task)).toBe("结果待确认");
    expect(generationTaskStageLabel(task)).toBe("任务已取消，上游结果尚未确认");
    expect(generationTaskShowsProgress(task)).toBe(false);
});

for (const [stage, label] of [["delivery_paused", "已暂停取回结果"], ["delivery_timed_out", "下载超时，可继续取回原结果"]]) {
    test(`${stage} keeps generation success separate from result delivery`, () => {
        const task = { status: "succeeded" as const, stage };
        expect(generationTaskStatusLabel(task)).toBe("待取回结果");
        expect(generationTaskStageLabel(task)).toBe(label);
        expect(generationTaskShowsProgress(task)).toBe(false);
    });
}
