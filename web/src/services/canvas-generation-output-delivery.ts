import { assertUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import type { GenerationTask, GenerationTaskDeliveryProgress, GenerationTaskOutput } from "@/services/api/task-center";
import { CanvasGenerationMaterializationError } from "./canvas-generation-errors";

const MATERIALIZATION_BUDGET_MS = 15 * 60 * 1000;
const PERMANENT_ERROR_CODES = new Set(["resource_foreign", "asset_foreign", "unsupported_result_shape"]);

export type SleepWithSignal = (ms: number, signal?: AbortSignal) => Promise<void>;
export type RefreshGenerationTask = (taskId: string, options: { signal?: AbortSignal; expectedScope: CapturedUserScope }) => Promise<GenerationTask>;

export type CanvasGenerationOutputDeliveryState = {
    task: GenerationTask;
    outputIndices: number[];
    signal?: AbortSignal;
    expectedScope: CapturedUserScope;
    isCurrent: () => boolean;
    liveScope: () => CapturedUserScope;
    refreshTask: RefreshGenerationTask;
    sleep: SleepWithSignal;
    now: () => number;
    startedAt: number;
    publishDeliveryProgress: (taskId: string, progress: GenerationTaskDeliveryProgress | undefined) => void;
};

export function sleepWithSignal(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function taskOutput(task: GenerationTask, index: number): GenerationTaskOutput | undefined {
    return task.outputs?.find((output) => output.outputIndex === index) ?? task.outputs?.[index];
}

export function generationTaskOutputMaterialized(task: GenerationTask, index: number) {
    return Boolean(taskOutput(task, index)?.materializedAssetId);
}

// Primary binding and expanded results share the same delivery deadline and
// scope checks. Only poll the accepted task; never create or retry generation.
export async function waitForMaterializedGenerationOutputs(state: CanvasGenerationOutputDeliveryState, forceRefresh = false): Promise<GenerationTask> {
    let task = state.task;
    let attempt = 0;
    let skipCheck = forceRefresh;
    const assertActive = () => {
        if (state.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        if (!state.isCurrent()) throw new DOMException("The canvas operation was abandoned", "AbortError");
        assertUserScope(state.expectedScope, state.liveScope());
    };
    try {
        for (;;) {
            assertActive();
            if (task.id !== state.task.id) throw new Error("生成任务不匹配，请刷新结果后重试");
            // A materialized ID can outlive its resource. Forced bind retries
            // still share this deadline, even if the task reports that ID.
            if (state.now() - state.startedAt >= MATERIALIZATION_BUDGET_MS) throw new CanvasGenerationMaterializationError(new Error("生成结果取回或写入画布超时，请继续取回"));
            const pending = state.outputIndices.filter((index) => !generationTaskOutputMaterialized(task, index));
            const index = pending[0] ?? state.outputIndices[0];
            state.publishDeliveryProgress(task.id, task.delivery?.outputs.find((output) => output.outputIndex === index));
            if (!skipCheck) {
                if (!pending.length) return task;
                for (const index of pending) {
                    const code = taskOutput(task, index)?.materializationErrorCode || task.stage;
                    if (code === "delivery_paused" || code === "delivery_timed_out") {
                        throw new CanvasGenerationMaterializationError(new Error(code === "delivery_paused" ? "已停止取回，可继续取回原结果" : "结果取回超时，可继续取回原结果"));
                    }
                    if (task.resultState === "FAILED_PERMANENT" || code && PERMANENT_ERROR_CODES.has(code)) {
                        throw new CanvasGenerationMaterializationError(new Error(task.resultState || task.error || "生成结果下载失败"));
                    }
                }
            }
            await state.sleep([1000, 2000, 3000, 5000][Math.min(attempt, 3)], state.signal);
            assertActive();
            attempt += 1;
            task = await state.refreshTask(task.id, { signal: state.signal, expectedScope: state.expectedScope });
            skipCheck = false;
        }
    } finally {
        state.publishDeliveryProgress(state.task.id, undefined);
    }
}
