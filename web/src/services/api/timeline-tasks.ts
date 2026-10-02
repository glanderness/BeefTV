import { assertCanonicalPlan, type CanonicalPlanOptions, type CanonicalSourceMeta, type CanonicalTimelinePlan } from "@/lib/timeline/timeline-canonical-plan";
import { http, type HttpRequestConfig } from "@/services/api/request";
import type { GenerationTask } from "@/services/api/task-center";
import type { TimelineProject } from "@/types/timeline";

// 时间线字幕转写任务 API。
// 创建入参与后端 TimelineTranscriptionCreateRequest 保持同名字段，结果由任务中心统一查询。

export type TimelineTranscriptionCreateRequest = {
    resourceId: string;
    language?: string;
    projectId?: string;
    clientOperationId?: string;
};

export type TimelineTranscriptionResult = {
    segments: TimelineTranscriptionSegment[];
    srt?: string;
    language?: string;
};

export type TimelineTranscriptionSegment = {
    startMs: number;
    endMs: number;
    text: string;
};

export async function createTimelineTranscriptionTask(
    payload: TimelineTranscriptionCreateRequest,
    config?: HttpRequestConfig,
): Promise<GenerationTask> {
    return http.post<GenerationTask>("/timeline/transcriptions", payload, config);
}

// 时间线成片渲染任务 API。
// timeline 直接传 TimelineProject；后端使用同名字段构建渲染输入，未知字段由后端边界忽略。
// 任务完成后由任务中心读取 ResultJSON，并按 TimelineRenderResult 解包。

export type TimelineRenderCreateRequest = {
    projectId: string;
    timeline: TimelineProject;
    options?: CanonicalPlanOptions;
    clientOperationId?: string;
};

export type TimelineRenderResult = {
    resourceId: string;
    fileName?: string;
    size?: number;
    durationMs?: number;
    subtitleSrt?: string;
};

export async function createTimelineRenderTask(
    payload: TimelineRenderCreateRequest,
    config?: HttpRequestConfig,
): Promise<GenerationTask> {
    return http.post<GenerationTask>("/timeline/renders", payload, config);
}

export type TimelineRenderPlanCompileRequest = {
    timeline: TimelineProject;
    sources?: CanonicalSourceMeta[];
    options?: CanonicalPlanOptions;
};

/** 只读规划：不排队、不落盘、不计费。失败必须上抛，导出不得改走本地语义编译。 */
export async function compileTimelineRenderPlan(
    payload: TimelineRenderPlanCompileRequest,
    signal?: AbortSignal,
): Promise<CanonicalTimelinePlan> {
    const plan = await http.post<CanonicalTimelinePlan>("/timeline/render-plan", payload, { signal });
    assertCanonicalPlan(plan);
    return plan;
}
