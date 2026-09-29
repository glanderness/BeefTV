import { http } from "@/services/api/request";
import type { GenerationTask } from "@/services/api/task-center";
import type { TimelineProject } from "@/types/timeline";

// 时间线字幕转写任务 API。
// 创建入参与后端 TimelineTranscriptionCreateRequest 保持同名字段，结果由任务中心统一查询。

export type TimelineTranscriptionCreateRequest = {
    resourceId: string;
    language?: string;
    projectId?: string;
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
    signal?: AbortSignal,
): Promise<GenerationTask> {
    return http.post<GenerationTask>("/timeline/transcriptions", payload, { signal });
}

// 时间线成片渲染任务 API。
// timeline 直接传 TimelineProject；后端使用同名字段构建渲染输入，未知字段由后端边界忽略。
// 任务完成后由任务中心读取 ResultJSON，并按 TimelineRenderResult 解包。

export type TimelineRenderCreateRequest = {
    projectId: string;
    timeline: TimelineProject;
    /**
     * 产物登记元数据。短剧成片用它把结果写回对应工作流阶段（workflowStepId / unitId /
     * artifactType），由后端 RegisterTaskOutputFromTask 读取。时间线编辑器不传该字段。
     */
    metadata?: Record<string, unknown>;
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
    signal?: AbortSignal,
): Promise<GenerationTask> {
    return http.post<GenerationTask>("/timeline/renders", payload, { signal });
}
