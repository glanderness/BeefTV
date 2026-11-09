import { useLayoutEffect, useRef, useState } from "react";
import { App } from "antd";
import {
    beginLocalExecutorSession, localExecutorFrozenInputKey, localExecutorIntentAfterError,
    localExecutorIntentAfterSubmit, nextLocalExecutorClientOperationId, runOwnedTimelineRender,
    type LocalExecutorIntentState,
} from "@/lib/plugins/builtin/editor/local-executor-session";
import { prepareTimelineRenderSnapshot } from "@/lib/timeline/timeline-render-snapshot";
import { cancelGenerationTask } from "@/services/api/task-center";
import { getResource, resourceFileUrl, type RemoteResource } from "@/services/api/resources";
import { downloadOwnedOrBrowserMedia } from "@/services/desktop-media-save";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineProject } from "@/types/timeline";

export type CreateAssembledNode = (resource: RemoteResource, title: string, signal: AbortSignal) => Promise<CanvasNodeData | null>;
type ExportRun = {
    canvasId: string;
    nodeId: string;
    controller: AbortController;
    intent: LocalExecutorIntentState;
    delivering: boolean;
    cancelling: boolean;
};
const idle = { busy: false, finalizing: false, canCancel: false, percent: 0, detail: "" };

export function useCanvasTimelineExport(input: {
    canvasId: string; node: CanvasNodeData; nodes: CanvasNodeData[]; open: boolean;
    draft: TimelineProject; onCreateAssembledNode: CreateAssembledNode;
}) {
    const { message } = App.useApp();
    const [state, setState] = useState(idle);
    const active = useRef<ExportRun | null>(null);
    const intent = useRef<LocalExecutorIntentState | undefined>(undefined);
    const live = useRef(input);
    live.current = input;
    const ownsWindow = (run: ExportRun) => active.current === run && live.current.open
        && live.current.canvasId === run.canvasId && live.current.node.id === run.nodeId;
    const assertCurrent = (run: ExportRun) => {
        if (!ownsWindow(run) || run.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    };
    const detach = () => {
        const run = active.current;
        active.current = null;
        intent.current = undefined;
        run?.controller.abort();
        setState(idle);
    };
    useLayoutEffect(() => {
        setState(idle);
        return detach;
    }, [input.canvasId, input.node.id, input.open]);

    const execute = async (mode: "download" | "node") => {
        if (active.current || !input.open) return;
        let run: ExportRun | undefined;
        try {
            if (!input.canvasId) throw new Error("缺少当前画布，无法提交导出");
            const timeline = prepareTimelineRenderSnapshot(input.draft, input.nodes);
            const frozenInputKey = localExecutorFrozenInputKey([input.canvasId, input.node.id, mode, timeline]);
            const next = { clientOperationId: nextLocalExecutorClientOperationId(intent.current, frozenInputKey), frozenInputKey };
            run = { canvasId: input.canvasId, nodeId: input.node.id, controller: new AbortController(), intent: next, delivering: false, cancelling: false };
            const current = run;
            const title = input.node.title || "成片";
            active.current = current;
            intent.current = next;
            setState({ ...idle, busy: true, detail: "正在提交后台导出" });
            const session = beginLocalExecutorSession(current.canvasId, {
                controller: current.controller, getLiveProjectId: () => live.current.canvasId,
            });
            const { result } = await runOwnedTimelineRender({
                session, projectId: current.canvasId, timeline, clientOperationId: next.clientOperationId,
                onCreated: task => {
                    assertCurrent(current);
                    current.intent = localExecutorIntentAfterSubmit(next.clientOperationId, task, next);
                    intent.current = current.intent;
                    setState({ ...idle, busy: true, canCancel: task.status === "queued" || task.status === "running", detail: "后台正在渲染" });
                },
                onTaskUpdate: task => {
                    assertCurrent(current);
                    setState({ ...idle, busy: true, canCancel: task.status === "queued" || task.status === "running",
                        percent: task.progress || 0, detail: task.stage || "后台正在渲染" });
                },
            });
            assertCurrent(current);
            current.delivering = true;
            setState({ ...idle, busy: true, finalizing: true, percent: 100, detail: "正在保存成片" });
            if (mode === "download") {
                const saved = await downloadOwnedOrBrowserMedia({ resourceId: result.resourceId, browserUrl: resourceFileUrl(result.resourceId), fileName: `${title}.mp4` });
                assertCurrent(current);
                if (saved === "saved") message.success("成片导出完成");
            } else {
                const resource = await getResource(result.resourceId, { signal: current.controller.signal });
                assertCurrent(current);
                if (resource.id !== result.resourceId || resource.status !== "ready" || resource.kind !== "video") throw new Error("成片资源尚未就绪，请到任务中心查看");
                const created = await input.onCreateAssembledNode(resource, `${title}-新片段`, current.controller.signal);
                assertCurrent(current);
                if (created) message.success("已生成新视频片段并放到画布，可继续编辑字幕与样式");
            }
        } catch (error) {
            if (run && (!ownsWindow(run) || run.controller.signal.aborted)) return;
            if (run) intent.current = localExecutorIntentAfterError(run.intent, error);
            const detail = error instanceof Error ? error.message : "导出失败";
            message.error(run ? `${detail}；后台任务可到任务中心确认` : detail);
        } finally {
            if (run && ownsWindow(run) && !run.cancelling) {
                active.current = null;
                setState(idle);
            }
        }
    };

    const cancel = async () => {
        const run = active.current;
        if (!run || run.delivering || run.cancelling || !run.intent.submittedTaskId) return;
        run.cancelling = true;
        run.controller.abort();
        setState(current => ({ ...current, canCancel: false, detail: "正在请求取消后台导出" }));
        try {
            const task = await cancelGenerationTask(run.intent.submittedTaskId);
            if (ownsWindow(run)) message.info(task.status === "cancelled" ? "后台导出已取消" : "任务状态已变化，请到任务中心确认并下载成片");
        } catch (error) {
            if (ownsWindow(run)) message.error(`取消未完成：${error instanceof Error ? error.message : "请求失败"}；请到任务中心确认状态`);
        } finally {
            if (ownsWindow(run)) {
                active.current = null;
                setState(idle);
            }
        }
    };

    return {
        ...state,
        exportFile: () => execute("download"),
        createNode: () => execute("node"),
        cancel,
        requestClose: () => {
            if (active.current?.delivering) return false;
            detach();
            return true;
        },
    };
}
