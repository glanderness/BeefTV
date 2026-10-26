import { ApiError } from "@/services/api/request";
import { queryGenerationTask, retryGenerationTask, waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";

export type RecoverCanvasTaskResultDependencies = {
    queryGenerationTask: typeof queryGenerationTask;
    retryGenerationTask: typeof retryGenerationTask;
    waitForGenerationTask: typeof waitForGenerationTask;
    /** 瞬时错误的重试预算，默认与任务轮询的容忍度一致（约 5 次、每次 2 秒）。 */
    transientRetry?: { retries: number; delayMs: number };
};

// 瞬时错误（网络、服务端）按任务轮询既有的容忍度重试：约 5 次、每次 2 秒，之后交给调用方。
// 不在这里无限重试，也不把瞬时错误当成「结果取不回」。
const transientRetryCount = 5;
const transientRetryDelayMs = 2000;

function isBackendRefusal(error: unknown) {
    const status = error instanceof ApiError ? error.status : undefined;
    return status !== undefined && status >= 400 && status < 500;
}

/** 取回流程里的等待：画布切换、节点换任务或卸载时立刻结束。 */
export function waitForRecoveryRetry(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal.addEventListener("abort", abort, { once: true });
    });
}

/**
 * 取回原任务已经生成、但没有写进画布的结果。
 *
 * 先读任务；任务还在跑就等它；任务已终态就请后端按已保存的上游回执重建结果
 * （POST /tasks/:id/retry 内部先走图片回执恢复，不会重新提交付费生成）。
 * 只有后端明确拒绝（4xx）时才返回 undefined，表示这次结果确实取不回来，
 * 由调用方决定是否重新生成；网络或服务端错误按既有节奏重试后向上抛出，
 * 调用方不得据此重复提交。
 */
export async function recoverCanvasTaskResult(
    taskId: string,
    signal: AbortSignal,
    onTaskUpdate: (task: GenerationTask) => void,
    dependencies: RecoverCanvasTaskResultDependencies = { queryGenerationTask, retryGenerationTask, waitForGenerationTask },
): Promise<GenerationTask | undefined> {
    const expectedScope = captureUserScope();
    const check = () => {
        signal.throwIfAborted();
        assertUserScope(expectedScope);
    };
    check();
    let task = await dependencies.queryGenerationTask(taskId, { signal, expectedScope });
    check();
    if (task.status === "failed" || task.status === "cancelled") {
        const retry = dependencies.transientRetry ?? { retries: transientRetryCount, delayMs: transientRetryDelayMs };
        for (let attempts = 0; ; attempts += 1) {
            try {
                task = await dependencies.retryGenerationTask(taskId, { signal, expectedScope });
                break;
            } catch (error) {
                if (isBackendRefusal(error)) return undefined;
                if (attempts >= retry.retries) throw error;
                await waitForRecoveryRetry(retry.delayMs, signal);
                check();
            }
        }
        check();
    }
    onTaskUpdate(task);
    if (task.status === "succeeded") return task;
    // 任务还在取回：等它结束。等待期间再次失败或取消，说明结果确实取不回来。
    let latest = task;
    try {
        latest = await dependencies.waitForGenerationTask(task.id, {
            signal,
            expectedScope,
            initialTask: task,
            onTaskUpdate: (update) => {
                latest = update;
                onTaskUpdate(update);
            },
        });
    } catch (error) {
        if (latest.status !== "failed" && latest.status !== "cancelled") throw error;
    }
    return latest.status === "failed" || latest.status === "cancelled" ? undefined : latest;
}
