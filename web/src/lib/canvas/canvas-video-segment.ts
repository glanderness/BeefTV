import { getMediaBlob } from "@/services/file-storage";
import { AUDIO_COPY_OUTPUT_NAME, AUDIO_OUTPUT_NAME, buildCopyAudioArgs, buildExtractAudioArgs, buildRemoveAudioArgs, buildSegmentTrimArgs, buildVideoCropArgs, CROP_OUTPUT_NAME, MUTED_VIDEO_OUTPUT_NAME, SEGMENT_INPUT_NAME, SEGMENT_OUTPUT_NAME, WAV_OUTPUT_NAME } from "./canvas-video-segment-args";
import { loadFFmpeg } from "./canvas-video-merge";

export type VideoSegmentRange = {
    startMs: number;
    endMs: number;
};

export type VideoSegmentSource = {
    url?: string;
    storageKey?: string;
};

export type VideoSegmentProgress = {
    phase: "loading" | "reading" | "encoding";
    progress: number;
};

const INPUT_NAME = SEGMENT_INPUT_NAME;
const OUTPUT_NAME = SEGMENT_OUTPUT_NAME;

function assertValidRange(range: VideoSegmentRange, durationMs?: number) {
    const startMs = Math.max(0, Math.round(range.startMs));
    const endMs = Math.round(range.endMs);
    if (endMs <= startMs) throw new Error("片段结束时间必须晚于开始时间");
    if (durationMs !== undefined && endMs > Math.round(durationMs)) throw new Error("片段结束时间超过视频时长");
}

async function readVideoSourceBlob(source: VideoSegmentSource) {
    if (source.storageKey) {
        const stored = await getMediaBlob(source.storageKey);
        if (stored) return stored;
    }
    if (source.url) {
        const response = await fetch(source.url);
        if (!response.ok) throw new Error(`视频资源请求失败（${response.status}）`);
        return response.blob();
    }
    throw new Error("找不到视频素材，请重新上传后再操作");
}

