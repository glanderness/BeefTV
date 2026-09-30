// 第三期：时间线导出运行时。把 buildTimelineRenderPlan 产出的步骤逐步在 ffmpeg.wasm 中执行，
// 独立 worker 从同源加载 core/wasm，取消不会影响其他媒体操作。
import { getMediaBlob } from "@/services/file-storage";
import { rasterizeTimelineSubtitle } from "./timeline-subtitle-image";
import type { TimelineProject } from "@/types/timeline";
import { SUBTITLE_FILE, buildSubtitleSrt, buildTimelineRenderPlan, getExportClips, getOrderedSubtitleClips, type TimelineRenderContext, type TimelineRenderSource } from "./timeline-to-ffmpeg";

export type TimelineExportProgress = {
    phase: "loading" | "reading" | "encoding";
    percent: number;
    detail: string;
};

export type TimelineExportOptions = {
    onProgress?: (progress: TimelineExportProgress) => void;
    context?: Partial<TimelineRenderContext>;
    signal?: AbortSignal;
};

async function fetchSourceBlob(source: TimelineRenderSource, signal?: AbortSignal): Promise<Blob> {
    if (source.storageKey) {
        const stored = await getMediaBlob(source.storageKey);
        if (stored) return stored;
    }
    if (source.url) {
        const response = await fetch(source.url, { signal });
        if (!response.ok) throw new Error("视频资源请求失败（" + response.status + "）");
        return response.blob();
    }
    throw new Error("找不到素材 " + source.nodeId + " 的媒体文件");
}

