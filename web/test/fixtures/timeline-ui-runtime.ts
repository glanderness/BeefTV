import type { CanonicalPlanOptions } from "../../src/lib/timeline/timeline-canonical-plan";
import type { TimelineProject } from "../../src/types/timeline";
import type { TimelineRenderSource } from "../../src/lib/timeline/timeline-to-ffmpeg";

// Fault injection at the encoder/task boundary; the mounted React handlers remain real.
export const receipt = {
    local: [] as TimelineRenderSource[][],
    remote: [] as Array<{ projectId?: string; timeline: TimelineProject; options?: CanonicalPlanOptions; clientOperationId?: string }>,
    saved: [] as TimelineProject[],
    createdResources: [] as Array<{ resourceId: string; title: string; durationMs?: number; width?: number; height?: number }>,
    downloads: 0, created: 0, aborted: 0, cancelledTasks: [] as string[],
    failLocal: () => {}, failRemote: () => {}, resolveRemote: (_resourceId?: string) => {},
};

export function exportTimelineToMp4(_project: TimelineProject, sources: TimelineRenderSource[], options: { signal?: AbortSignal }) {
    receipt.local.push(sources);
    return new Promise<Blob>((_resolve, reject) => {
        receipt.failLocal = () => reject(new Error("字幕烧录失败，未导出无字幕成片"));
        options.signal?.addEventListener("abort", () => {
            receipt.aborted++;
            reject(new DOMException("导出已取消", "AbortError"));
        }, { once: true });
    });
}
export async function compileTimelineRenderPlan(_input: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return {
        version: 1,
        output: { width: 1920, height: 1080, fps: 30, sampleRate: 44100, burnSubtitles: false },
        durationMs: 6000,
        segments: [{ kind: "video", clipId: "video", sourceId: "video", startMs: 0, durationMs: 6000, volume: 1, hasAudio: true }],
        audio: [
            { clipId: "bgm", sourceId: "bgm", startMs: 0, durationMs: 6000, sourceStartMs: 0, volume: 1 },
            { clipId: "voice", sourceId: "voice", startMs: 1000, durationMs: 2000, sourceStartMs: 0, volume: 1 },
        ],
        subtitles: [],
        subtitleSrt: "",
    };
}

export async function createTimelineRenderTask(input: { projectId?: string; timeline: TimelineProject; options?: CanonicalPlanOptions; clientOperationId?: string }) {
    receipt.remote.push(input);
    return {
        id: "render-fixture-" + receipt.remote.length,
        type: "timeline_render",
        status: "running",
        stage: "正在渲染…",
        progress: 45,
        prompt: "时间线渲染",
        attempts: 1,
        createdAt: "2026-11-28T00:00:00.000Z",
        updatedAt: "2026-11-28T00:00:00.000Z",
    };
}
export async function cancelGenerationTask(id: string) {
    receipt.cancelledTasks.push(id);
}
export async function createTimelineTranscriptionTask() {
    throw new Error("渲染界面验收不应提交转写任务");
}
export async function getTranscriptionModels() {
    return [];
}
export async function createGenerationTask() {
    throw new Error("渲染界面验收不应提交生成任务");
}
export async function findGenerationTaskByOperation() {
    return null;
}
export function waitForGenerationTask(id: string, options?: { signal?: AbortSignal; onTaskUpdate?: (task: unknown) => void }) {
    return new Promise((resolve, reject) => {
        receipt.failRemote = () => reject(new Error("服务端字幕字体缺失，渲染失败"));
        receipt.resolveRemote = (resourceId = "res-rendered-native-1") => {
            const done = {
                id,
                type: "timeline_render",
                status: "succeeded",
                stage: "渲染完成",
                progress: 100,
                resultJson: JSON.stringify({ resourceId, fileName: "timeline-render.mp4", durationMs: 6000, size: 4096 }),
                outputs: [{ outputIndex: 0, mediaType: "video", resourceId }],
            };
            options?.onTaskUpdate?.(done);
            resolve(done);
        };
        options?.signal?.addEventListener("abort", () => {
            receipt.aborted++;
            reject(new DOMException("导出已取消", "AbortError"));
        }, { once: true });
    });
}
export function saveAs() { receipt.downloads++; }
