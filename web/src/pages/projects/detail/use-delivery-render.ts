import { useCallback, useMemo, useState } from "react";
import { App } from "antd";

import { buildDeliveryTimeline } from "@/lib/timeline/shot-sequence-timeline";
import { createUnitWorkflow, type ProjectDetail, type WorkflowStep } from "@/services/api/projects";
import { waitForGenerationTask } from "@/services/api/task-center";
import { createTimelineRenderTask, type TimelineRenderResult } from "@/services/api/timeline-tasks";

/** 服务端渲染上限 60 分钟，前端多留余量（与时间线编辑器的导出保持一致）。 */
const DELIVERY_RENDER_TIMEOUT_MS = 62 * 60 * 1000;

export type DeliveryRenderPhase = "idle" | "running" | "done" | "error";

type UseDeliveryRenderOptions = {
    detail: ProjectDetail;
    projectId: string;
    unitId: string;
    /** 已存在的交付阶段；缺失时提交前会先建立该单元的工作流。 */
    deliveryStep?: WorkflowStep;
    onRefresh: () => Promise<void>;
};

/**
 * 一键成片：把本章镜头编成时间线，提交后端 timeline_render 任务并轮询到终态。
 *
 * 渲染由服务端 ffmpeg 完成，不经模型路由，因此这里不校验渠道配置；
 * 产物通过 delivery 阶段的 outputJson 回传（任务列表不下发 resultJson）。
 */
export function useDeliveryRender({ detail, projectId, unitId, deliveryStep, onRefresh }: UseDeliveryRenderOptions) {
    const { message } = App.useApp();
    const [phase, setPhase] = useState<DeliveryRenderPhase>("idle");
    const [progress, setProgress] = useState(0);
    const [statusText, setStatusText] = useState("");
    const [error, setError] = useState("");

    const { timeline, issues, shotCount } = useMemo(() => buildDeliveryTimeline(detail, unitId), [detail, unitId]);
    const readyCount = shotCount - issues.length;

    const render = useCallback(async () => {
        if (phase === "running") return;
        if (!shotCount) {
            message.warning("本章还没有镜头，请先在分镜脚本中创建");
            return;
        }
        if (issues.length) {
            message.warning(`还有 ${issues.length} 个镜头没有可用视频，请先补齐`);
            return;
        }
        setPhase("running");
        setProgress(0);
        setStatusText("提交渲染任务…");
        setError("");
        try {
            let step = deliveryStep;
            if (!step) {
                const initialized = await createUnitWorkflow(projectId, unitId);
                step = (initialized.workflow.steps || []).find((item) => item.stepKey === "delivery");
            }
            if (!step) throw new Error("交付阶段不可用，请刷新页面后重试");
            const created = await createTimelineRenderTask({
                projectId,
                timeline,
                metadata: {
                    workflowStepId: step.id,
                    domainProjectId: projectId,
                    unitId,
                    artifactType: "delivery",
                    role: "output",
                    // 成片是单元级产物：带上 shotId 会被写成镜头产物，破坏 ShotArtifact 的镜头级语义。
                    mediaType: "video",
                },
            });
            const finished = await waitForGenerationTask(created.id, {
                timeoutMs: DELIVERY_RENDER_TIMEOUT_MS,
                intervalMs: 3000,
                onTaskUpdate: (task) => {
                    setProgress(task.progress ?? 0);
                    setStatusText(task.stage || "渲染中…");
                },
            });
            const parsed = JSON.parse(finished.resultJson || "{}") as TimelineRenderResult;
            if (!parsed.resourceId) throw new Error("渲染任务未返回产物");
            await onRefresh();
            setPhase("done");
            setProgress(100);
            setStatusText(`成片完成：${parsed.fileName || "episode.mp4"}`);
            message.success("成片渲染完成");
        } catch (caught) {
            const text = caught instanceof Error ? caught.message : "成片渲染失败";
            setPhase("error");
            setError(text);
            setStatusText("");
            // 并发上限、素材缺失等失败原因必须原样展示。
            message.error(text);
        }
    }, [deliveryStep, issues.length, message, onRefresh, phase, projectId, shotCount, timeline, unitId]);

    return {
        durationMs: timeline.durationMs,
        error,
        issues,
        phase,
        progress,
        readyCount,
        render,
        shotCount,
        statusText,
    };
}
