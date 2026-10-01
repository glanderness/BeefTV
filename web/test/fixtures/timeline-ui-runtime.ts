import type { TimelineProject } from "../../src/types/timeline";
import type { TimelineRenderSource } from "../../src/lib/timeline/timeline-to-ffmpeg";

// Fault injection at the encoder/task boundary; the mounted React handlers remain real.
export const receipt = {
    local: [] as TimelineRenderSource[][], remote: [] as TimelineProject[],
    downloads: 0, created: 0, aborted: 0,
    failLocal: () => {}, failRemote: () => {},
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
export async function createTimelineRenderTask(input: { timeline: TimelineProject }) {
    receipt.remote.push(input.timeline);
    return { id: "render-fixture" };
}
export function waitForGenerationTask() {
    return new Promise((_resolve, reject) => {
        receipt.failRemote = () => reject(new Error("服务端字幕字体缺失，渲染失败"));
    });
}
export function saveAs() { receipt.downloads++; }
