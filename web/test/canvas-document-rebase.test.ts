import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { rebaseCanvasDocumentThreeWay, settleInFlightGenerationOverlay } from "../src/lib/canvas/canvas-document-rebase";
import { interruptFileUpload } from "../src/lib/canvas/canvas-file-upload";
import { isolateCopiedNodeMetadata } from "../src/lib/canvas/canvas-node-copy";
import { sameNodeSemanticData } from "../src/lib/canvas/canvas-project-domain";
import { insertCanvasResourceMentionAtSelection } from "../src/lib/canvas/canvas-text-mention";
import { canvasGenerationTaskNodes } from "../src/pages/canvas/canvas-generation-failure";
import type { GenerationTask } from "../src/services/api/task-center";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function node(id: string, title: string, metadata: CanvasNodeData["metadata"] = {}, position = { x: 0, y: 0 }): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title, position, width: 320, height: 220, metadata };
}

function project(nodes: CanvasNodeData[], revision: number, title = "画布"): CanvasProject {
    return {
        id: "c1",
        revision,
        title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes,
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
}

describe("settleInFlightGenerationOverlay", () => {
    test("settle comment matches overlay empty-string exception", () => {
        const source = readFileSync(resolve(import.meta.dir, "../src/lib/canvas/canvas-document-rebase.ts"), "utf8");
        expect(source).not.toContain("人类写过的 content（含空串）保留");
        expect(source).toContain("loading/error 上的空 content 是 overlay");
        expect(source).toContain("人类写过的非空 content 保留");
        expect(source).toContain("非 overlay 上的空串按真实编辑保留");
        expect(source).toContain("不同 taskId 不会写回旧 storageKey");
    });

    test("in-flight loading overlay adopts remote success and keeps Agent sibling nodes", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", prompt: "猫" });
        const camp = node("node-camp", "秋日旅行·露营桌", { status: "idle" }, { x: 80, y: 40 });
        const lake = node("node-lake", "秋日旅行·湖畔横移", { status: "idle" }, { x: 160, y: 40 });
        const base = project([original, camp, lake], 10);
        const local = project([
            { ...original, metadata: { taskId: "task-1", status: "loading", taskStatus: "running", taskProgress: 42, taskStage: "出图中", prompt: "猫" } },
            camp,
            lake,
        ], 10);
        const remote = project([
            { ...original, metadata: { taskId: "task-1", status: "success", taskStatus: "succeeded", taskProgress: 100, content: "https://media/gen", storageKey: "res-gen", prompt: "猫" } },
            camp,
            lake,
        ], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes.map((item) => item.id)).toEqual(["image-origin", "node-camp", "node-lake"]);
        expect(rebased.project.nodes[0]?.metadata?.status).toBe("success");
        expect(rebased.project.nodes[0]?.metadata?.content).toBe("https://media/gen");
        expect(rebased.project.nodes[1]?.title).toBe("秋日旅行·露营桌");
        expect(rebased.project.nodes[2]?.title).toBe("秋日旅行·湖畔横移");
    });

    test("same-field human content edit keeps local value and remains a recoverable conflict", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", content: "旧图" });
        const base = project([original], 10);
        const local = project([{ ...original, metadata: { taskId: "task-1", status: "loading", content: "人类改过的内容" } }], 10);
        const remote = project([{ ...original, metadata: { taskId: "task-1", status: "success", content: "https://media/gen", storageKey: "res-gen" } }], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]?.metadata?.content).toBe("人类改过的内容");
        expect(settled.nodes[0]?.metadata?.status).toBe("loading");
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(true);
        expect(rebased.project.nodes[0]?.metadata?.content).toBe("人类改过的内容");
        expect(rebased.project.nodes[0]?.metadata?.status).not.toBe("success");
    });

    test("new task deleting content adopts remote success as a normal clear of the old result", () => {
        const original = node("image-origin", "原图", { taskId: "task-old", status: "success", content: "旧图", storageKey: "old-key" });
        const base = project([original], 10);
        const local = project([{
            ...original,
            metadata: { taskId: "task-2", status: "loading", taskStatus: "running", taskProgress: 12, prompt: "猫" },
        }], 10);
        const remote = project([{
            ...original,
            metadata: { taskId: "task-2", status: "success", taskStatus: "succeeded", taskProgress: 100, content: "https://media/new", storageKey: "res-new", prompt: "猫" },
        }], 14);
        expect(Object.prototype.hasOwnProperty.call(local.nodes[0]?.metadata || {}, "content")).toBe(false);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]?.metadata?.status).toBe("success");
        expect(settled.nodes[0]?.metadata?.content).toBe("https://media/new");
        expect(settled.nodes[0]?.metadata?.storageKey).toBe("res-new");
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes[0]?.metadata?.content).toBe("https://media/new");
    });

    test("same-task in-flight empty overlay adopts remote bound success", () => {
        const original = node("node-dlu63hran9ns-43e87554d6", "秋日旅行", {
            taskId: "e24cb37f0a7d146afc8560456d88a550",
            status: "success",
            taskStatus: "succeeded",
            content: "/api/resources/8edbd8862c4714bbe42424d83e63bc08/file",
            storageKey: "resource:8edbd8862c4714bbe42424d83e63bc08",
        });
        const base = project([original], 34);
        const local = project([{ ...original, metadata: { ...original.metadata, status: "loading", content: "", storageKey: undefined, assetId: undefined } }], 34);
        const remote = project([original], 34);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]?.metadata?.status).toBe("success");
        expect(settled.nodes[0]?.metadata?.content).toBe("/api/resources/8edbd8862c4714bbe42424d83e63bc08/file");
        expect(settled.nodes[0]?.metadata?.storageKey).toBe("resource:8edbd8862c4714bbe42424d83e63bc08");
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes[0]?.metadata?.status).toBe("success");
        expect(rebased.project.nodes[0]?.metadata?.storageKey).toBe("resource:8edbd8862c4714bbe42424d83e63bc08");
    });

    test("in-flight nonempty human content still wins over remote success", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", content: "旧图", storageKey: "old-key" });
        const base = project([original], 10);
        const local = project([{ ...original, metadata: { taskId: "task-1", status: "loading", content: "人类改过的内容" } }], 10);
        const remote = project([{ ...original, metadata: { taskId: "task-1", status: "success", content: "https://media/gen", storageKey: "res-gen" } }], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]?.metadata?.content).toBe("人类改过的内容");
        expect(settled.nodes[0]?.metadata?.status).toBe("loading");
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(true);
        expect(rebased.project.nodes[0]?.metadata?.content).toBe("人类改过的内容");
    });

    test("baseline empty content on first generation is not treated as a human clear", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", content: "" });
        const base = project([original], 10);
        const local = project([{ ...original, metadata: { taskId: "task-1", status: "loading", content: "", taskStatus: "running" } }], 10);
        const remote = project([{ ...original, metadata: { taskId: "task-1", status: "success", content: "https://media/gen", storageKey: "res-gen" } }], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]?.metadata?.status).toBe("success");
        expect(settled.nodes[0]?.metadata?.content).toBe("https://media/gen");
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(false);
    });

    test("remote taskStatus succeeded without bound media is not authoritative completion", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", content: "旧图" });
        const base = project([original], 10);
        const local = project([{
            ...original,
            metadata: { taskId: "task-1", status: "loading", content: "https://local-kept", storageKey: "local-key", taskStatus: "running" },
        }], 10);
        const remote = project([{
            ...original,
            metadata: { taskId: "task-1", status: "loading", taskStatus: "succeeded", taskProgress: 100, content: "" },
        }], 21);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]).toBe(local.nodes[0]);
        expect(settled.nodes[0]?.metadata?.status).toBe("loading");
        expect(settled.nodes[0]?.metadata?.content).toBe("https://local-kept");
        expect(settled.nodes[0]?.metadata?.storageKey).toBe("local-key");
        expect(settled.nodes[0]?.metadata?.taskStatus).toBe("running");
    });

    test("remote success without media result does not clear local media fields", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", content: "旧图" });
        const base = project([original], 10);
        const local = project([{
            ...original,
            metadata: { taskId: "task-1", status: "error", content: "https://local-kept", storageKey: "local-key", errorDetails: "画布已在别处更新" },
        }], 10);
        const remote = project([{
            ...original,
            metadata: { taskId: "task-1", status: "success", taskStatus: "succeeded", content: "" },
        }], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]).toBe(local.nodes[0]);
        expect(settled.nodes[0]?.metadata?.content).toBe("https://local-kept");
        expect(settled.nodes[0]?.metadata?.storageKey).toBe("local-key");
        expect(settled.nodes[0]?.metadata?.status).toBe("error");
    });

    test("idle or human non-overlay status is not overwritten by remote bound success", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", content: "旧图" });
        const base = project([original], 10);
        const idleLocal = project([{ ...original, metadata: { taskId: "task-1", status: "idle", content: "旧图", prompt: "人类改了提示" } }], 10);
        const successLocal = project([{ ...original, metadata: { taskId: "task-1", status: "success", content: "人类留下的图" } }], 10);
        const remote = project([{ ...original, metadata: { taskId: "task-1", status: "success", content: "https://media/gen", storageKey: "res-gen" } }], 14);
        const settledIdle = settleInFlightGenerationOverlay({ base, local: idleLocal, remote });
        const settledSuccess = settleInFlightGenerationOverlay({ base, local: successLocal, remote });
        expect(settledIdle.nodes[0]).toBe(idleLocal.nodes[0]);
        expect(settledIdle.nodes[0]?.metadata?.status).toBe("idle");
        expect(settledIdle.nodes[0]?.metadata?.content).toBe("旧图");
        expect(settledIdle.nodes[0]?.metadata?.prompt).toBe("人类改了提示");
        expect(settledSuccess.nodes[0]).toBe(successLocal.nodes[0]);
        expect(settledSuccess.nodes[0]?.metadata?.content).toBe("人类留下的图");
    });

    test("error overlay of the same in-flight task adopts remote bound success", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", prompt: "猫" });
        const base = project([original], 10);
        const local = project([{
            ...original,
            metadata: {
                taskId: "task-1",
                status: "error",
                generationErrorCode: "canvas_conflict",
                errorDetails: "云端画布已有更新，已停止覆盖；请保留本地草稿并加载最新版本",
                prompt: "猫",
            },
        }], 10);
        const remote = project([{
            ...original,
            metadata: { taskId: "task-1", status: "success", taskStatus: "succeeded", content: "https://media/gen", storageKey: "res-gen", prompt: "猫" },
        }], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]?.metadata?.status).toBe("success");
        expect(settled.nodes[0]?.metadata?.content).toBe("https://media/gen");
        expect(settled.nodes[0]?.metadata?.errorDetails).toBeUndefined();
        expect(settled.nodes[0]?.metadata?.generationErrorCode).toBeUndefined();
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(false);
    });

    test("new-task overlay does not adopt a different remote task's bound success", () => {
        const original = node("node-dlu63hran9ns-43e87554d6", "秋日旅行", {
            taskId: "e24cb37f0a7d146afc8560456d88a550",
            status: "success",
            taskStatus: "succeeded",
            content: "/api/resources/8edbd8862c4714bbe42424d83e63bc08/file",
            storageKey: "resource:8edbd8862c4714bbe42424d83e63bc08",
        });
        const base = project([original], 34);
        const local = project([{
            ...original,
            metadata: { taskId: "task-new", status: "loading", taskStatus: "running", prompt: "新提示" },
        }], 34);
        const remote = project([original], 34);
        expect(Object.prototype.hasOwnProperty.call(local.nodes[0]?.metadata || {}, "content")).toBe(false);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]).toBe(local.nodes[0]);
        expect(settled.nodes[0]?.metadata?.taskId).toBe("task-new");
        expect(settled.nodes[0]?.metadata?.status).toBe("loading");
        expect(settled.nodes[0]?.metadata?.storageKey).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(settled.nodes[0]?.metadata || {}, "content")).toBe(false);
    });

    test("real human empty-string clear on non-overlay is not settled as overlay", () => {
        const original = node("image-origin", "原图", {
            taskId: "task-1",
            status: "success",
            content: "旧图",
            storageKey: "old-key",
        });
        const base = project([original], 10);
        const local = project([{ ...original, metadata: { ...original.metadata, content: "" } }], 10);
        const remote = project([original], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]).toBe(local.nodes[0]);
        expect(settled.nodes[0]?.metadata?.status).toBe("success");
        expect(settled.nodes[0]?.metadata?.content).toBe("");
        expect(settled.nodes[0]?.metadata?.storageKey).toBe("old-key");
    });

    test("settled overlay and stale running bound node both resolve taskOutcome to ready", () => {
        const inFlightOutcome = { phase: "running" as const, regenerate: "blocked" as const, reason: "in_flight" };
        const original = node("image-origin", "原图", {
            taskId: "task-1",
            status: "loading",
            taskStatus: "running",
            taskOutcome: inFlightOutcome,
        });
        const remoteBoundWithoutOutcome = project([
            node("image-origin", "原图", {
                taskId: "task-1",
                status: "success",
                taskStatus: "succeeded",
                taskProgress: 100,
                content: "/api/resources/res-1/file",
                storageKey: "resource:res-1",
                assetId: "asset-1",
            }),
        ], 12);
        const settledFromLoading = settleInFlightGenerationOverlay({
            base: project([original], 10),
            local: project([original], 10),
            remote: remoteBoundWithoutOutcome,
        });
        expect(settledFromLoading.nodes[0]?.metadata?.taskOutcome).toEqual({
            phase: "ready",
            regenerate: "allowed",
            reason: "result_ready",
        });

        const staleBoundLocal = project([
            node("image-origin", "原图", {
                taskId: "task-1",
                status: "success",
                taskStatus: "succeeded",
                taskProgress: 100,
                content: "/api/resources/res-1/file",
                storageKey: "resource:res-1",
                assetId: "asset-1",
                taskOutcome: inFlightOutcome,
            }),
        ], 12);
        const settledFromStaleSuccess = settleInFlightGenerationOverlay({
            base: remoteBoundWithoutOutcome,
            local: staleBoundLocal,
            remote: remoteBoundWithoutOutcome,
        });
        expect(settledFromStaleSuccess.nodes[0]?.metadata?.taskOutcome).toEqual({
            phase: "ready",
            regenerate: "allowed",
            reason: "result_ready",
        });
    });
});

