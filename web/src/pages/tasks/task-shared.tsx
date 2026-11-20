import { explainGenerationError } from "@/lib/generation-error";
import { operationLabelByValue } from "@/lib/generation-task-display";
import { canRecoverTaskOutcome, isTaskRegenerateBlocked, normalizeTaskOutcome, readTaskOutcome, taskOutcomeCopy, taskRequiresFreshSubmission } from "@/lib/task-outcome";
import { ApiError } from "@/services/api/request";
import { isActiveGenerationTask, type GenerationTask, type TaskStatus } from "@/services/api/task-center";
import { modelDisplayName, type AiConfig } from "@/stores/use-config-store";

export function getTaskCanvasContext(task: GenerationTask, canvasById: Map<string, { title: string; projectId?: string }>, projectNameById: Map<string, string>) {
    if (!task.projectId) return { canvasName: "未绑定画布", projectName: "" };
    const canvas = canvasById.get(task.projectId);
    if (canvas) return { canvasName: canvas.title || "未命名画布", projectName: canvas.projectId ? projectNameById.get(canvas.projectId) || "" : "" };
    const projectName = projectNameById.get(task.projectId);
    return projectName ? { canvasName: "项目级任务", projectName } : { canvasName: `未加载或已移除的画布 · ${task.projectId}`, projectName: "" };
}

export function isTaskFailed(task: GenerationTask) {
    const outcome = normalizeTaskOutcome(task.outcome);
    if (outcome) return outcome.phase === "failed";
    return task.status === "failed" || task.status === "cancelled" || task.status === "text_replay";
}

export function isTaskBadgeActive(task: Pick<GenerationTask, "status" | "outcome">) {
    return isActiveGenerationTask(task);
}

export function isTaskSucceeded(task: GenerationTask) {
    if (isTaskFailed(task) || isTaskBadgeActive(task)) return false;
    const outcome = normalizeTaskOutcome(task.outcome);
    if (outcome) return outcome.phase === "ready";
    return task.status === "succeeded";
}

export function matchesTaskCenterStatusFilter(task: GenerationTask, statusFilter: "all" | "active" | "failed" | "succeeded") {
    if (statusFilter === "all") return true;
    if (statusFilter === "failed") return isTaskFailed(task);
    if (statusFilter === "active") return !isTaskFailed(task) && isTaskBadgeActive(task);
    if (statusFilter === "succeeded") return isTaskSucceeded(task);
    return false;
}

export function computeTaskCenterStats(tasks: readonly GenerationTask[], now = new Date()) {
    let today = 0;
    let active = 0;
    let succeeded = 0;
    let failed = 0;
    for (const task of tasks) {
        if (task.createdAt) {
            const created = new Date(task.createdAt);
            if (!Number.isNaN(created.getTime()) && created.getFullYear() === now.getFullYear() && created.getMonth() === now.getMonth() && created.getDate() === now.getDate()) {
                today += 1;
            }
        }
        if (isTaskFailed(task)) failed += 1;
        else if (isTaskBadgeActive(task)) active += 1;
        else if (isTaskSucceeded(task)) succeeded += 1;
    }
    return { total: tasks.length, today, active, succeeded, failed };
}

export function shouldFastPollTaskCenter(tasks: readonly GenerationTask[]) {
    return tasks.some((task) => !isTaskFailed(task) && isTaskBadgeActive(task));
}

export function taskOutcomeCopyForTask(
    task: Pick<GenerationTask, "status" | "stage" | "errorCode" | "error" | "providerRequestId" | "providerCancelStatus" | "outcome" | "type" | "outputs">,
    outcome = readTaskOutcome(task),
) {
    return taskOutcomeCopy(outcome, undefined, { providerCancelStatus: task.providerCancelStatus });
}

/**
 * 判断任务中心是否不能就地复用原任务 `/tasks/:id/retry`（需保留原任务记录与图片幂等回执，改为新提交）：
 * - 命中共享 `taskRequiresFreshSubmission`（`outcome.regenerate === "confirm"`、`submission_unknown`/`submission_uncertain`、`providerCancelStatus === "requested"`、或无明确未扣费证据的 `canvas_image`）
 * - `outcome.reason === "input_rejected"`，或任务失败分类在后端 `BlocksRetry` / 内容审核守门内
 */
export function taskCenterRetryRequiresNewSubmission(
    task: Pick<GenerationTask, "type" | "status" | "stage" | "errorCode" | "error" | "providerRequestId" | "providerCancelStatus" | "outcome" | "outputs">,
    outcome = readTaskOutcome(task),
) {
    if (taskRequiresFreshSubmission(task, outcome)) return true;
    if (outcome?.reason === "input_rejected") return true;
    if (task.errorCode || task.error) {
        const explanation = explainGenerationError(
            { code: task.errorCode, message: task.error },
            { stage: task.stage },
        );
        if (explanation.moderation) return true;
        if (task.stage !== "请求尚未提交" && explanation.blockManualRetry) return true;
    }
    return false;
}

