export type VideoPlayerMimeType =
    | "video/mp4"
    | "video/webm"
    | "video/3gp"
    | "video/ogg"
    | "video/avi"
    | "video/mpeg"
    | "video/object";

const SUPPORTED_VIDEO_PLAYER_MIME_TYPES = new Set<VideoPlayerMimeType>([
    "video/mp4",
    "video/webm",
    "video/3gp",
    "video/ogg",
    "video/avi",
    "video/mpeg",
    "video/object",
]);

export function normalizeVideoPlayerMimeType(mimeType?: string): VideoPlayerMimeType {
    const container = mimeType?.split(";", 1)[0]?.trim().toLowerCase() as VideoPlayerMimeType | undefined;
    return container && SUPPORTED_VIDEO_PLAYER_MIME_TYPES.has(container) ? container : "video/mp4";
}

/**
 * LibTV 保守静音规则（画布轻量播放器与弹窗完整播放器单一真源）：
 * 仅在明确标记或容器探测确认无音轨时强制静音；运行时探测若发现真实音轨，可纠正陈旧的 `hasAudio: false`。
 */
export function resolveEffectiveVideoHasAudio(
    hasAudio: boolean | undefined,
    detectedHasAudio: boolean | undefined,
): boolean | undefined {
    return detectedHasAudio === false
        ? false
        : hasAudio === true || detectedHasAudio === true
          ? true
          : hasAudio === false
            ? false
            : undefined;
}

export function hasVideoTrackDimensions(
    video: Pick<HTMLVideoElement, "videoWidth" | "videoHeight"> | null | undefined,
): boolean {
    return Boolean(video && Number(video.videoWidth) > 0 && Number(video.videoHeight) > 0);
}

/**
 * Chromium / Edge WebView2 在遇到“视频轨无法解码（如 Windows 未装 HEVC 扩展时的 H.265/HEVC、
 * MPEG-4 Part 2 等），但音轨可解（如 AAC）”的容器时，不会触发 `<video>`/`<source>` 的 `error`，
 * 而是静默进入 `readyState >= HAVE_METADATA (1)` 且 `videoWidth === 0 || videoHeight === 0` 的纯音频态。
 * 统一由此单一真源判定并触发兼容 H.264 播放副本回退。
 */
export function isUndecodableVideoTrack(
    video: Pick<HTMLVideoElement, "readyState" | "videoWidth" | "videoHeight"> | null | undefined,
): boolean {
    return Boolean(video && Number(video.readyState) >= 1 && !hasVideoTrackDimensions(video));
}

export function isVideoSpaceShortcutIgnoredTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(
        target.closest("input, textarea, select, [contenteditable='true'], button, a[href], [role='button'], [role='menuitem'], [role='slider']"),
    );
}
