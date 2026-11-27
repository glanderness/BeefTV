import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasActiveTaskPanel } from "@/components/canvas/canvas-active-task-panel";
import { CanvasNode } from "@/components/canvas/canvas-node";
import {
    deliveryPendingTaskOutcome,
    fetchingTaskOutcome,
    isTaskActiveInPanel,
    nodeBadgeFromOutcome,
    notChargedTaskOutcome,
    readyTaskOutcome,
    runningTaskOutcome,
    submissionUnknownTaskOutcome,
    taskStopActionKind,
    taskStopActionLabel,
} from "@/lib/task-outcome";
import { CanvasProjectStatusDialogs } from "@/pages/canvas/canvas-project-status-dialogs";
import type { GenerationTask } from "@/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function makeNode(id: string, metadata: CanvasNodeData["metadata"]): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: "测试图片",
        position: { x: 0, y: 0 },
        width: 320,
        height: 320,
        metadata,
    };
}

function makeTask(id: string, overrides: Partial<GenerationTask>): GenerationTask {
    const now = "2026-11-27T12:00:00.000Z";
    return {
        id,
        type: "canvas_image",
        status: "running",
        stage: "生成中",
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

describe("#297 task outcome panel visibility, stop actions, and node status badge", () => {
    test("isTaskActiveInPanel and taskStopActionKind derive consistently from TaskOutcome", () => {
        const running = makeTask("t-run", { status: "running", outcome: runningTaskOutcome() });
        const fetching = makeTask("t-fetch", { status: "succeeded", stage: "正在取回结果", outcome: fetchingTaskOutcome() });
        const retrievable = makeTask("t-ret", { status: "failed", stage: "submission_unknown", outcome: submissionUnknownTaskOutcome() });
        const stopped = makeTask("t-stop", { status: "failed", stage: "recovery_stopped", outcome: submissionUnknownTaskOutcome() });
        const paused = makeTask("t-pause", { status: "succeeded", stage: "delivery_paused", outcome: deliveryPendingTaskOutcome() });
        const ready = makeTask("t-ready", { status: "succeeded", stage: "生成完成", outcome: readyTaskOutcome() });
        const failed = makeTask("t-fail", { status: "failed", stage: "任务失败", outcome: notChargedTaskOutcome() });

        expect(isTaskActiveInPanel(running)).toBe(true);
        expect(taskStopActionKind(running)).toBe("cancel");
        expect(taskStopActionLabel("cancel")).toBe("取消任务");

        expect(isTaskActiveInPanel(fetching)).toBe(true);
        expect(taskStopActionKind(fetching)).toBe("pause_download");
        expect(taskStopActionLabel("pause_download")).toBe("暂停下载");

        expect(isTaskActiveInPanel(retrievable)).toBe(true);
        expect(taskStopActionKind(retrievable)).toBe("stop_retrieve");
        expect(taskStopActionLabel("stop_retrieve")).toBe("停止自动取回");

        expect(isTaskActiveInPanel(stopped)).toBe(false);
        expect(taskStopActionKind(stopped)).toBeNull();

        expect(isTaskActiveInPanel(paused)).toBe(false);
        expect(taskStopActionKind(paused)).toBeNull();

        expect(isTaskActiveInPanel(ready)).toBe(false);
        expect(taskStopActionKind(ready)).toBeNull();

        expect(isTaskActiveInPanel(failed)).toBe(false);
        expect(taskStopActionKind(failed)).toBeNull();
    });

    test("nodeBadgeFromOutcome renders neutral badge for retrievable/fetching and red badge only for terminal failures", () => {
        expect(nodeBadgeFromOutcome(submissionUnknownTaskOutcome(), "error")).toEqual({
            tone: "neutral",
            label: "取回中",
            ariaLabel: "正在自动取回结果",
        });
        expect(nodeBadgeFromOutcome(submissionUnknownTaskOutcome(), "error", { stage: "recovery_stopped" })).toEqual({
            tone: "neutral",
            label: "待取回",
            ariaLabel: "结果待取回",
        });
        expect(nodeBadgeFromOutcome(deliveryPendingTaskOutcome(), "error", { stage: "delivery_paused" })).toEqual({
            tone: "neutral",
            label: "待取回",
            ariaLabel: "结果待取回",
        });
        expect(nodeBadgeFromOutcome(fetchingTaskOutcome(), "error")).toEqual({
            tone: "neutral",
            label: "取回中",
            ariaLabel: "正在取回结果",
        });
        expect(nodeBadgeFromOutcome(notChargedTaskOutcome(), "error")).toEqual({
            tone: "error",
            label: "失败",
            ariaLabel: "生成失败",
        });
        expect(nodeBadgeFromOutcome(runningTaskOutcome(), "loading")).toBeNull();
    });

    test("CanvasActiveTaskPanel counts active running, fetching, and retrievable tasks while hiding stopped/paused tasks", () => {
        const running = makeTask("t-run", { status: "running", outcome: runningTaskOutcome() });
        const fetching = makeTask("t-fetch", { status: "succeeded", stage: "正在取回结果", outcome: fetchingTaskOutcome() });
        const retrievable = makeTask("t-ret", { status: "failed", stage: "submission_unknown", outcome: submissionUnknownTaskOutcome() });
        const stopped = makeTask("t-stop", { status: "failed", stage: "recovery_stopped", outcome: submissionUnknownTaskOutcome() });
        const paused = makeTask("t-pause", { status: "succeeded", stage: "delivery_paused", outcome: deliveryPendingTaskOutcome() });
        const nodes = [running, fetching, retrievable, stopped, paused].map((task) =>
            makeNode(`node-${task.id}`, { taskId: task.id, status: "error", taskStatus: task.status, taskStage: task.stage, taskOutcome: task.outcome }),
        );

        const html = renderToStaticMarkup(
            createElement(CanvasActiveTaskPanel, {
                tasks: [running, fetching, retrievable, stopped, paused],
                nodes,
                onCancelTask: () => undefined,
                onLocateNode: () => undefined,
            }),
        );
        expect(html).toContain("3 项");

        const stoppedOnlyHtml = renderToStaticMarkup(
            createElement(CanvasActiveTaskPanel, {
                tasks: [stopped, paused],
                nodes,
                onCancelTask: () => undefined,
                onLocateNode: () => undefined,
            }),
        );
        expect(stoppedOnlyHtml).toBe("");
    });

    test("CanvasNode renders neutral badge instead of red failure badge when outcome is retrievable", () => {
        const baseProps = {
            scale: 1,
            isSelected: false,
            isRelated: false,
            isFocusRelated: false,
            isConnectionTarget: false,
            showImageInfo: false,
            onMouseDown: () => undefined,
            onHoverStart: () => undefined,
            onHoverEnd: () => undefined,
            onConnectStart: () => undefined,
            onResize: () => undefined,
            onContentChange: () => undefined,
            onContextMenu: () => undefined,
        };

        const autoRetrievingHtml = renderToStaticMarkup(
            createElement(CanvasNode, {
                ...baseProps,
                data: makeNode("n-ret", {
                    status: "error",
                    taskId: "t-ret",
                    taskStatus: "failed",
                    taskStage: "submission_unknown",
                    taskOutcome: submissionUnknownTaskOutcome(),
                }),
            }),
        );
        expect(autoRetrievingHtml).toContain('data-node-status-badge="neutral"');
        expect(autoRetrievingHtml).toContain("取回中");
        expect(autoRetrievingHtml).not.toContain('data-node-status-badge="error"');
        expect(autoRetrievingHtml).toContain('data-task-cancellable="true"');

        const stoppedHtml = renderToStaticMarkup(
            createElement(CanvasNode, {
                ...baseProps,
                data: makeNode("n-stop", {
                    status: "error",
                    taskId: "t-stop",
                    taskStatus: "failed",
                    taskStage: "recovery_stopped",
                    taskOutcome: submissionUnknownTaskOutcome(),
                }),
            }),
        );
        expect(stoppedHtml).toContain('data-node-status-badge="neutral"');
        expect(stoppedHtml).toContain("待取回");
        expect(stoppedHtml).not.toContain('data-node-status-badge="error"');
        expect(stoppedHtml).toContain('data-task-cancellable="false"');

        const failedHtml = renderToStaticMarkup(
            createElement(CanvasNode, {
                ...baseProps,
                data: makeNode("n-fail", {
                    status: "error",
                    taskId: "t-fail",
                    taskStatus: "failed",
                    taskStage: "任务失败",
                    taskOutcome: notChargedTaskOutcome(),
                }),
            }),
        );
        expect(failedHtml).toContain('data-node-status-badge="error"');
        expect(failedHtml).toContain('aria-label="生成失败"');
        expect(failedHtml).toContain('data-task-cancellable="false"');
    });

    test("CanvasProjectStatusDialogs exports cleanly with taskStopActionKind wiring", () => {
        expect(typeof CanvasProjectStatusDialogs).toBe("function");
    });
});
