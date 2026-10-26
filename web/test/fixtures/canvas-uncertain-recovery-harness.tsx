import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasNodeContent } from "../../src/components/canvas/canvas-node-content";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "../../src/types/canvas";

type Scenario = "settled" | "gone" | "running" | "kept";

const scenarios: Record<Scenario, CanvasNodeMetadata> = {
    // 上游可能已经生成，任务却已经终态：客户端自动按原任务取回结果，不给重新生成入口。
    settled: {
        status: "error",
        taskId: "task-settled",
        taskStatus: "failed",
        taskStage: "submission_unknown",
        taskErrorCode: "submission_uncertain",
        generationErrorCode: "submission_uncertain",
        generationSubmissionState: "unknown",
        errorDetails: "上一次提交结果不明确，为避免重复创建上游任务已停止自动重发",
        prompt: "一只在雨里奔跑的猫",
    },
    // 后端确认这次结果取不回：必须重新给出「重新生成」出口。
    gone: {
        status: "error",
        taskId: "task-gone",
        taskStatus: "failed",
        taskStage: "submission_unknown",
        taskErrorCode: "submission_uncertain",
        generationErrorCode: "submission_uncertain",
        generationSubmissionState: "unknown",
        resourceReloadAvailable: false,
        errorDetails: "原任务已结束，结果已取不回；可以重新生成",
        prompt: "一只在雨里奔跑的猫",
    },
    // 结论未知：仍然只能等待/查询原任务，不能重新生成。
    running: {
        status: "error",
        taskId: "task-running",
        taskStatus: "running",
        taskStage: "submission_unknown",
        generationErrorCode: "submission_uncertain",
        generationSubmissionState: "unknown",
        errorDetails: "上一次提交结果不明确，为避免重复创建上游任务已停止自动重发",
        prompt: "一只在雨里奔跑的猫",
    },
    // 结果已经保留：必须先取回，不能重新提交付费生成。
    kept: {
        status: "error",
        taskId: "task-kept",
        taskStatus: "succeeded",
        taskStage: "等待取回结果",
        generationErrorCode: "download_failed",
        errorDetails: "生成结果已保留，请点击「继续取回」",
        resourceReloadAvailable: true,
        prompt: "一只在雨里奔跑的猫",
    },
};

function Harness() {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [retries, setRetries] = useState(0);
    const [reloads, setReloads] = useState(0);
    const scenario = (new URLSearchParams(location.search).get("case") || "settled") as Scenario;
    const node: CanvasNodeData = {
        id: "image-uncertain",
        title: "生成失败",
        type: CanvasNodeType.Image,
        width: 320,
        height: 240,
        position: { x: 0, y: 0 },
        metadata: scenarios[scenario],
    };
    (window as unknown as { retries: number }).retries = retries;
    (window as unknown as { reloads: number }).reloads = reloads;
    return (
        <div style={{ width: 360, height: 300, padding: 12, background: canvasThemes.light.canvas.background }}>
            <CanvasNodeContent
                node={node}
                theme={canvasThemes.light}
                isEditingContent={false}
                textareaRef={textareaRef}
                isBatchRoot={false}
                batchCount={0}
                batchExpanded={false}
                batchOpening={false}
                batchRecovering={false}
                onContentChange={() => {}}
                onStopEditing={() => {}}
                mentionReferences={[]}
                onRetry={() => setRetries((value) => value + 1)}
                onReloadResource={() => setReloads((value) => value + 1)}
                onOpenTaskDetails={() => {}}
            />
        </div>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