/** 导出时间线为 MP4：写媒体 → 按计划逐步执行 → 返回 Blob（下载由调用方处理） */
export async function exportTimelineToMp4(timeline: TimelineProject, sources: TimelineRenderSource[], options: TimelineExportOptions = {}): Promise<Blob> {
    const { onProgress, context, signal } = options;
    signal?.throwIfAborted();
    buildTimelineRenderPlan(timeline, sources, context);
    if (!__BEEFTV_HEAVY_MEDIA_ENABLED__) throw new Error("精简版未包含 FFmpeg 本地媒体工具，请安装完整媒体包");
    onProgress?.({ phase: "loading", percent: 0, detail: "加载 FFmpeg" });
    const [{ FFmpeg }, { default: coreURL }, { default: wasmURL }, { fetchFile }] = await Promise.all([import("@ffmpeg/ffmpeg"), import("@ffmpeg/core?url"), import("@ffmpeg/core/wasm?url"), import("@ffmpeg/util")]);
    signal?.throwIfAborted();
    // Each export owns its worker: cancellation cannot interrupt video merge or another dialog.
    const ffmpeg = new FFmpeg();
    const abort = () => ffmpeg.terminate();
    signal?.addEventListener("abort", abort, { once: true });
    const writtenFiles = new Set<string>();
    const preparedSources: TimelineRenderSource[] = [];
    let subtitleFontFailure = false;
    ffmpeg.on("log", ({ message }) => {
        if (/failed to find any fallback|fontselect.*failed|Glyph .*not found|can't find selected font provider/i.test(message)) subtitleFontFailure = true;
    });

    try {
        await ffmpeg.load({ coreURL, wasmURL });
        const activeNodeIds = new Set(getExportClips(timeline).filter((clip) => clip.kind === "video" || clip.kind === "audio").map((clip) => clip.nodeId));
        for (const source of sources.filter((item) => activeNodeIds.has(item.nodeId))) {
            signal?.throwIfAborted();
            onProgress?.({ phase: "reading", percent: 5, detail: "读取素材 " + source.fileName });
            const blob = await fetchSourceBlob(source, signal);
            signal?.throwIfAborted();
            writtenFiles.add(source.fileName);
            await ffmpeg.writeFile(source.fileName, await fetchFile(blob));
            writtenFiles.add("probe.json");
            await ffmpeg.writeFile("probe.json", new Uint8Array());
            const probeCode = await ffmpeg.ffprobe(["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", source.fileName, "-o", "probe.json"]);
            // Shipped core 0.12.10 returns -1 after a successful ffprobe write. Require fresh valid metadata below.
            if (probeCode !== 0 && probeCode !== -1) throw new Error("无法解析素材：" + source.nodeId);
            const probe = JSON.parse(await ffmpeg.readFile("probe.json", "utf8") as string) as { streams?: { codec_type: string }[]; format?: { duration?: string } };
            const hasAudio = probe.streams?.some((stream) => stream.codec_type === "audio") ?? false;
            const durationMs = Number(probe.format?.duration) * 1000;
            for (const clip of getExportClips(timeline).filter((item) => item.nodeId === source.nodeId && (item.kind === "video" || item.kind === "audio"))) {
                if (!probe.streams?.some((stream) => stream.codec_type === clip.kind)) throw new Error("素材缺少所需音视频轨：" + (clip.title || clip.nodeId));
                if (!Number.isFinite(durationMs) || (clip.sourceStartMs || 0) + clip.durationMs > durationMs + 100) throw new Error("素材时长不足，请调整裁剪范围：" + (clip.title || clip.nodeId));
            }
            preparedSources.push({ ...source, hasAudio });
        }

        const subtitleImages: string[] = [];
        if (context?.burnSubtitles !== false) {
            for (const clip of getOrderedSubtitleClips(timeline).filter((clip) => clip.text?.trim())) {
                signal?.throwIfAborted();
                const name = `subtitle-${subtitleImages.length}.png`;
                const bytes = await rasterizeTimelineSubtitle(clip.text!, context?.width ?? 1920, context?.height ?? 1080);
                signal?.throwIfAborted();
                writtenFiles.add(name);
                await ffmpeg.writeFile(name, bytes);
                subtitleImages.push(name);
            }
        }
        const plan = buildTimelineRenderPlan(timeline, preparedSources, { ...context, subtitleImages });
        const executableSteps = plan.steps.filter((step) => step.kind !== "subtitle");
        let stepIndex = 0;
        for (const step of plan.steps) {
            signal?.throwIfAborted();
            if (step.kind === "subtitle") {
                const srt = buildSubtitleSrt(getOrderedSubtitleClips(timeline));
                if (srt) {
                    await ffmpeg.writeFile(SUBTITLE_FILE, new TextEncoder().encode(srt));
                    writtenFiles.add(SUBTITLE_FILE);
                }
                continue;
            }
            if (step.args.includes("concat.txt")) {
                const content = plan.concatEntries.map((file) => "file '" + file + "'").join("\n");
                await ffmpeg.writeFile("concat.txt", new TextEncoder().encode(content));
                writtenFiles.add("concat.txt");
            }
            onProgress?.({ phase: "encoding", percent: Math.round(10 + (stepIndex / Math.max(1, executableSteps.length)) * 75), detail: step.description });

            writtenFiles.add(step.output);
            const exitCode = await ffmpeg.exec(["-y", ...step.args]);
            signal?.throwIfAborted();
            if (step.kind === "burn" && (exitCode !== 0 || subtitleFontFailure)) throw new Error("字幕烧录失败或缺少所需字体，未导出无字幕成片。请使用已安装中文字幕字体的服务端渲染");
            if (exitCode !== 0) throw new Error("导出失败：" + step.description);
            stepIndex += 1;
        }

        const output = await ffmpeg.readFile(plan.finalOutput);
        signal?.throwIfAborted();
        onProgress?.({ phase: "encoding", percent: 100, detail: "导出完成" });
        return new Blob([output as BlobPart], { type: "video/mp4" });
    } catch (error) {
        signal?.throwIfAborted();
        throw error;
    } finally {
        signal?.removeEventListener("abort", abort);
        if (!signal?.aborted) await Promise.all([...writtenFiles, "concat.txt"].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
        ffmpeg.terminate();
    }
}
