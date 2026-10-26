import { ApiError } from "@/services/api/request";
import { queryGenerationTask, retryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";

export type RecoverCanvasTaskResultDependencies = {
    queryGenerationTask: typeof queryGenerationTask;
    retryGenerationTask: typeof retryGenerationTask;
};

/**
 * 请后端按已保存的上游回执重建「提交结论未确认」任务的结果。
 *
 * POST /tasks/:id/retry 对这类任务只会先走回执恢复，取不到回执就拒绝（4xx），不会重新提交上游。
 * 只发一次，不重试也不等待：成功后由调用方照常取回写回；返回 undefined 表示后端确认结果取不回；
 * 网络或服务端错误原样抛出，调用方不得据此新建任务。
 */
export async function recoverCanvasTaskResult(taskId: string, signal: AbortSignal, dependencies: RecoverCanvasTaskResultDependencies = { queryGenerationTask, retryGenerationTask }): Promise<GenerationTask | undefined> {
    const expectedScope = captureUserScope();
    signal.throwIfAborted();
    try {
        const task = await dependencies.retryGenerationTask(taskId, { signal, expectedScope });
        signal.throwIfAborted();
        assertUserScope(expectedScope);
        return task;
    } catch (error) {
        const status = error instanceof ApiError ? error.status : undefined;
        if (status === undefined || status < 400 || status >= 500) throw error;
        // 拒绝不等于取不回：上一次恢复可能已在后端成功、只是响应丢了。重读任务，按真实状态判定；读不到就把错误交回调用方。
        const latest = await dependencies.queryGenerationTask(taskId, { signal, expectedScope });
        signal.throwIfAborted();
        assertUserScope(expectedScope);
        return latest.status === "failed" || latest.status === "cancelled" ? undefined : latest;
    }
}
