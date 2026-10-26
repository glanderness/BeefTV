import { ApiError } from "@/services/api/request";
import { queryGenerationTask, retryGenerationTask, waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";

export type RecoverCanvasTaskResultDependencies = {
    queryGenerationTask: typeof queryGenerationTask;
    retryGenerationTask: typeof retryGenerationTask;
    waitForGenerationTask: typeof waitForGenerationTask;
};

/**
 * 取回原任务已经生成、但没有写进画布的结果。
 *
 * 先读任务；任务还在跑就等它；任务已终态就请后端按已保存的上游回执重建结果
 * （POST /tasks/:id/retry 内部先走图片回执恢复，不会重新提交付费生成）。
 * 只有后端明确拒绝（4xx）时才返回 undefined，表示这次结果确实取不回来，
 * 由调用方决定是否重新生成；网络或服务端错误向上抛出，调用方不得据此重复提交。
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
        try {
            task = await dependencies.retryGenerationTask(taskId, { signal, expectedScope });
        } catch (error) {
            const status = error instanceof ApiError ? error.status : undefined;
            if (status !== undefined && status >= 400 && status < 500) return undefined;
            throw error;
        }
        check();
    }
    onTaskUpdate(task);
    if (task.status === "succeeded") return task;
    return dependencies.waitForGenerationTask(task.id, { signal, expectedScope, initialTask: task, onTaskUpdate });
}
