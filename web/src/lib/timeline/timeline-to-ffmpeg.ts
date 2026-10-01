// 第三期：时间线 → FFmpeg 命令序列的纯函数规划层。
// 不直接调用 FFmpeg，只产出可执行的参数计划，方便单测与运行时逐步执行；
// 运行时负责把媒体源写入 ffmpeg 工作区、写 SRT、执行 args 并清理文件。
// 数据流：TimelineProject + 节点媒体 → trim（按 sourceStart/sourceDuration 裁切）→ 黑场补齐空隙 → concat → 字幕 SRT → 烧录。

import type { TimelineClip, TimelineProject } from "@/types/timeline";

export type TimelineRenderSource = {
    nodeId: string;
    /** 已写入 ffmpeg 工作区的文件名（如 input-0.mp4） */
    fileName: string;
    durationMs: number;
    hasAudio?: boolean;
    /** 媒体定位（运行时用）：本地缓存 storageKey 或远程资源地址，至少提供一个 */
    storageKey?: string;
    url?: string;
};

export type TimelineRenderStep = {
    kind: "trim" | "gap" | "concat" | "subtitle" | "burn" | "mix";
    /** 本步骤输出文件名 */
    output: string;
    /** ffmpeg 参数数组（不含可执行文件名与 -y 覆盖参数） */
    args: string[];
    description: string;
    /** 该步骤依赖 libass 与字体；失败必须阻止导出。 */
    requiresLibass?: boolean;
};

export type TimelineRenderContext = {
    width: number;
    height: number;
    fps: number;
    /** 是否烧录字幕；false 时跳过 burn 步骤 */
    burnSubtitles: boolean;
    /** 最终输出文件名 */
    outputName: string;
    subtitleImages?: string[];
};

export type TimelineRenderPlan = {
    steps: TimelineRenderStep[];
    finalOutput: string;
    /** concat 输入文件列表（trim/gap 输出），运行时据此写 concat.txt */
    concatEntries: string[];
};

export const SUBTITLE_FILE = "timeline.srt";

export function getExportClips(timeline: TimelineProject): TimelineClip[] {
    return timeline.clips.filter((clip) => {
        const track = timeline.tracks.find((item) => item.id === clip.trackId);
        return track?.visible !== false && !(clip.kind === "audio" && track?.muted);
    });
}

export function getOrderedVideoClips(timeline: TimelineProject): TimelineClip[] {
    return getExportClips(timeline)
        .filter((clip) => clip.kind === "video")
        .slice()
        .sort((a, b) => a.startMs - b.startMs || a.trackId.localeCompare(b.trackId));
}

export function getOrderedSubtitleClips(timeline: TimelineProject): TimelineClip[] {
    return getExportClips(timeline)
        .filter((clip) => clip.kind === "subtitle")
        .slice()
        .sort((a, b) => a.startMs - b.startMs || a.trackId.localeCompare(b.trackId));
}