describe("rebaseCanvasDocumentThreeWay node timestamps", () => {
    const stamp = (item: CanvasNodeData): CanvasNodeData => ({ ...item, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" });

    test("remote delete drops a node whose local copy only gained createdAt/updatedAt", () => {
        const assistant = node("a1", "助手文本");
        const kept = node("k1", "保留");
        const result = rebaseCanvasDocumentThreeWay({
            base: project([assistant, kept], 7),
            local: project([stamp(assistant), kept], 7),
            remote: project([kept], 8),
        });
        expect(result.conflict).toBe(false);
        expect(result.project.nodes.map((item) => item.id)).toEqual(["k1"]);
    });

    test("remote delete of a locally retitled node is still a conflict and keeps the local node", () => {
        const assistant = node("a1", "助手文本");
        const result = rebaseCanvasDocumentThreeWay({
            base: project([assistant], 7),
            local: project([{ ...stamp(assistant), title: "本地改过的标题" }], 7),
            remote: project([], 8),
        });
        expect(result.conflict).toBe(true);
        expect(result.project.nodes.map((item) => item.title)).toEqual(["本地改过的标题"]);
    });

    test("node-level updatedAt differences and backend null-cleared bind fields do not cause false conflicts", () => {
        const baseNode: CanvasNodeData = {
            ...node("v1", "分镜视频", {
                taskId: "task-1",
                status: "loading",
                taskStatus: "running",
                taskStage: "generating",
                errorDetails: "旧错误",
            }),
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        };
        const localNode: CanvasNodeData = {
            ...baseNode,
            updatedAt: "2026-01-01T00:00:05.000Z",
            metadata: {
                ...baseNode.metadata,
                taskProgress: 35,
                taskUpdatedAt: "2026-01-01T00:00:05.000Z",
            },
        };
        const remoteNode: CanvasNodeData = {
            ...baseNode,
            updatedAt: "2026-01-01T00:00:09.000Z",
            metadata: {
                taskId: "task-1",
                status: "success",
                taskStatus: "succeeded",
                taskProgress: 100,
                content: "/api/resources/res-v1/file",
                storageKey: "resource:res-v1",
                assetId: "asset-v1",
                taskStage: null as unknown as undefined,
                errorDetails: null as unknown as undefined,
            },
        };
        const base = project([baseNode], 10);
        const local = project([localNode], 10);
        const remote = project([remoteNode], 11);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes[0]?.metadata?.status).toBe("success");
        expect(rebased.project.nodes[0]?.metadata?.taskStage).toBeUndefined();
        expect(rebased.project.nodes[0]?.metadata?.errorDetails).toBeUndefined();
    });

    test("same-task in-flight polling telemetry differences do not trigger rebase conflict", () => {
        const baseNode = node("v1", "分镜视频", {
            taskId: "task-running",
            status: "loading",
            taskStatus: "running",
            taskProgress: 10,
            taskStage: "queued",
            taskUpdatedAt: "2026-01-01T00:00:01.000Z",
        });
        const localNode = {
            ...baseNode,
            updatedAt: "2026-01-01T00:00:04.000Z",
            metadata: {
                ...baseNode.metadata,
                taskProgress: 45,
                taskStage: "rendering",
                taskUpdatedAt: "2026-01-01T00:00:04.000Z",
            },
        };
        const remoteNode = {
            ...baseNode,
            updatedAt: "2026-01-01T00:00:02.000Z",
            metadata: {
                ...baseNode.metadata,
                taskProgress: 20,
                taskStage: "rendering",
                taskUpdatedAt: "2026-01-01T00:00:02.000Z",
            },
        };
        const rebased = rebaseCanvasDocumentThreeWay({
            base: project([baseNode], 10),
            local: project([localNode], 10),
            remote: project([remoteNode], 11),
        });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes[0]?.metadata?.taskProgress).toBe(45);
    });

    test("canvasGenerationTaskNodes preserves array reference when running poll only changes updatedAt", () => {
        const initialTask: GenerationTask = {
            id: "task-poll-1",
            type: "canvas_video",
            status: "running",
            stage: "generating",
            progress: 30,
            prompt: "镜头1",
            attempts: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:02.000Z",
        };
        const boundNodes = canvasGenerationTaskNodes([node("v1", "镜头1")], "v1", initialTask);
        const pollTickNodes = canvasGenerationTaskNodes(boundNodes, "v1", {
            ...initialTask,
            updatedAt: "2026-01-01T00:00:04.000Z",
            durationMs: 4000,
        });
        expect(pollTickNodes).toBe(boundNodes);

        const progressedNodes = canvasGenerationTaskNodes(boundNodes, "v1", {
            ...initialTask,
            progress: 60,
            updatedAt: "2026-01-01T00:00:06.000Z",
        });
        expect(progressedNodes).not.toBe(boundNodes);
        expect(progressedNodes[0]?.metadata?.taskProgress).toBe(60);
    });

    test("task failure transition and subsequent retry submission do not trigger false rebase conflict", () => {
        const baseNode = node("v1", "分镜视频", {
            taskId: "task-1",
            status: "loading",
            taskStatus: "running",
            taskProgress: 20,
            taskUpdatedAt: "2026-01-01T00:00:02.000Z",
            prompt: "让主角转身",
        });
        const failedRemoteNode = node("v1", "分镜视频", {
            taskId: "task-1",
            status: "error",
            taskStatus: "failed",
            errorDetails: "上游请求超时",
            generationErrorCode: "timeout",
            taskOutcome: { phase: "failed", regenerate: "confirm", reason: "outcome_unknown" },
            taskUpdatedAt: "2026-01-01T00:00:08.000Z",
            prompt: "让主角转身",
        });
        const resubmittedLocalNode = node("v1", "分镜视频", {
            taskId: "task-2",
            status: "loading",
            taskStatus: "running",
            taskProgress: 5,
            taskUpdatedAt: "2026-01-01T00:00:12.000Z",
            prompt: "让主角转身微笑",
        });
        const rebased = rebaseCanvasDocumentThreeWay({
            base: project([baseNode], 10),
            local: project([resubmittedLocalNode], 10),
            remote: project([failedRemoteNode], 11),
        });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes[0]?.metadata?.status).toBe("loading");
        expect(rebased.project.nodes[0]?.metadata?.taskId).toBe("task-2");
        expect(rebased.project.nodes[0]?.metadata?.errorDetails).toBeUndefined();
        expect(rebased.project.nodes[0]?.metadata?.prompt).toBe("让主角转身微笑");
    });

    test("insertCanvasResourceMentionAtSelection inserts token at cursor offset instead of always appending", () => {
        const ref = { id: "ref-1", nodeId: "img-1", kind: "image" as const, label: "图片1", title: "角色图", active: true };
        const middle = insertCanvasResourceMentionAtSelection("让主角走到门前，然后转身", ref, { start: 1, end: 1 });
        expect(middle.prompt).toBe("让@[node:img-1] 主角走到门前，然后转身");
        expect(middle.cursor).toBe("让@[node:img-1] ".length);

        const tail = insertCanvasResourceMentionAtSelection("让主角走到门前", ref, null);
        expect(tail.prompt).toBe("让主角走到门前 @[node:img-1] ");
    });

    test("sameNodeSemanticData ignores in-flight poll telemetry keys and isolateCopiedNodeMetadata strips generatedFromNodeId", () => {
        const n1 = node("v1", "视频", { status: "loading", taskId: "t1", taskProgress: 10, taskUpdatedAt: "t1" });
        const n2 = node("v1", "视频", { status: "loading", taskId: "t1", taskProgress: 65, taskUpdatedAt: "t2", taskStage: "rendering" });
        expect(sameNodeSemanticData(n1, n2)).toBe(true);

        const copiedMeta = isolateCopiedNodeMetadata(
            node("v2", "视频副本", {
                content: "/api/resources/r1/file",
                generatedFromNodeId: "img-origin",
                generationFailure: { category: "request_failed", retryable: true, summary: "err", detail: "err" } as never,
                taskOutcomeSource: "synthetic",
            }),
            new Map(),
        );
        expect(copiedMeta.generatedFromNodeId).toBeUndefined();
        expect(copiedMeta.generationFailure).toBeUndefined();
        expect(copiedMeta.taskOutcomeSource).toBeUndefined();
    });

    test("completed upload is not rolled back to uploading when store or remote snapshot holds an earlier placeholder", () => {
        const remoteUploadingImg = node("upload-img-1", "ref.png", {
            fileUpload: "uploading",
            fileUploadProgress: 60,
            bytes: 2048,
            mimeType: "image/png",
        });
        const localCompletedImg = node("upload-img-1", "ref.png", {
            content: "https://example.test/ref.png",
            storageKey: "resource:ref-1",
            status: "success",
            bytes: 2048,
            mimeType: "image/png",
        });
        const remoteUploadingVid: CanvasNodeData = {
            id: "upload-vid-1",
            type: CanvasNodeType.Video,
            title: "clip.mp4",
            position: { x: 100, y: 100 },
            width: 320,
            height: 180,
            metadata: { fileUpload: "uploading", bytes: 9000, mimeType: "video/mp4" },
        };
        const localCompletedVid: CanvasNodeData = {
            ...remoteUploadingVid,
            position: { x: 100, y: -94 },
            width: 320,
            height: 568,
            metadata: {
                content: "https://example.test/clip.mp4",
                storageKey: "resource:clip-1",
                status: "success",
                naturalWidth: 1080,
                naturalHeight: 1920,
                bytes: 9000,
                mimeType: "video/mp4",
            },
        };
        const runningVideo = node("gen-v1", "生成视频", {
            taskId: "task-v1",
            status: "loading",
            taskStatus: "running",
            taskStage: "正在查询视频生成结果",
        });

        const fromEmptyBase = rebaseCanvasDocumentThreeWay({
            base: project([runningVideo], 10),
            local: project([runningVideo, localCompletedImg, localCompletedVid], 10),
            remote: project([runningVideo, remoteUploadingImg, remoteUploadingVid], 11),
        });
        expect(fromEmptyBase.conflict).toBe(false);
        const mergedImg = fromEmptyBase.project.nodes.find((item) => item.id === "upload-img-1");
        expect(mergedImg?.metadata?.fileUpload).toBeUndefined();
        expect(mergedImg?.metadata?.fileUploadProgress).toBeUndefined();
        expect(mergedImg?.metadata?.status).toBe("success");
        expect(mergedImg?.metadata?.content).toBe("https://example.test/ref.png");
        const mergedVid = fromEmptyBase.project.nodes.find((item) => item.id === "upload-vid-1");
        expect(mergedVid?.height).toBe(568);
        expect(mergedVid?.metadata?.fileUpload).toBeUndefined();
        expect(mergedVid?.metadata?.status).toBe("success");

        const fromUploadingBase = rebaseCanvasDocumentThreeWay({
            base: project([{ ...remoteUploadingImg, metadata: { ...remoteUploadingImg.metadata, fileUploadProgress: 20 } }], 10),
            local: project([localCompletedImg], 10),
            remote: project([{ ...remoteUploadingImg, metadata: { ...remoteUploadingImg.metadata, fileUploadProgress: 85 } }], 11),
        });
        expect(fromUploadingBase.conflict).toBe(false);
        expect(fromUploadingBase.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(fromUploadingBase.project.nodes[0]?.metadata?.fileUploadProgress).toBeUndefined();
        expect(fromUploadingBase.project.nodes[0]?.metadata?.status).toBe("success");
    });

    test("remote upload completion settles local placeholder while active local replacement upload stays uploading", () => {
        const baseUploading = node("up-remote", "remote.png", { fileUpload: "uploading", fileUploadProgress: 10 }, { x: 10, y: 20 });
        const localDraggedUploading = { ...baseUploading, position: { x: 120, y: 240 }, metadata: { fileUpload: "uploading" as const, fileUploadProgress: 40 } };
        const remoteSettled = node("up-remote", "remote.png", {
            content: "https://example.test/remote.png",
            storageKey: "resource:remote",
            status: "success",
        }, { x: 10, y: 20 });

        const remoteFinished = rebaseCanvasDocumentThreeWay({
            base: project([baseUploading], 10),
            local: project([localDraggedUploading], 10),
            remote: project([remoteSettled], 11),
        });
        expect(remoteFinished.conflict).toBe(false);
        expect(remoteFinished.project.nodes[0]?.position).toEqual({ x: 120, y: 240 });
        expect(remoteFinished.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(remoteFinished.project.nodes[0]?.metadata?.content).toBe("https://example.test/remote.png");

        const existingImage = node("replace-1", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: "success",
        });
        const localReplacing = node("replace-1", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: undefined,
            fileUpload: "uploading",
            fileUploadProgress: 35,
        });
        const replacingRebase = rebaseCanvasDocumentThreeWay({
            base: project([existingImage], 10),
            local: project([localReplacing], 10),
            remote: project([existingImage, node("other", "新增文本", { content: "hi" })], 11),
        });
        expect(replacingRebase.conflict).toBe(false);
        expect(replacingRebase.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");
        expect(replacingRebase.project.nodes[0]?.metadata?.fileUploadProgress).toBe(35);
        expect(replacingRebase.project.nodes[0]?.metadata?.status).toBeUndefined();
    });

    test("stale uploading flag on a distinct settled remote media preserves true conflict instead of treating remote as placeholder", () => {
        const baseNode = node("n-conflict", "img.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: "success",
        });
        const localNode = node("n-conflict", "img.png", {
            content: "https://example.test/local-new.png",
            storageKey: "resource:local-new",
            status: "success",
        });
        const remoteCorruptedDifferent = node("n-conflict", "img.png", {
            content: "https://example.test/remote-new.png",
            storageKey: "resource:remote-new",
            status: "success",
            fileUpload: "uploading",
            fileUploadProgress: 100,
        });

        const differentResult = rebaseCanvasDocumentThreeWay({
            base: project([baseNode], 10),
            local: project([localNode], 10),
            remote: project([remoteCorruptedDifferent], 11),
        });
        expect(differentResult.conflict).toBe(true);
        expect(differentResult.project.nodes[0]?.metadata?.content).toBe("https://example.test/local-new.png");
        expect(differentResult.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();

        const remoteCorruptedSame = node("n-conflict", "img.png", {
            content: "https://example.test/local-new.png",
            storageKey: "resource:local-new",
            status: "success",
            fileUpload: "uploading",
            fileUploadProgress: 100,
        });
        const sameResult = rebaseCanvasDocumentThreeWay({
            base: project([baseNode], 10),
            local: project([localNode], 10),
            remote: project([remoteCorruptedSame], 11),
        });
        expect(sameResult.conflict).toBe(false);
        expect(sameResult.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
    });

    test("upload settlement preserves concurrent non-upload edits and dragged video position in both directions", () => {
        const baseVid: CanvasNodeData = {
            id: "vid-edit",
            type: CanvasNodeType.Video,
            title: "clip.mp4",
            position: { x: 100, y: 100 },
            width: 720,
            height: 405,
            metadata: { fileUpload: "uploading", fileUploadProgress: 15, bytes: 9000, mimeType: "video/mp4" },
        };
        const settledVidAutoCentered: CanvasNodeData = {
            ...baseVid,
            position: { x: 250, y: -70.5 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/clip.mp4",
                storageKey: "resource:clip",
                status: "success",
                naturalWidth: 1080,
                naturalHeight: 1920,
                bytes: 9000,
                mimeType: "video/mp4",
            },
        };
        const uploadingEditedAndDragged: CanvasNodeData = {
            ...baseVid,
            title: "主角特写",
            position: { x: 400, y: 300 },
            metadata: {
                ...baseVid.metadata,
                fileUploadProgress: 50,
                prompt: "慢镜头备注",
                locked: true,
            },
        };

        const localUploadingRebase = rebaseCanvasDocumentThreeWay({
            base: project([baseVid], 10),
            local: project([uploadingEditedAndDragged], 10),
            remote: project([settledVidAutoCentered], 11),
        });
        expect(localUploadingRebase.conflict).toBe(false);
        const mergedLocal = localUploadingRebase.project.nodes[0]!;
        expect(mergedLocal.title).toBe("主角特写");
        expect(mergedLocal.width).toBe(420);
        expect(mergedLocal.height).toBe(746);
        expect(mergedLocal.position).toEqual({ x: 550, y: 129.5 });
        expect(mergedLocal.metadata?.fileUpload).toBeUndefined();
        expect(mergedLocal.metadata?.status).toBe("success");
        expect(mergedLocal.metadata?.prompt).toBe("慢镜头备注");
        expect(mergedLocal.metadata?.locked).toBe(true);

        const remoteUploadingRebase = rebaseCanvasDocumentThreeWay({
            base: project([baseVid], 10),
            local: project([settledVidAutoCentered], 10),
            remote: project([uploadingEditedAndDragged], 11),
        });
        expect(remoteUploadingRebase.conflict).toBe(false);
        const mergedRemote = remoteUploadingRebase.project.nodes[0]!;
        expect(mergedRemote.title).toBe("主角特写");
        expect(mergedRemote.width).toBe(420);
        expect(mergedRemote.height).toBe(746);
        expect(mergedRemote.position).toEqual({ x: 550, y: 129.5 });
        expect(mergedRemote.metadata?.fileUpload).toBeUndefined();
        expect(mergedRemote.metadata?.prompt).toBe("慢镜头备注");
        expect(mergedRemote.metadata?.locked).toBe(true);
    });

    test("concurrent uploading placeholders with different fileUploadProgress do not trigger false rebase conflict", () => {
        const baseSettled = node("up-prog", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: "success",
        });
        const localUploading = node("up-prog", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: undefined,
            fileUpload: "uploading",
            fileUploadProgress: 35,
        });
        const remoteUploading = node("up-prog", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: undefined,
            fileUpload: "uploading",
            fileUploadProgress: 60,
        });

        const rebased = rebaseCanvasDocumentThreeWay({
            base: project([baseSettled], 10),
            local: project([localUploading], 10),
            remote: project([remoteUploading], 11),
        });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");
        expect(rebased.project.nodes[0]?.metadata?.fileUploadProgress).toBe(35);
    });

    test("settled base is not wiped or rolled back when the other snapshot still holds a bare initial-upload placeholder", () => {
        const baseCompleted = node("done-1", "角色定稿", {
            content: "https://example.test/done.png",
            storageKey: "resource:done",
            status: "success",
            prompt: "服装细节说明",
            locked: true,
        }, { x: 360, y: 180 });
        const staleBarePlaceholder = node("done-1", "raw_upload.png", {
            fileUpload: "uploading",
            fileUploadProgress: 45,
            bytes: 4096,
            mimeType: "image/png",
        }, { x: 100, y: 100 });
        const settledWithFollowupEdit = {
            ...baseCompleted,
            title: "角色定稿 v2",
            metadata: { ...baseCompleted.metadata, prompt: "服装与光影说明" },
        };

        const remoteStale = rebaseCanvasDocumentThreeWay({
            base: project([baseCompleted], 10),
            local: project([settledWithFollowupEdit], 10),
            remote: project([staleBarePlaceholder], 11),
        });
        expect(remoteStale.conflict).toBe(false);
        expect(remoteStale.project.nodes[0]?.title).toBe("角色定稿 v2");
        expect(remoteStale.project.nodes[0]?.position).toEqual({ x: 360, y: 180 });
        expect(remoteStale.project.nodes[0]?.metadata?.content).toBe("https://example.test/done.png");
        expect(remoteStale.project.nodes[0]?.metadata?.storageKey).toBe("resource:done");
        expect(remoteStale.project.nodes[0]?.metadata?.status).toBe("success");
        expect(remoteStale.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(remoteStale.project.nodes[0]?.metadata?.prompt).toBe("服装与光影说明");
        expect(remoteStale.project.nodes[0]?.metadata?.locked).toBe(true);

        const localStale = rebaseCanvasDocumentThreeWay({
            base: project([baseCompleted], 10),
            local: project([staleBarePlaceholder], 10),
            remote: project([settledWithFollowupEdit], 11),
        });
        expect(localStale.conflict).toBe(false);
        expect(localStale.project.nodes[0]?.title).toBe("角色定稿 v2");
        expect(localStale.project.nodes[0]?.position).toEqual({ x: 360, y: 180 });
        expect(localStale.project.nodes[0]?.metadata?.content).toBe("https://example.test/done.png");
        expect(localStale.project.nodes[0]?.metadata?.storageKey).toBe("resource:done");
        expect(localStale.project.nodes[0]?.metadata?.status).toBe("success");
        expect(localStale.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(localStale.project.nodes[0]?.metadata?.prompt).toBe("服装与光影说明");
        expect(localStale.project.nodes[0]?.metadata?.locked).toBe(true);
    });

    test("portrait video replacement and missing-base upload rename settle cleanly without geometry or metadata loss", () => {
        const basePortraitVid: CanvasNodeData = {
            id: "vid-replace",
            type: CanvasNodeType.Video,
            title: "镜头一",
            position: { x: 250, y: -70.5 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/old.mp4",
                storageKey: "resource:old-vid",
                status: "success",
                taskId: "task-old",
                prompt: "人物转身",
                locked: true,
                naturalWidth: 1080,
                naturalHeight: 1920,
            },
        };
        const replacingVidPlaceholder: CanvasNodeData = {
            ...basePortraitVid,
            width: 720,
            height: 405,
            metadata: {
                content: "https://example.test/old.mp4",
                storageKey: "resource:old-vid",
                status: undefined,
                fileUpload: "uploading",
                fileUploadProgress: 70,
            },
        };
        const settledReplacementVid: CanvasNodeData = {
            ...basePortraitVid,
            position: { x: 400, y: -241 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/new.mp4",
                storageKey: "resource:new-vid",
                status: "success",
                prompt: "人物转身",
                locked: true,
                naturalWidth: 1080,
                naturalHeight: 1920,
            },
        };

        const replacedOverRemotePlaceholder = rebaseCanvasDocumentThreeWay({
            base: project([basePortraitVid], 10),
            local: project([settledReplacementVid], 10),
            remote: project([replacingVidPlaceholder], 11),
        });
        expect(replacedOverRemotePlaceholder.conflict).toBe(false);
        const mergedVid = replacedOverRemotePlaceholder.project.nodes[0]!;
        expect(mergedVid.width).toBe(420);
        expect(mergedVid.height).toBe(746);
        expect(mergedVid.position).toEqual({ x: 400, y: -241 });
        expect(mergedVid.metadata?.content).toBe("https://example.test/new.mp4");
        expect(mergedVid.metadata?.status).toBe("success");
        expect(mergedVid.metadata?.fileUpload).toBeUndefined();
        expect(mergedVid.metadata?.taskId).toBeUndefined();
        expect(mergedVid.metadata?.prompt).toBe("人物转身");
        expect(mergedVid.metadata?.locked).toBe(true);

        const replacedOverAncientBarePlaceholder = rebaseCanvasDocumentThreeWay({
            base: project([basePortraitVid], 10),
            local: project([settledReplacementVid], 10),
            remote: project([{
                id: "vid-replace",
                type: CanvasNodeType.Video,
                title: "raw.mp4",
                position: { x: 0, y: 0 },
                width: 720,
                height: 405,
                metadata: { fileUpload: "uploading", bytes: 9000, mimeType: "video/mp4" },
            }], 11),
        });
        expect(replacedOverAncientBarePlaceholder.conflict).toBe(false);
        expect(replacedOverAncientBarePlaceholder.project.nodes[0]?.position).toEqual({ x: 400, y: -241 });
        expect(replacedOverAncientBarePlaceholder.project.nodes[0]?.title).toBe("镜头一");
        expect(replacedOverAncientBarePlaceholder.project.nodes[0]?.metadata?.prompt).toBe("人物转身");
        expect(replacedOverAncientBarePlaceholder.project.nodes[0]?.metadata?.locked).toBe(true);

        const renamedSettledLocal = node("new-up", "主角设定", {
            content: "https://example.test/hero.png",
            storageKey: "resource:hero",
            status: "success",
        });
        const rawUploadingRemote = node("new-up", "raw_123.png", {
            fileUpload: "uploading",
            fileUploadProgress: 50,
        });
        const newUploadRenamed = rebaseCanvasDocumentThreeWay({
            base: project([], 10),
            local: project([renamedSettledLocal], 10),
            remote: project([rawUploadingRemote], 11),
        });
        expect(newUploadRenamed.conflict).toBe(false);
        expect(newUploadRenamed.project.nodes[0]?.title).toBe("主角设定");
        expect(newUploadRenamed.project.nodes[0]?.metadata?.status).toBe("success");
        expect(newUploadRenamed.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
    });

    test("deleting a settled upload node does not false-conflict against stale fileUpload flags", () => {
        const baseSettled = node("del-1", "img.png", {
            content: "https://example.test/img.png",
            storageKey: "resource:img",
            status: "success",
        });
        const staleUploading = {
            ...baseSettled,
            metadata: { ...baseSettled.metadata, fileUpload: "uploading" as const, fileUploadProgress: 100 },
        };
        const interruptedSample = interruptFileUpload(node("del-1", "img.png", { fileUpload: "uploading" }));
        const staleInterrupted = {
            ...baseSettled,
            metadata: {
                ...baseSettled.metadata,
                fileUpload: interruptedSample.metadata?.fileUpload,
                errorDetails: interruptedSample.metadata?.errorDetails,
            },
        };

        const localDeleteAgainstUploading = rebaseCanvasDocumentThreeWay({
            base: project([baseSettled], 10),
            local: project([], 10),
            remote: project([staleUploading], 11),
        });
        expect(localDeleteAgainstUploading.conflict).toBe(false);
        expect(localDeleteAgainstUploading.project.nodes).toHaveLength(0);

        const remoteDeleteAgainstInterrupted = rebaseCanvasDocumentThreeWay({
            base: project([baseSettled], 10),
            local: project([staleInterrupted], 10),
            remote: project([], 11),
        });
        expect(remoteDeleteAgainstInterrupted.conflict).toBe(false);
        expect(remoteDeleteAgainstInterrupted.project.nodes).toHaveLength(0);
    });
});
