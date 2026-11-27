import type { CanvasNodeMetadata } from "@/types/canvas";

export type InlineVideoTrimRange = { startMs: number; endMs: number };

export const INLINE_VIDEO_TRIM_MIN_MS = 100;
export const INLINE_VIDEO_TRIM_FINE_DRAG_FACTOR = 0.2;
export const INLINE_VIDEO_TRIM_SNAP_MAX_PX = 5;
export const INLINE_VIDEO_TRIM_STEP_DEFAULT_MS = 100;
export const INLINE_VIDEO_TRIM_STEP_COARSE_MS = 1000;
export const INLINE_VIDEO_TRIM_STEP_FINE_MS = 10;

export function normalizeInlineVideoTrimRange(range: InlineVideoTrimRange, durationMs: number): InlineVideoTrimRange {
    const duration = Math.max(INLINE_VIDEO_TRIM_MIN_MS, Math.round(durationMs));
    let startMs = Math.min(duration, Math.max(0, Math.round(range.startMs)));
    let endMs = Math.min(duration, Math.max(0, Math.round(range.endMs)));
    if (endMs < startMs) [startMs, endMs] = [endMs, startMs];
    if (endMs - startMs >= INLINE_VIDEO_TRIM_MIN_MS) return { startMs, endMs };
    if (startMs + INLINE_VIDEO_TRIM_MIN_MS <= duration) endMs = startMs + INLINE_VIDEO_TRIM_MIN_MS;
    else startMs = Math.max(0, duration - INLINE_VIDEO_TRIM_MIN_MS);
    return { startMs, endMs: Math.min(duration, Math.max(endMs, startMs + INLINE_VIDEO_TRIM_MIN_MS)) };
}

export function moveInlineVideoTrimRange(range: InlineVideoTrimRange, deltaMs: number, durationMs: number): InlineVideoTrimRange {
    const normalized = normalizeInlineVideoTrimRange(range, durationMs);
    const selectedDuration = normalized.endMs - normalized.startMs;
    const desiredStart = normalized.startMs + Math.round(deltaMs);
    const startMs = Math.min(Math.max(0, Math.round(durationMs) - selectedDuration), Math.max(0, desiredStart));
    return { startMs, endMs: startMs + selectedDuration };
}

export function updateInlineVideoTrimStart(range: InlineVideoTrimRange, nextStartMs: number, durationMs: number): InlineVideoTrimRange {
    const duration = Math.max(INLINE_VIDEO_TRIM_MIN_MS, Math.round(durationMs));
    const maxStart = Math.max(0, duration - INLINE_VIDEO_TRIM_MIN_MS);
    const startMs = Math.min(maxStart, Math.max(0, Math.round(nextStartMs)));
    const endMs = Math.max(range.endMs, startMs + INLINE_VIDEO_TRIM_MIN_MS);
    return normalizeInlineVideoTrimRange({ startMs, endMs }, duration);
}

export function updateInlineVideoTrimEnd(range: InlineVideoTrimRange, nextEndMs: number, durationMs: number): InlineVideoTrimRange {
    const duration = Math.max(INLINE_VIDEO_TRIM_MIN_MS, Math.round(durationMs));
    const minEnd = Math.min(duration, INLINE_VIDEO_TRIM_MIN_MS);
    const endMs = Math.min(duration, Math.max(minEnd, Math.round(nextEndMs)));
    const startMs = Math.min(range.startMs, Math.max(0, endMs - INLINE_VIDEO_TRIM_MIN_MS));
    return normalizeInlineVideoTrimRange({ startMs, endMs }, duration);
}

/**
 * Sets the selected clip duration while keeping the start handle fixed whenever
 * possible; if start + targetDuration exceeds the video end, shifts start left
 * so the requested duration is still honored up to the source duration.
 */
export function updateInlineVideoTrimDuration(range: InlineVideoTrimRange, nextDurationMs: number, durationMs: number): InlineVideoTrimRange {
    const duration = Math.max(INLINE_VIDEO_TRIM_MIN_MS, Math.round(durationMs));
    const normalized = normalizeInlineVideoTrimRange(range, duration);
    const targetDuration = Math.min(duration, Math.max(Math.min(duration, INLINE_VIDEO_TRIM_MIN_MS), Math.round(nextDurationMs)));
    if (normalized.startMs + targetDuration <= duration) {
        return { startMs: normalized.startMs, endMs: normalized.startMs + targetDuration };
    }
    return { startMs: Math.max(0, duration - targetDuration), endMs: duration };
}

export function formatInlineVideoTrimPoint(ms: number): string {
    const totalCentiseconds = Math.max(0, Math.round(ms / 10));
    const hours = Math.floor(totalCentiseconds / 360_000);
    const minutes = Math.floor((totalCentiseconds % 360_000) / 6_000);
    const seconds = Math.floor((totalCentiseconds % 6_000) / 100);
    const centiseconds = totalCentiseconds % 100;
    const base = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
    return hours > 0 ? `${hours}:${base}` : base;
}

export function formatInlineVideoTrimDuration(ms: number): string {
    const roundedSeconds = Math.max(0, Math.round(ms / 10)) / 100;
    return `${roundedSeconds.toFixed(2)} s`;
}

export function formatInlineVideoTrimDurationInput(ms: number): string {
    const roundedSeconds = Math.max(0, Math.round(ms / 10)) / 100;
    return roundedSeconds.toFixed(2);
}

