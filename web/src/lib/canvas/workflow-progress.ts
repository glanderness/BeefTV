import { isWorkflowOperation } from "./workflow-editor";
import type { WorkflowDefinition, WorkflowRun } from "@/services/api/canvas-workflows";

export function workflowProgress(definition: WorkflowDefinition, run?: WorkflowRun, inputsChanged = false): { percent: number; stage: string } {
    if (!run || inputsChanged) return { percent: 0, stage: "等待运行" };
    const operations = definition.nodes.filter(isWorkflowOperation);
    const steps = operations.map(node => run.steps.find(step => step.nodeId === node.id));
    const sum = steps.reduce((total, step) => total + (step?.status === "succeeded" ? 100 : Number.isFinite(step?.progress) ? Math.max(0, Math.min(99, step!.progress!)) : 0), 0);
    const percent = run.status === "succeeded" ? 100 : Math.min(99, Math.floor(sum / Math.max(1, operations.length)));
    if (run.status === "succeeded") return { percent, stage: "全部处理完成" };
    if (run.status === "failed") return { percent, stage: "处理失败" };
    if (run.status === "cancelled") return { percent, stage: "已停止处理" };
    const active = steps.find(step => step?.status === "running" || step?.status === "waiting_selection");
    return { percent, stage: active?.status === "waiting_selection" ? "等待选择图片" : active?.stage || (active ? `正在处理${active.title || "当前步骤"}` : "等待开始处理") };
}