/** 毫秒 → SRT 时间码 hh:mm:ss,mmm */
export function formatSrtTimestamp(ms: number): string {
    const safe = Math.max(0, Math.round(ms));
    const pad = (value: number, length = 2) => String(value).padStart(length, "0");
    const hours = Math.floor(safe / 3_600_000);
    const minutes = Math.floor((safe % 3_600_000) / 60_000);
    const seconds = Math.floor((safe % 60_000) / 1_000);
    const millis = safe % 1_000;
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/** 字幕轨片段 → SRT 文件内容（时间线全局时间，直接用于烧录） */
export function buildSubtitleSrt(clips: TimelineClip[]): string {
    return getOrderedSubtitleClips({ version: 2, tracks: [], clips, durationMs: 0 })
        .filter((clip) => clip.text && clip.durationMs > 0)
        .map((clip, index) => {
            const text = (clip.text || "").replace(/\r?\n/g, " ").trim();
            return [String(index + 1), `${formatSrtTimestamp(clip.startMs)} --> ${formatSrtTimestamp(clip.startMs + clip.durationMs)}`, text].join("\n");
        })
        .join("\n\n");
}

function defaultContext(): TimelineRenderContext {
    return { width: 1920, height: 1080, fps: 30, burnSubtitles: true, outputName: "export.mp4" };
}

/**
 * 生成导出计划。
 * 视频轨按 startMs 顺序裁切并补齐空隙（lavfi 黑场 + 静音），最后 concat；
 * 独立音轨按时间线位置混合，字幕轨生成 SRT 并在末步烧录。
 */
export function buildTimelineRenderPlan(timeline: TimelineProject, sources: TimelineRenderSource[], context: Partial<TimelineRenderContext> = {}): TimelineRenderPlan {
    const cfg: TimelineRenderContext = { ...defaultContext(), ...context };
    const sourceByNode = new Map(sources.map((item) => [item.nodeId, item]));
    const steps: TimelineRenderStep[] = [];
    const concatEntries: string[] = [];
    const videoClips = getOrderedVideoClips(timeline);
    const clips = getExportClips(timeline);
    if (!videoClips.length) throw new Error("时间线没有可见视频片段，无法导出");
    for (const clip of clips) {
        if (!["video", "audio", "subtitle"].includes(clip.kind)) throw new Error("暂不支持导出片段：" + (clip.title || clip.id));
        if (!Number.isFinite(clip.startMs) || clip.startMs < 0 || !Number.isFinite(clip.durationMs) || clip.durationMs <= 0) throw new Error("片段时间无效：" + clip.id);
        if ((clip.kind === "video" || clip.kind === "audio") && !sourceByNode.has(clip.nodeId)) throw new Error("找不到素材：" + (clip.title || clip.nodeId));
        if ((clip.sourceStartMs ?? 0) < 0 || !Number.isFinite(clip.sourceStartMs ?? 0) || !Number.isFinite(clip.volume ?? 1) || (clip.volume ?? 1) < 0) throw new Error("片段裁剪或音量无效：" + clip.id);
    }

    // 1)+2) 逐片段裁切，并按时间线顺序在片段前补黑场（含静音音轨），输出统一编码便于 concat。
    // 黑场必须插入对应片段之前的 concat 位置：concat 按列表顺序拼接，若先收完所有 trim 再把 gap 追加到
    // 结尾，任何存在空隙的时间线（如 A(0-15s) 与 B(25-40s) 之间的 10s）都会把黑场拼到片尾、字幕整体错位。
    // 缺源在规划前拒绝，不能用黑场冒充完整成片。
    let cursorMs = 0;
    videoClips.forEach((clip, index) => {
        const source = sourceByNode.get(clip.nodeId);
        if (!source) throw new Error("找不到素材：" + clip.nodeId);
        const gapMs = clip.startMs - cursorMs;
        if (gapMs < 0) throw new Error("视频片段重叠，请先调整时间线后导出");
        if (gapMs > 0) {
            const output = `gap-${index}.mp4`;
            const durationSec = gapMs / 1000;
            steps.push({
                kind: "gap",
                output,
                args: [
                    "-f",
                    "lavfi",
                    "-i",
                    `color=c=black:s=${cfg.width}x${cfg.height}:r=${cfg.fps}:d=${durationSec}`,
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=44100:cl=stereo",
                    "-t",
                    String(durationSec),
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "20",
                    "-c:a",
                    "aac",
                    "-shortest",
                    output,
                ],
                description: `补黑场 ${(gapMs / 1000).toFixed(2)}s`,
            });
            concatEntries.push(output);
        }
        const output = `trim-${index}.mp4`;
        // 裁切时长取时间线片段时长（clip.durationMs），而不是源素材剩余时长：
        // 左缘裁剪后 sourceStartMs 前移但 sourceDurationMs 仍为源全长，若按源时长 -t 会把旧片段尾部多裁出来，
        // 表现为「裁剪后播放仍从最原始视频开始/出现旧片段」；-ss 已定位源内起点，-t 必须等于片段展示时长。
        // -ss 必须放在 -i 之后（输出 seek）：放在 -i 之前是输入 seek，MP4/H.264 只会定位到目标时间戳
        // 之前最近的关键帧，切点会偏移最多一个 GOP（常见 0.5-2s）、片尾被 -t 截掉、音视频在切点处错位。
        // 本步骤已 -c:v libx264 重编码，输出 seek 帧精确，代价只是多解码。
        const durationSec = clip.durationMs / 1000;
        steps.push({
            kind: "trim",
            output,
            args: ["-i", source.fileName, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-ss", String((clip.sourceStartMs || 0) / 1000), "-t", String(durationSec), "-map", "0:v:0", "-map", source.hasAudio && !timeline.tracks.find((track) => track.id === clip.trackId)?.muted ? "0:a:0" : "1:a:0", "-vf", `scale=${cfg.width}:${cfg.height}:force_original_aspect_ratio=decrease,pad=${cfg.width}:${cfg.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${cfg.fps},format=yuv420p`, "-af", `aresample=44100,aformat=channel_layouts=stereo,volume=${clip.volume ?? 1},apad`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "128k", output],
            description: `裁切片段 ${index + 1}（${clip.title || clip.nodeId}）`,
        });
        concatEntries.push(output);
        cursorMs = clip.startMs + clip.durationMs;
    });

    // 3) concat 拼接视频轨。
    let concatOutput = "timeline-video.mp4";
    if (concatEntries.length) {
        steps.push({
            kind: "concat",
            output: concatOutput,
            args: ["-f", "concat", "-safe", "0", "-i", "concat.txt", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", concatOutput],
            description: "拼接视频轨",
        });
    }

    const audioClips = clips.filter((clip) => clip.kind === "audio");
    const durationSec = Math.max(...clips.map((clip) => clip.startMs + clip.durationMs)) / 1000;
    if (audioClips.length || durationSec > cursorMs / 1000) {
        const args = ["-i", concatOutput];
        const filters = [`[0:v]tpad=stop_mode=add:stop_duration=${durationSec}[v]`, "[0:a]apad[base]"];
        audioClips.forEach((clip, index) => {
            args.push("-i", sourceByNode.get(clip.nodeId)!.fileName);
            const duration = clip.durationMs / 1000;
            const fadeIn = Math.min(duration, Math.max(0, clip.fadeInMs || 0) / 1000);
            const fadeOut = Math.min(duration, Math.max(0, clip.fadeOutMs || 0) / 1000);
            filters.push(`[${index + 1}:a]atrim=start=${(clip.sourceStartMs || 0) / 1000}:duration=${duration},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume=${clip.volume ?? 1},afade=t=in:d=${fadeIn},afade=t=out:st=${duration - fadeOut}:d=${fadeOut},adelay=${clip.startMs}:all=1[a${index}]`);
        });
        filters.push(`[base]${audioClips.map((_, index) => `[a${index}]`).join("")}amix=inputs=${audioClips.length + 1}:normalize=0:duration=longest,alimiter=level=false[a]`);
        concatOutput = "timeline-mixed.mp4";
        args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-t", String(durationSec), "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", concatOutput);
        steps.push({ kind: "mix", output: concatOutput, args, description: "混合配音与背景音乐" });
    }

    // 4) 字幕轨 → SRT 内容（运行时写入 SUBTITLE_FILE）。
    const subtitleClips = getOrderedSubtitleClips(timeline);
    if (cfg.burnSubtitles && subtitleClips.some((clip) => clip.text?.trim())) {
        steps.push({
            kind: "subtitle",
            output: SUBTITLE_FILE,
            args: [],
            description: "生成字幕 SRT",
        });
    }

    // 5) 烧录字幕并输出最终文件（subtitles 滤镜需要 libass）。
    const finalOutput = cfg.outputName;
    if (concatEntries.length && steps.some((step) => step.kind === "subtitle") && cfg.subtitleImages) {
        const subtitles = subtitleClips.filter((clip) => clip.text?.trim());
        if (cfg.subtitleImages.length !== subtitles.length) throw new Error("字幕图像不完整");
        const args = ["-i", concatOutput];
        const filters: string[] = [];
        subtitles.forEach((clip, index) => {
            args.push("-i", cfg.subtitleImages![index]);
            filters.push(`[${index ? `sub${index - 1}` : "0:v"}][${index + 1}:v]overlay=enable='gte(t,${clip.startMs / 1000})*lt(t,${(clip.startMs + clip.durationMs) / 1000})'[sub${index}]`);
        });
        args.push("-filter_complex", filters.join(";"), "-map", `[sub${subtitles.length - 1}]`, "-map", "0:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", finalOutput);
        steps.push({ kind: "burn", output: finalOutput, args, description: "烧录字幕并输出" });
    } else if (concatEntries.length && steps.some((step) => step.kind === "subtitle")) {
        steps.push({
            kind: "burn",
            output: finalOutput,
            args: ["-i", concatOutput, "-vf", `subtitles=${SUBTITLE_FILE}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", finalOutput],
            description: "烧录字幕并输出",
            requiresLibass: true,
        });
    } else if (concatEntries.length) {
        steps.push({
            kind: "concat",
            output: finalOutput,
            args: ["-i", concatOutput, "-c", "copy", finalOutput],
            description: "输出成片（无字幕）",
        });
    }

    return { steps, finalOutput, concatEntries };
}

/** 供导出对话框/文档展示的人类可读命令预览 */
export function describeRenderPlan(plan: TimelineRenderPlan): string {
    return plan.steps.map((step) => `# ${step.description}\nffmpeg -y ${step.args.join(" ")}`).join("\n\n");
}
