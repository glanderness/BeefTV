import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { generationHistoryPreviewImageSrc } from "../src/components/canvas/canvas-generation-history-picker";
import { reuseGeneratedMediaStorageKey } from "../src/lib/canvas/canvas-generation-task-sync";
import type { GenerationTask } from "../src/services/api/task-center";

const picker = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-generation-history-picker.tsx"), "utf8");
const definitions = readFileSync(resolve(import.meta.dir, "../src/lib/canvas/tool-registry/definitions/add-node-menu-tools.tsx"), "utf8");
const project = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/project.tsx"), "utf8");
const orchestration = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/canvas-generation-orchestration.ts"), "utf8");
const orchestrationHook = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-generation-orchestration.ts"), "utf8");
const localHistory = readFileSync(resolve(import.meta.dir, "../src/lib/local-task-history.ts"), "utf8");
const taskSync = readFileSync(resolve(import.meta.dir, "../src/lib/canvas/canvas-generation-task-sync.ts"), "utf8");

describe("LibTV generation history picker", () => {
    test("queries and filters successful media generation tasks", () => {
        expect(picker).toContain('title="从生成历史选择"');
        expect(picker).toContain("listGenerationTasks");
        expect(picker).toContain('task.status === "succeeded"');
        expect(picker).toContain("Boolean(task.resultJson)");
        expect(picker).toContain("onSelect(task)");
    });

    test("is exposed from the add-node menu and applies the result to a canvas node", () => {
        expect(definitions).toContain('id: "generation-history"');
        expect(definitions).toContain("onOpenGenerationHistory");
        expect(orchestration).toContain("applyGenerationTaskResultToNodes");
        expect(project).toContain("insertGenerationHistoryTask");
        expect(localHistory).toContain("localResultJson");
        expect(localHistory).toContain("resultJson");
        expect(localHistory).toContain("storageKey");
        expect(orchestrationHook).toContain("setGenerationHistoryOpen(false)");
        expect(taskSync).toContain("reuseGeneratedMediaStorageKey");
        expect(taskSync).toContain("reuseAudioKey");
        expect(taskSync).toContain("reuseVideoKey");
        expect(taskSync).toContain("reuseImageKey");
    });

    test("persists the inserted node to the local canvas document before closing success", () => {
        const helperStart = orchestration.indexOf("export async function insertCanvasGenerationHistoryTask");
        const helper = orchestration.slice(helperStart);
        expect(helper).toContain("bindMissingCanvasResourceAssets");
        expect(helper).toContain("bindMissingCanvasResourceAssets([applied.node]");
        expect(helper).toContain("rebaseInsertedCanvasNode");
        expect(helper).toContain("readLiveNodes");
        expect(helper).toContain("canvasNodesMissingResourceAssetBinding");
        expect(helper).toContain("await input.persist(nextNodes)");
        expect(helper.indexOf("await input.persist(nextNodes)")).toBeLessThan(helper.indexOf("return { node: inserted, nextNodes }"));

        const hookStart = orchestrationHook.indexOf("const insertGenerationHistoryTask = useCallback");
        const hookEnd = orchestrationHook.indexOf("const reconcileImageBatchRootNode", hookStart);
        const insert = orchestrationHook.slice(hookStart, hookEnd);
        expect(insert).toContain("runOwnedCanvasHistoryInsert");
        expect(insert).toContain("insertingHistory.current.tryEnter()");
        expect(orchestrationHook).toContain("createInsertingHistoryGate");
        expect(insert).toContain("persistCanvasDocument(owner.canvasId, { nodes: persisted })");
        expect(insert).toContain("ensureCanvasNodeAsset");
        expect(insert).toContain("rebaseInsertedCanvasNode(current, node)");
        expect(insert.indexOf("runOwnedCanvasHistoryInsert")).toBeLessThan(insert.indexOf("setGenerationHistoryOpen(false)"));
        expect(insert.indexOf("runOwnedCanvasHistoryInsert")).toBeLessThan(insert.indexOf('message.success("已从生成历史插入到画布")'));
        expect(insert.indexOf("flushCanvasStorePersistence")).toBe(-1);
        expect(insert.indexOf("saveCanvasProject")).toBe(-1);
        expect(project).toContain("insertGenerationHistoryTask");
    });

    test("does not use audio or video file URLs as card image sources", () => {
        const audioUrl = "http://127.0.0.1:3184/api/resources/audio-owned/file";
        const audioTask = {
            id: "task-audio",
            projectId: "7vvfM674HnenwTekmj88V",
            type: "canvas_audio",
            status: "succeeded",
            prompt: "一段旁白",
            previewUrl: audioUrl,
            resultJson: JSON.stringify({ mode: "audio", audio: { dataUrl: audioUrl, url: audioUrl, storageKey: "resource:audio-owned" } }),
            attempts: 1,
            createdAt: "2026-09-24T00:00:00.000Z",
            updatedAt: "2026-09-24T00:00:00.000Z",
        } as GenerationTask;
        const videoTask = {
            ...audioTask,
            id: "task-video",
            type: "canvas_video",
            previewUrl: "http://127.0.0.1:3184/api/resources/video-owned/file",
            resultJson: JSON.stringify({ mode: "video", video: { dataUrl: "http://127.0.0.1:3184/api/resources/video-owned/file" } }),
        } as GenerationTask;
        const imageTask = {
            ...audioTask,
            id: "task-image",
            type: "canvas_image",
            previewUrl: "data:image/png;base64,abc",
            resultJson: JSON.stringify({ mode: "image", images: [{ dataUrl: "data:image/png;base64,abc" }] }),
        } as GenerationTask;

        expect(generationHistoryPreviewImageSrc(audioTask)).toBe("");
        expect(generationHistoryPreviewImageSrc(videoTask)).toBe("");
        expect(generationHistoryPreviewImageSrc(imageTask)).toBe("data:image/png;base64,abc");
        expect(reuseGeneratedMediaStorageKey(undefined, audioUrl)).toBe("resource:audio-owned");
        expect(reuseGeneratedMediaStorageKey("image:local-1", "http://127.0.0.1:3184/api/resources/video-owned/file")).toBe("image:local-1");
        expect(reuseGeneratedMediaStorageKey(undefined, "data:audio/mpeg;base64,AAA")).toBe("");
    });
});
