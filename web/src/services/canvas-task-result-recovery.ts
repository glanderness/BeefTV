import { ApiError } from "@/services/api/request";
import { queryGenerationTask, retryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";

export type RecoverCanvasTaskResultDependencies = {
    queryGenerationTask: typeof queryGenerationTask;
    retryGenerationTask: typeof retryGenerationTask;
};

// 后端明确表示「这次结果取不回、也不能按原任务重试」的拒绝文案（backend/internal/task/errors.go、
// app/image_submission.go 的 validateImageTaskRetry 与 imageRecoveryError）。恢复锁冲突、存储配额不足等
// 其他 4xx 只是暂时取不回，结果可能还在，不能据此关掉「继续取回」。
const RESULT_GONE_MESSAGES = ["提交结果尚未确认，请先查询原任务，不要立即重新提交", "图片请求可能已经生成，请保留任务记录并联系支持查询结果，不要重复提交", "图片结果尚未确认，已停止自动重发；请保留任务记录并联系支持查询结果"];

/**
 * 请后端按已保存的上游回执重建「提交结论未确认」任务的结果。
 *
 * POST /tasks/:id/retry 对这类任务只会先走回执恢复，取不到回执就拒绝（4xx），不会重新提交上游。
 * 只发一次，不重试也不等待：成功后由调用方照常取回写回；返回 undefined 只表示后端明确确认结果取不回；
 * 其他错误原样抛出，调用方交给「继续取回」，不得据此新建任务。
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
        if (latest.status !== "failed" && latest.status !== "cancelled") return latest;
        if (RESULT_GONE_MESSAGES.includes((error as ApiError).message.trim())) return undefined;
        throw error;
    }
}