async function runSegmentJob(
    source: VideoSegmentSource,
    range: VideoSegmentRange | undefined,
    durationMs: number | undefined,
    buildArgs: (startSec: string, durationSec: string) => string[],
    onProgress?: (progress: VideoSegmentProgress) => void,
    outputType = "video/mp4",
    outputName = OUTPUT_NAME,
) {
    if (range) assertValidRange(range, durationMs);
    const ffmpeg = await loadFFmpeg(({ phase, progress }) => onProgress?.({ phase: phase === "loading" ? "loading" : "reading", progress }));
    const { fetchFile } = await import("@ffmpeg/util");
    const blob = await readVideoSourceBlob(source);
    onProgress?.({ phase: "reading", progress: 45 });
    await ffmpeg.writeFile(INPUT_NAME, await fetchFile(blob));
    const startSec = range ? String(range.startMs / 1000) : "";
    const durationSec = range ? String((range.endMs - range.startMs) / 1000) : "";
    onProgress?.({ phase: "encoding", progress: 55 });
    try {
        const exitCode = await ffmpeg.exec(["-y", ...buildArgs(startSec, durationSec)]);
        if (exitCode !== 0) throw new Error("媒体处理失败，请确认视频编码格式兼容");
        const output = await ffmpeg.readFile(outputName);
        onProgress?.({ phase: "encoding", progress: 100 });
        return new Blob([output as BlobPart], { type: outputType });
    } finally {
        await Promise.all([INPUT_NAME, OUTPUT_NAME, outputName].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
    }
}

/** 按片段范围截取视频，输出统一编码 MP4（复用时间线 trim 的参数模板）。 */
export async function trimVideoSegment(source: VideoSegmentSource, range: VideoSegmentRange, durationMs?: number, onProgress?: (progress: VideoSegmentProgress) => void) {
    return runSegmentJob(source, range, durationMs, (startSec, durationSec) => buildSegmentTrimArgs(startSec, durationSec), onProgress, "video/mp4");
}

/** 从视频中移除音轨，保留画面并输出独立无声视频。 */
export async function removeAudioFromVideo(source: VideoSegmentSource, onProgress?: (progress: VideoSegmentProgress) => void) {
    return runSegmentJob(source, undefined, undefined, () => buildRemoveAudioArgs(), onProgress, "video/mp4", MUTED_VIDEO_OUTPUT_NAME);
}

/** 从整段视频提取声音；优先直接复制，编码器不兼容时自动回退。 */
export async function extractVideoAudio(source: VideoSegmentSource, onProgress?: (progress: VideoSegmentProgress) => void) {
    const ffmpeg = await loadFFmpeg(({ phase, progress }) => onProgress?.({ phase: phase === "loading" ? "loading" : "reading", progress }));
    const { fetchFile } = await import("@ffmpeg/util");
    const blob = await readVideoSourceBlob(source);
    onProgress?.({ phase: "reading", progress: 45 });
    await ffmpeg.writeFile(INPUT_NAME, await fetchFile(blob));
    onProgress?.({ phase: "encoding", progress: 55 });
    try {
        const args = (audioCodec: string, outputName = AUDIO_OUTPUT_NAME) => buildExtractAudioArgs(audioCodec, outputName);
        let outputName = AUDIO_OUTPUT_NAME;
        let outputType = "audio/mpeg";
        // 大多数 MP4 音轨本身就是 AAC；优先直接复制，避免无谓的整段重编码。
        let exitCode = await ffmpeg.exec(["-y", ...buildCopyAudioArgs(AUDIO_COPY_OUTPUT_NAME)]);
        if (exitCode === 0) {
            outputName = AUDIO_COPY_OUTPUT_NAME;
            outputType = "audio/mp4";
        }
        if (exitCode !== 0) exitCode = await ffmpeg.exec(["-y", ...args("libmp3lame")]);
        if (exitCode !== 0) exitCode = await ffmpeg.exec(["-y", ...args("mp3")]);
        if (exitCode !== 0) {
            // 若内核缺少音频编码器，直接复制源音轨到 M4A，避免重编码依赖。
            outputName = AUDIO_COPY_OUTPUT_NAME;
            outputType = "audio/mp4";
            exitCode = await ffmpeg.exec(["-y", ...buildCopyAudioArgs(outputName)]);
        }
        if (exitCode !== 0) {
            // The bundled core may omit both MP3 encoders. PCM/WAV is broadly
            // available and remains a valid audio node payload, so preserve
            // the extraction workflow instead of failing after the dialog.
            outputName = WAV_OUTPUT_NAME;
            outputType = "audio/wav";
            exitCode = await ffmpeg.exec(["-y", ...args("pcm_s16le", outputName)]);
        }
        if (exitCode !== 0) throw new Error("音频提取失败：当前 FFmpeg 内核不支持可用的音频编码");
        const output = await ffmpeg.readFile(outputName);
        onProgress?.({ phase: "encoding", progress: 100 });
        return new Blob([output as BlobPart], { type: outputType });
    } finally {
        await Promise.all([INPUT_NAME, OUTPUT_NAME, AUDIO_OUTPUT_NAME, WAV_OUTPUT_NAME, AUDIO_COPY_OUTPUT_NAME].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
    }
}

export type VideoCropRect = { x: number; y: number; width: number; height: number };

/** 按源视频像素裁切画面，保留原音轨并输出新视频。 */
export async function cropVideo(source: VideoSegmentSource, crop: VideoCropRect, onProgress?: (progress: VideoSegmentProgress) => void) {
    const ffmpeg = await loadFFmpeg(({ phase, progress }) => onProgress?.({ phase: phase === "loading" ? "loading" : "reading", progress }));
    const { fetchFile } = await import("@ffmpeg/util");
    const blob = await readVideoSourceBlob(source);
    onProgress?.({ phase: "reading", progress: 45 });
    await ffmpeg.writeFile(INPUT_NAME, await fetchFile(blob));
    onProgress?.({ phase: "encoding", progress: 55 });
    try {
        const exitCode = await ffmpeg.exec(["-y", ...buildVideoCropArgs(crop.x, crop.y, crop.width, crop.height)]);
        if (exitCode !== 0) throw new Error("视频画面裁切失败，请确认视频编码格式兼容");
        const output = await ffmpeg.readFile(CROP_OUTPUT_NAME);
        onProgress?.({ phase: "encoding", progress: 100 });
        return new Blob([output as BlobPart], { type: "video/mp4" });
    } finally {
        await Promise.all([INPUT_NAME, CROP_OUTPUT_NAME].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
    }
}