export function canBatchRetryTaskInTaskCenter(task: GenerationTask) {
    return isTaskFailed(task) && !isTaskRegenerateBlocked(task) && !taskCenterRetryRequiresNewSubmission(task);
}

export function canQueryProviderTask(
    task: Pick<GenerationTask, "status" | "type" | "providerRequestId" | "outcome" | "stage" | "errorCode" | "error" | "outputs">,
) {
    // 后端 RecoverTask 对 cancelled 状态固定返回不支持，避免对已取消的 evidence_unavailable 任务暴露必然失败的「取回结果」按钮。
    if (task.status === "cancelled") return false;
    if (task.outcome) return canRecoverTaskOutcome(readTaskOutcome(task));
    return canRecoverTaskOutcome(readTaskOutcome(task)) || (task.status === "failed" && (task.type.startsWith("canvas_video") || task.type.startsWith("video_")) && Boolean(task.providerRequestId));
}

export type TaskCanvasAvailability = "available" | "missing" | "unreachable";

export type TaskCenterNewSubmissionRoute =
    | { kind: "navigate_canvas"; canvasId: string }
    | { kind: "prefill_video_modal"; values: { operation: string; prompt: string; model: string; projectId?: string } }
    | { kind: "warn"; message: string }
    | { kind: "error"; message: string };

const TEXT_ONLY_VIDEO_MODAL_OPERATIONS = new Set(["text_to_video", "compare_versions"]);

function isCanvasNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { name?: unknown; status?: unknown };
    return (error instanceof ApiError || candidate.name === "ApiError") && candidate.status === 404;
}

export async function checkTaskCanvasAvailability(
    projectId: string,
    canvasById: ReadonlyMap<string, unknown>,
    readCanvasFromBackend: (id: string) => Promise<unknown>,
): Promise<TaskCanvasAvailability> {
    if (canvasById.has(projectId)) return "available";
    try {
        await readCanvasFromBackend(projectId);
        return "available";
    } catch (error) {
        return isCanvasNotFoundError(error) ? "missing" : "unreachable";
    }
}

function hasNonEmptyMediaOrSpecialParams(inputJson?: string): boolean {
    const trimmed = inputJson?.trim();
    if (!trimmed) return false;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return true;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
    const input = parsed as Record<string, unknown>;
    if (Array.isArray(input.referenceImages) && input.referenceImages.length > 0) return true;
    if (Array.isArray(input.referenceVideos) && input.referenceVideos.length > 0) return true;
    if (Array.isArray(input.referenceAudios) && input.referenceAudios.length > 0) return true;
    if (input.mask || input.upscale || input.subtitleErase) return true;
    return false;
}

export function canPrefillVideoCreateModal(
    task: Pick<GenerationTask, "type" | "operation" | "inputJson">,
): { allowed: boolean; operation: string } {
    if (!task.type.startsWith("video_")) return { allowed: false, operation: "" };
    const operation = (task.operation || task.type.replace(/^video_/, "")).trim();
    if (!operation || !operationLabelByValue.has(operation)) return { allowed: false, operation };
    if (!task.inputJson?.trim() && !TEXT_ONLY_VIDEO_MODAL_OPERATIONS.has(operation)) return { allowed: false, operation };
    if (hasNonEmptyMediaOrSpecialParams(task.inputJson)) return { allowed: false, operation };
    return { allowed: true, operation };
}

export function resolveTaskCenterNewSubmissionRoute(
    task: Pick<GenerationTask, "type" | "operation" | "prompt" | "model" | "projectId" | "inputJson" | "clientContext">,
    copyMessage: string,
    canvasAvailability?: TaskCanvasAvailability,
): TaskCenterNewSubmissionRoute {
    const projectId = task.projectId?.trim();
    if (projectId) {
        const availability = canvasAvailability ?? "missing";
        if (availability === "unreachable") {
            return { kind: "error", message: "暂时无法确认原画布状态，请稍后重试" };
        }
        if (availability === "missing") {
            return { kind: "warn", message: `${copyMessage} 原画布已不存在，请在创作页或新建画布后重新生成` };
        }
        if (!task.type.startsWith("video_") || task.clientContext?.nodeId) {
            return { kind: "navigate_canvas", canvasId: projectId };
        }
        const prefill = canPrefillVideoCreateModal(task);
        if (!prefill.allowed) {
            return { kind: "warn", message: `${copyMessage} 原任务包含参考素材或专用参数，请前往对应画布或原创作入口重新生成` };
        }
        return {
            kind: "prefill_video_modal",
            values: {
                operation: prefill.operation,
                prompt: task.prompt || "",
                model: task.model || "",
                projectId,
            },
        };
    }
    if (task.type.startsWith("video_")) {
        const prefill = canPrefillVideoCreateModal(task);
        if (!prefill.allowed) {
            return { kind: "warn", message: `${copyMessage} 原任务包含参考素材或专用参数，任务中心无法直接携带原素材重建，请前往原创作入口重新提交` };
        }
        return {
            kind: "prefill_video_modal",
            values: {
                operation: prefill.operation,
                prompt: task.prompt || "",
                model: task.model || "",
                projectId: undefined,
            },
        };
    }
    return { kind: "warn", message: `${copyMessage} 请前往原创作页或新建画布后重新生成` };
}

