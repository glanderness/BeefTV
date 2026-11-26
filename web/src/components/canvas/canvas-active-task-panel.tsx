import { ChevronDown, LocateFixed } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { findCanvasGenerationTaskTarget } from "@/lib/canvas/canvas-generation-task-identity";
import { formatTaskKind, generationTaskShowsProgress, generationTaskStageLabel, generationTaskStatusLabel, operationLabelByValue } from "@/lib/generation-task-display";
import { configuredModelDisplayName } from "@/lib/model-selection";
import type { GenerationTask } from "@/services/api/task-center";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { useConfigStore } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

// 顶栏是绝对定位浮层，面板必须按调用方传入的 topInset 避让；专注模式隐藏顶栏时传小间距。
export function CanvasActiveTaskPanel({ tasks, nodes, align = "right", topInset = "var(--canvas-topbar-offset)", onCancelTask, onLocateNode, refreshFailed, refreshing, onRefresh }: {
    tasks: GenerationTask[];
    nodes: readonly CanvasNodeData[];
    align?: "left" | "right";
    topInset?: string;
    onCancelTask?: (task: GenerationTask) => void;
    onLocateNode: (nodeId: string) => void;
    refreshFailed?: boolean;
    refreshing?: boolean;
    onRefresh?: () => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const config = useConfigStore((state) => state.config);
    const listId = useId();
    const [now, setNow] = useState(() => Date.now());
    const [open, setOpen] = useState(false);
    const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
    const visibleTasks = useMemo(() => tasks.flatMap((task) => {
        if (task.status !== "queued" && task.status !== "running") return [];
        const target = findCanvasGenerationTaskTarget(task, nodes);
        if (!target || (target.metadata?.taskId && target.metadata.taskId !== task.id)) return [];
        return [{ task, targetId: target.id }];
    }), [tasks, nodes]);
    const ticking = open && visibleTasks.length > 0;

    useEffect(() => {
        if (!ticking) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [ticking]);

    useEffect(() => {
        if (expandedTaskId && !visibleTasks.some(({ task }) => task.id === expandedTaskId)) setExpandedTaskId(null);
    }, [expandedTaskId, visibleTasks]);

    if (!visibleTasks.length) return null;

    return (
        <section
            data-canvas-no-zoom
            aria-label="当前画布生成任务"
            className={`absolute z-[var(--z-panel-floating)] w-[var(--canvas-panel-width)] overflow-hidden rounded-[var(--panel-radius)] border ${align === "left" ? "left-3" : "right-3"}`}
            style={{ top: topInset, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, boxShadow: `0 8px 24px ${theme.spatial.shadow}` }}
        >
            <button
                type="button"
                className="flex min-h-10 w-full items-center gap-3 px-3.5 py-2 text-left text-xs hover:bg-foreground/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => setOpen((value) => !value)}
            >
                <span className="flex-1 font-semibold">生成任务</span>
                <span className="tabular-nums" style={{ color: theme.node.muted }} aria-live="polite">{refreshFailed ? "刷新失败" : `${visibleTasks.length} 项`}</span>
                <ChevronDown className={`size-3.5 shrink-0 ${open ? "rotate-180" : ""}`} style={{ color: theme.node.muted }} aria-hidden />
            </button>

            <ul id={listId} hidden={!open} className="thin-scrollbar m-0 max-h-[min(70vh,520px)] list-none overflow-y-auto border-t p-0" style={{ borderColor: theme.toolbar.border }}>
                {open && refreshFailed && <li className="flex items-center justify-between gap-2 border-b px-3.5 py-2 text-xs" style={{ borderColor: theme.toolbar.border }}>
                    <span role="status">刷新失败，显示上次状态</span>
                    <button type="button" className="shrink-0 hover:underline" disabled={refreshing} onClick={onRefresh}>重试刷新</button>
                </li>}
                {open && visibleTasks.map(({ task, targetId }) => {
                    const expanded = expandedTaskId === task.id;
                    return (
                        <ActiveTaskRow
                            key={task.id}
                            task={task}
                            modelName={task.model && configuredModelDisplayName(config, task.model)}
                            now={now}
                            theme={theme}
                            expanded={expanded}
                            onToggle={() => setExpandedTaskId((current) => (current === task.id ? null : task.id))}
                            onCancelTask={onCancelTask}
                            onLocate={() => onLocateNode(targetId)}
                        />
                    );
                })}
            </ul>
        </section>
    );
}

function ActiveTaskRow({ task, modelName, now, theme, expanded, onToggle, onCancelTask, onLocate }: {
    task: GenerationTask;
    modelName?: string;
    now: number;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    expanded: boolean;
    onToggle: () => void;
    onCancelTask?: (task: GenerationTask) => void;
    onLocate: () => void;
}) {
    const detailsId = useId();
    const kind = (task.operation && operationLabelByValue.get(task.operation)) || formatTaskKind(task);
    const title = modelName && modelName.split(/\s*·\s*/).at(-1) !== kind ? `${modelName} · ${kind}` : modelName || kind;
    const status = generationTaskStatusLabel(task);
    const stage = generationTaskStageLabel(task);
    const summary = status === "生成中" ? stage : status;
    const extraStage = stage !== summary ? stage : "";
    const progress = generationTaskShowsProgress(task) && typeof task.progress === "number" && Number.isFinite(task.progress)
        ? Math.min(100, Math.round(task.progress))
        : 0;
    const startedAt = Date.parse(task.startedAt || task.createdAt);
    const elapsed = formatDuration(Math.max(0, now - (Number.isFinite(startedAt) ? startedAt : now)));
    const elapsedLabel = task.status === "queued" ? "已等待" : "已运行";
    const prompt = task.prompt?.trim();
    const rowLayout = "grid grid-cols-[minmax(0,1fr)_auto_0.875rem] items-center gap-2";

    const heading = (
        <>
            <span className="truncate font-medium leading-5" title={title}>{title}</span>
            <span className="justify-self-end leading-5 tabular-nums" aria-label={`${elapsedLabel} ${elapsed}`} title={elapsedLabel} style={{ color: theme.node.muted }}>
                {elapsed}
            </span>
            <ChevronDown className={`size-3.5 ${expanded ? "rotate-180" : ""}`} style={{ color: theme.node.muted }} aria-hidden />
        </>
    );

    return (
        <li className="border-b px-3.5 py-2.5 text-xs last:border-b-0" style={{ borderColor: theme.toolbar.border }}>
            <button
                type="button"
                className={`${rowLayout} w-full rounded-sm text-left focus-visible:outline focus-visible:outline-2`}
                onClick={onToggle}
                aria-expanded={expanded}
                aria-controls={detailsId}
            >
                {heading}
            </button>
            <div className={`${rowLayout} mt-0.5`}>
                <span className="break-words leading-4" style={{ color: theme.node.muted }}>
                    {summary}
                    {progress > 0 && <span className="whitespace-nowrap tabular-nums"> · {progress}%</span>}
                </span>
                {onCancelTask && (
                    <button
                        type="button"
                        className="min-h-6 justify-self-end whitespace-nowrap rounded-sm font-medium leading-4 hover:underline focus-visible:outline focus-visible:outline-2"
                        style={{ color: theme.accent.danger }}
                        onClick={(event) => {
                            event.stopPropagation();
                            onCancelTask?.(task);
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        取消任务
                    </button>
                )}
            </div>
            <div id={detailsId} hidden={!expanded} className="mt-2 space-y-1 break-words leading-4" style={{ color: theme.node.muted }}>
                {extraStage && <div>{extraStage}</div>}
                <button
                    type="button"
                    title="定位到画布节点"
                    className="group flex w-full items-start gap-2 rounded-sm text-left leading-4 hover:text-foreground focus-visible:outline focus-visible:outline-2"
                    onClick={onLocate}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    {prompt && <span className="sr-only">定位到画布节点</span>}
                    <span className="line-clamp-2 min-w-0 flex-1">{prompt || "定位到画布节点"}</span>
                    <LocateFixed className="mt-0.5 size-3.5 shrink-0 opacity-70 group-hover:opacity-100" aria-hidden />
                </button>
            </div>
        </li>
    );
}

function formatDuration(value: number) {
    const totalSeconds = Math.floor(value / 1_000);
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