/**
 * Parses loose human time inputs into integer milliseconds.
 * Accepts seconds ("30", "30s", "30.08", "30秒"), MM:SS(.cc), and HH:MM:SS(.cc).
 */
export function parseInlineVideoTrimTimeMs(raw: string): number | null {
    const normalized = raw
        .trim()
        .replace(/：/g, ":")
        .replace(/[。，]/g, ".")
        .replace(/\s*(?:secs?|seconds?|s|秒)\s*$/i, "")
        .trim();
    if (!normalized) return null;

    if (!normalized.includes(":")) {
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
        const seconds = Number(normalized);
        return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
    }

    const parts = normalized.split(":");
    if (parts.length < 2 || parts.length > 3) return null;
    const last = parts[parts.length - 1]!;
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(last)) return null;
    const seconds = Number(last);
    if (!Number.isFinite(seconds) || seconds < 0) return null;

    for (let index = 0; index < parts.length - 1; index += 1) {
        if (!/^\d+$/.test(parts[index]!)) return null;
    }

    if (parts.length === 2) {
        const totalMs = Math.round((Number(parts[0]) * 60 + seconds) * 1000);
        return Number.isFinite(totalMs) ? totalMs : null;
    }
    const totalMs = Math.round((Number(parts[0]) * 3600 + Number(parts[1]) * 60 + seconds) * 1000);
    return Number.isFinite(totalMs) ? totalMs : null;
}

export function inlineVideoTrimSnapGridMs(durationMs: number): number {
    if (durationMs <= 60_000) return 1_000;
    if (durationMs <= 180_000) return 5_000;
    return 10_000;
}

export type InlineVideoTrimSnapResult = {
    valueMs: number;
    snapped: boolean;
};

/**
 * Light magnetic snap for start/end handle drags. Snaps to clip boundaries,
 * adaptive whole-second grid points, and whole-second selection durations.
 */
export function snapInlineVideoTrimHandleMs(
    kind: "start" | "end",
    rawMs: number,
    anchorMs: number,
    durationMs: number,
    timelineWidthPx: number,
    options?: { disableSnap?: boolean },
): InlineVideoTrimSnapResult {
    const duration = Math.max(INLINE_VIDEO_TRIM_MIN_MS, Math.round(durationMs));
    const clamped = Math.min(duration, Math.max(0, Math.round(rawMs)));
    if (options?.disableSnap || timelineWidthPx <= 0) return { valueMs: clamped, snapped: false };

    const gridMs = inlineVideoTrimSnapGridMs(duration);
    const pxPerGrid = (gridMs / duration) * timelineWidthPx;
    const snapRadiusPx = Math.min(INLINE_VIDEO_TRIM_SNAP_MAX_PX, pxPerGrid * 0.22);
    const snapRadiusMs = Math.round((snapRadiusPx / Math.max(1, timelineWidthPx)) * duration);
    if (snapRadiusMs <= 0) return { valueMs: clamped, snapped: false };

    const candidates = new Set<number>([0, duration]);
    const nearestGrid = Math.round(clamped / gridMs) * gridMs;
    if (nearestGrid >= 0 && nearestGrid <= duration) candidates.add(nearestGrid);

    const rawSpan = kind === "end" ? clamped - anchorMs : anchorMs - clamped;
    const nearestSpanGrid = Math.round(rawSpan / gridMs) * gridMs;
    if (nearestSpanGrid >= INLINE_VIDEO_TRIM_MIN_MS) {
        const spanTarget = kind === "end" ? anchorMs + nearestSpanGrid : anchorMs - nearestSpanGrid;
        if (spanTarget >= 0 && spanTarget <= duration) candidates.add(spanTarget);
    }

    let bestValue = clamped;
    let bestDistance = snapRadiusMs + 1;
    for (const candidate of candidates) {
        const distance = Math.abs(candidate - clamped);
        if (distance <= snapRadiusMs && distance < bestDistance) {
            bestDistance = distance;
            bestValue = candidate;
        }
    }
    return bestDistance <= snapRadiusMs ? { valueMs: bestValue, snapped: true } : { valueMs: clamped, snapped: false };
}

export function inlineVideoTrimKeyboardStepMs(event: { shiftKey?: boolean; altKey?: boolean }): number {
    if (event.shiftKey) return INLINE_VIDEO_TRIM_STEP_COARSE_MS;
    if (event.altKey) return INLINE_VIDEO_TRIM_STEP_FINE_MS;
    return INLINE_VIDEO_TRIM_STEP_DEFAULT_MS;
}

export function applyInlineVideoTrimMetadata(
    previous: CanvasNodeMetadata,
    media: CanvasNodeMetadata,
    range: InlineVideoTrimRange,
): CanvasNodeMetadata {
    const source = previous.videoTrimSource || {
        content: previous.content,
        storageKey: previous.storageKey,
        durationMs: previous.durationMs,
        naturalWidth: previous.naturalWidth,
        naturalHeight: previous.naturalHeight,
        bytes: previous.bytes,
        mimeType: previous.mimeType,
        hasAudio: previous.hasAudio,
    };
    return {
        ...previous,
        ...media,
        assetId: undefined,
        mediaOperationError: undefined,
        videoTrimSource: source,
        videoTrimStartMs: range.startMs,
        videoTrimEndMs: range.endMs,
    };
}
