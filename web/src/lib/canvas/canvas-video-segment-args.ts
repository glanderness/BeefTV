// 视频片段处理（裁切/提音轨）的 ffmpeg 参数构造，纯函数便于单测。
// -ss 必须放在 -i 之后（输出 seek）：放在 -i 之前是输入 seek，MP4/H.264 只会定位到目标时间戳
// 之前最近的关键帧，切点会偏移最多一个 GOP（常见 0.5-2s）、片尾被 -t 截掉、音视频在切点处错位；
// 本流程已 -c:v libx264 重编码，输出 seek 帧精确，代价只是多解码。

export const SEGMENT_INPUT_NAME = "segment-input.mp4";
export const SEGMENT_OUTPUT_NAME = "segment-output.mp4";
export const AUDIO_OUTPUT_NAME = "segment-output.mp3";
export const WAV_OUTPUT_NAME = "segment-output.wav";
export const AUDIO_COPY_OUTPUT_NAME = "segment-output.m4a";
export const MUTED_VIDEO_OUTPUT_NAME = "segment-muted-output.mp4";
export const CROP_OUTPUT_NAME = "segment-crop-output.mp4";

/** 视频片段裁切参数：输出统一编码 MP4。 */
export function buildSegmentTrimArgs(startSec: string, durationSec: string): string[] {
    return ["-i", SEGMENT_INPUT_NAME, "-ss", startSec, "-t", durationSec, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", SEGMENT_OUTPUT_NAME];
}

/** 从整段视频提取声音，不依赖播放器先解析出时长。 */
export function buildExtractAudioArgs(audioCodec: string, outputName = SEGMENT_OUTPUT_NAME): string[] {
    return ["-i", SEGMENT_INPUT_NAME, "-vn", "-c:a", audioCodec, "-q:a", "2", outputName];
}

/** 直接复制原音轨，绕过精简内核缺少 MP3/AAC 编码器的问题。 */
export function buildCopyAudioArgs(outputName = AUDIO_COPY_OUTPUT_NAME): string[] {
    return ["-i", SEGMENT_INPUT_NAME, "-map", "0:a:0?", "-vn", "-c:a", "copy", "-movflags", "+faststart", outputName];
}

/** 去掉整段视频的音轨：不做 seek，避免码流复制丢掉第一组 GOP。 */
export function buildRemoveAudioArgs(outputName = MUTED_VIDEO_OUTPUT_NAME): string[] {
    // 分离始终处理整段视频。直接重封装保留画质和速度，同时保留 0 秒开始的首个 GOP。
    return ["-i", SEGMENT_INPUT_NAME, "-map", "0:v:0", "-an", "-c:v", "copy", "-movflags", "+faststart", outputName];
}

/** 空间裁切视频，坐标和尺寸使用源视频像素值。 */
export function buildVideoCropArgs(x: number, y: number, width: number, height: number): string[] {
    return ["-i", SEGMENT_INPUT_NAME, "-vf", `crop=${Math.round(width)}:${Math.round(height)}:${Math.round(x)}:${Math.round(y)}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", CROP_OUTPUT_NAME];
}