export function taskAttentionReason(task: GenerationTask) {
    const outcome = normalizeTaskOutcome(task.outcome) ?? (task.status === "text_replay" ? readTaskOutcome(task) : undefined);
    if (outcome) {
        if (
            outcome.phase === "retrievable" ||
            outcome.reason === "settlement_pending" ||
            outcome.reason === "billing_pending" ||
            outcome.reason === "reconcile_pending" ||
            outcome.reason === "cancelled_result_unconfirmed" ||
            outcome.reason === "charged_result_unrecoverable" ||
            outcome.reason === "result_unrecoverable" ||
            outcome.reason === "no_result" ||
            (outcome.phase === "failed" && (task.providerCancelStatus === "requested" || task.providerCancelStatus === "uncertain")) ||
            (!task.error && !task.errorCode && task.status !== "cancelled")
        ) {
            return taskOutcomeCopy(outcome, undefined, { providerCancelStatus: task.providerCancelStatus }).message;
        }
    }
    if (!outcome && task.status === "cancelled") return providerCancelStatusLabel(task);
    const explanation = explainGenerationError(
        { code: task.errorCode, message: task.error },
        { taskId: task.id, providerRequestId: task.providerRequestId, model: task.model, createdAt: task.createdAt, stage: outcome ? undefined : task.stage },
    );
    const text = explanation.message.trim();
    if (text.startsWith("{") || text.startsWith("[")) return explanation.reason || "生成失败，打开详情查看原因";
    if (explanation.moderation) return explanation.message;
    if (task.error || task.errorCode) return explanation.message;
    if (outcome) return taskOutcomeCopy(outcome, undefined, { providerCancelStatus: task.providerCancelStatus }).message;
    return task.stage || "生成失败，打开详情查看原因";
}

export function providerCancelStatusLabel(task: GenerationTask) {
    const outcome = normalizeTaskOutcome(task.outcome);
    if (task.providerCancelStatus === "confirmed") {
        return outcome?.reason === "cancelled_result_unconfirmed"
            ? taskOutcomeCopy(outcome, undefined, { providerCancelStatus: "confirmed" }).reason
            : "上游已确认取消";
    }
    if (task.providerCancelStatus === "requested") return "已请求上游取消，正在等待确认";
    if (task.providerCancelStatus === "uncertain") {
        return task.providerCancelError || "上游无法确认取消，状态待确认";
    }
    if (outcome?.reason === "cancelled_result_unconfirmed") return taskOutcomeCopy(outcome).message;
    return "任务已取消，请核对原任务的结果与扣费状态";
}

export function statusDotClassName(target: TaskStatus | Pick<GenerationTask, "status" | "outcome">) {
    const status = typeof target === "string" ? target : target.status;
    const outcome = typeof target === "string" ? undefined : normalizeTaskOutcome(target.outcome);
    if (outcome) {
        if (outcome.phase === "ready") return "task-record-dot is-success";
        if (outcome.phase === "running" || outcome.phase === "fetching" || outcome.phase === "retrievable") {
            return status === "queued" ? "task-record-dot is-queued" : "task-record-dot is-active is-pulsing";
        }
        if (outcome.phase === "failed") {
            return status === "cancelled" ? "task-record-dot is-idle" : "task-record-dot is-failed";
        }
    }
    if (status === "succeeded") return "task-record-dot is-success";
    if (status === "running") return "task-record-dot is-active is-pulsing";
    if (status === "queued") return "task-record-dot is-queued";
    if (status === "failed" || status === "text_replay") return "task-record-dot is-failed";
    return "task-record-dot is-idle";
}

export function taskMediaKind(task: GenerationTask): "text" | "image" | "video" {
    const value = `${task.type} ${task.operation || ""}`.toLowerCase();
    if (value.includes("video") || value.includes("视频")) return "video";
    if (value.includes("image") || value.includes("图片") || value.includes("画面")) return "image";
    return "text";
}

export function TaskDate({ value }: { value?: string }) {
    if (!value) return <span className="text-xs text-foreground/38">-</span>;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return <span className="text-xs text-foreground/38">-</span>;
    const compact = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
    return (
        <time className="task-record-date-value" dateTime={date.toISOString()} title={date.toLocaleString()}>
            {compact}
        </time>
    );
}

export function formatModelName(config: AiConfig, task: GenerationTask) {
    const raw = (task.model || task.provider || "").trim();
    const model = raw.includes("::") ? raw.split("::").pop()?.trim() || raw : raw;

    if (!model) return "工作流";
    if (model === "version-router") return "版本对比工作流";
    if (model === "workflow-router") return "工作流路由";
    if (model === "internal-agent") return "内置工作流";
    if (model === "openai-compatible") return "OpenAI 兼容接口";
    return modelDisplayName(config, raw);
}
