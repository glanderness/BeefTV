import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Check, LoaderCircle, Pause, Play, X } from "lucide-react";

import { CanvasNodePanelOverlay } from "@/components/canvas/canvas-workspace-overlays";
import {
    INLINE_VIDEO_TRIM_FINE_DRAG_FACTOR,
    INLINE_VIDEO_TRIM_MIN_MS,
    formatInlineVideoTrimDuration,
    formatInlineVideoTrimDurationInput,
    formatInlineVideoTrimPoint,
    inlineVideoTrimKeyboardStepMs,
    moveInlineVideoTrimRange,
    normalizeInlineVideoTrimRange,
    parseInlineVideoTrimTimeMs,
    snapInlineVideoTrimHandleMs,
    updateInlineVideoTrimDuration,
    updateInlineVideoTrimEnd,
    updateInlineVideoTrimStart,
    type InlineVideoTrimRange,
} from "@/lib/canvas/canvas-video-inline-trim";
import { canvasNodeVideoPreviewUrl } from "@/lib/canvas/canvas-media-preview";
import { formatCanvasVideoRetakeTime } from "@/lib/canvas/canvas-video-retake";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { resolveMediaUrl } from "@/services/file-storage";
import type { CanvasNodeData, Position, ViewportTransform } from "@/types/canvas";

type CanvasVideoInlineTrimProps = {
    node: CanvasNodeData;
    busy: boolean;
    onCancel: () => void;
} & (
    | { onConfirm: (range: InlineVideoTrimRange, durationMs?: number) => void; onRetake?: never }
    | { onRetake: (range: InlineVideoTrimRange, durationMs: number, prompt: string) => void; onConfirm?: never }
);

type CanvasVideoInlineTrimOverlayProps = CanvasVideoInlineTrimProps & {
    viewport: ViewportTransform;
    containerRef: RefObject<HTMLDivElement | null>;
    dragOffset?: Position | null;
    isDragging?: boolean;
};

type DragSession = {
    kind: "start" | "end" | "range";
    pointerId: number;
    lastClientX: number;
    wasFineDrag: boolean;
    rawStartMs: number;
    rawEndMs: number;
    lastCommittedRange: InlineVideoTrimRange;
    baseRange: InlineVideoTrimRange;
    accumulatedDeltaMs: number;
};

type EditableTimeField = "start" | "end" | "duration";

const FRAME_COUNT = 14;
export const CANVAS_VIDEO_TRIM_PANEL_HEIGHT = 104;
export const CANVAS_VIDEO_RETAKE_PANEL_HEIGHT = 128;

export function CanvasVideoInlineTrimOverlay({ viewport, containerRef, dragOffset, isDragging = false, ...editor }: CanvasVideoInlineTrimOverlayProps) {
    return (
        <CanvasNodePanelOverlay
            node={editor.node}
            viewport={viewport}
            containerRef={containerRef}
            panelMinWidth={editor.onRetake ? 440 : 520}
            panelMaxWidth={editor.onRetake ? 660 : 920}
            panelWidthScale={1.5}
            panelHeight={editor.onRetake ? CANVAS_VIDEO_RETAKE_PANEL_HEIGHT : CANVAS_VIDEO_TRIM_PANEL_HEIGHT}
            allowOverflow
            keepBelowNode
            avoidBottomDock
            className="canvas-video-trim-overlay"
            dragOffset={dragOffset}
            isDragging={isDragging}
        >
            <CanvasVideoInlineTrim {...editor} />
        </CanvasNodePanelOverlay>
    );
}

export function CanvasVideoInlineTrim({ node, busy, onCancel, onConfirm, onRetake }: CanvasVideoInlineTrimProps) {
    const retake = Boolean(onRetake);
    const timelineRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<DragSession | null>(null);
    const retakePreviewRef = useRef<HTMLVideoElement>(null);
    const userAdjustedRef = useRef(false);
    const skipBlurCommitRef = useRef(false);
    const restoreFocusFieldRef = useRef<EditableTimeField | null>(null);
    const chipRefs = useRef<Partial<Record<EditableTimeField, HTMLButtonElement | null>>>({});
    const timeInputRef = useRef<HTMLInputElement>(null);
    const [instruction, setInstruction] = useState("");
    const [videoUrl, setVideoUrl] = useState(node.metadata?.content || "");
    const [durationMs, setDurationMs] = useState(Math.max(0, node.metadata?.durationMs || 0));
    const [range, setRange] = useState<InlineVideoTrimRange>(() => ({ startMs: 0, endMs: Math.max(INLINE_VIDEO_TRIM_MIN_MS, node.metadata?.durationMs || INLINE_VIDEO_TRIM_MIN_MS) }));
    const [frames, setFrames] = useState<string[]>([]);
    const [frameStatus, setFrameStatus] = useState<"loading" | "ready" | "unavailable">("loading");
    const [playing, setPlaying] = useState(false);
    const [snappedEdge, setSnappedEdge] = useState<"start" | "end" | null>(null);
    const [editingField, setEditingField] = useState<EditableTimeField | null>(null);
    const [draftValue, setDraftValue] = useState("");

    useEffect(() => {
        let cancelled = false;
        const storageKey = node.metadata?.storageKey || "";
        const fallback = node.metadata?.content || "";
        const resolve = async () => {
            const cached = resourceIdFromStorageKey(storageKey) ? await cacheResourceObjectUrl(storageKey) : null;
            const nextUrl = cached || await resolveMediaUrl(storageKey, fallback);
            if (!cancelled) setVideoUrl(nextUrl || fallback);
        };
        void resolve().catch(() => { if (!cancelled) setVideoUrl(fallback); });
        return () => { cancelled = true; };
    }, [node.id, node.metadata?.content, node.metadata?.storageKey]);

    useEffect(() => {
        const nextDuration = node.metadata?.durationMs || (retake ? 0 : INLINE_VIDEO_TRIM_MIN_MS);
        userAdjustedRef.current = false;
        setEditingField(null);
        setSnappedEdge(null);
        setDurationMs(nextDuration);
        setRange({ startMs: 0, endMs: nextDuration });
    }, [node.id, node.metadata?.durationMs, retake]);

    useEffect(() => {
        setFrames([]);
        setFrameStatus(videoUrl ? "loading" : "unavailable");
        if (!videoUrl || typeof document === "undefined") return;
        let cancelled = false;
        const source = document.createElement("video");
        source.muted = true;
        source.playsInline = true;
        source.preload = "auto";
        source.src = videoUrl;
        const capture = async () => {
            await waitForMediaEvent(source, "loadedmetadata");
            if (cancelled) return;
            const seconds = source.duration;
            if (!Number.isFinite(seconds) || seconds <= 0) {
                setFrameStatus("unavailable");
                return;
            }
            const nextDuration = Math.round(seconds * 1000);
            setDurationMs(nextDuration);
            setRange((current) => normalizeInlineVideoTrimRange(
                !userAdjustedRef.current || current.endMs <= INLINE_VIDEO_TRIM_MIN_MS
                    ? { startMs: 0, endMs: nextDuration }
                    : current,
                nextDuration,
            ));
            const canvas = document.createElement("canvas");
            canvas.width = 144;
            canvas.height = 82;
            const context = canvas.getContext("2d");
            if (!context || !seconds) {
                setFrameStatus("unavailable");
                return;
            }
            const captured: string[] = [];
            for (let index = 0; index < FRAME_COUNT && !cancelled; index += 1) {
                source.currentTime = Math.min(Math.max(0, seconds - 0.04), (seconds * (index + 0.5)) / FRAME_COUNT);
                await waitForMediaEvent(source, "seeked");
                if (cancelled) return;
                context.drawImage(source, 0, 0, canvas.width, canvas.height);
                captured.push(canvas.toDataURL("image/jpeg", 0.72));
                setFrames([...captured]);
                setFrameStatus("ready");
            }
        };
        void capture().catch(() => { if (!cancelled) setFrameStatus("unavailable"); });
        return () => {
            cancelled = true;
            source.removeAttribute("src");
            source.load();
        };
    }, [videoUrl]);

    useEffect(() => {
        const preview = retake ? retakePreviewRef.current : canvasNodeVideo(node.id);
        if (!preview) return;
        preview.muted = false;
        preview.loop = false;
        const handleTimeUpdate = () => {
            if (preview.currentTime * 1000 < range.endMs - 20) return;
            preview.pause();
            setPlaying(false);
        };
        const handlePause = () => setPlaying(false);
        preview.addEventListener("timeupdate", handleTimeUpdate);
        preview.addEventListener("pause", handlePause);
        return () => {
            preview.removeEventListener("timeupdate", handleTimeUpdate);
            preview.removeEventListener("pause", handlePause);
        };
    }, [node.id, range.endMs, range.startMs, retake]);

    useEffect(() => {
        if (!retake) return () => canvasNodeVideo(node.id)?.pause();
    }, [node.id, retake]);

    useEffect(() => {
        if (editingField) {
            const input = timeInputRef.current;
            if (!input) return;
            input.focus();
            input.select();
            return;
        }
        const restoreTarget = restoreFocusFieldRef.current;
        if (!restoreTarget) return;
        restoreFocusFieldRef.current = null;
        chipRefs.current[restoreTarget]?.focus();
    }, [editingField]);

    const startPercent = durationMs ? (range.startMs / durationMs) * 100 : 0;
    const endPercent = durationMs ? (range.endMs / durationMs) * 100 : 100;
    const selectedDuration = Math.max(0, range.endMs - range.startMs);
    const fallbackFrame = canvasNodeVideoPreviewUrl(node);
    const visibleFrames = useMemo(() => Array.from({ length: FRAME_COUNT }, (_, index) => frames[index] || frames[0] || fallbackFrame), [fallbackFrame, frames]);
    const showFrameStatus = !visibleFrames.some(Boolean);

    const seekPreview = (timeMs: number) => {
        const preview = retake ? retakePreviewRef.current : canvasNodeVideo(node.id);
        if (preview?.readyState) preview.currentTime = Math.max(0, timeMs) / 1000;
    };

    const applyRange = (next: InlineVideoTrimRange, previewEdge: "start" | "end") => {
        userAdjustedRef.current = true;
        setRange(next);
        seekPreview(previewEdge === "end" ? next.endMs : next.startMs);
    };

    const formatFieldDraft = (field: EditableTimeField, activeRange: InlineVideoTrimRange) => {
        if (field === "start") return formatInlineVideoTrimPoint(activeRange.startMs);
        if (field === "end") return formatInlineVideoTrimPoint(activeRange.endMs);
        return formatInlineVideoTrimDurationInput(Math.max(0, activeRange.endMs - activeRange.startMs));
    };

    const applyFieldMs = (field: EditableTimeField, targetMs: number): InlineVideoTrimRange => {
        if (field === "start") return updateInlineVideoTrimStart(range, targetMs, durationMs);
        if (field === "end") return updateInlineVideoTrimEnd(range, targetMs, durationMs);
        return updateInlineVideoTrimDuration(range, targetMs, durationMs);
    };

    const openFieldEdit = (field: EditableTimeField) => {
        if (busy || !durationMs) return;
        skipBlurCommitRef.current = false;
        setEditingField(field);
        setDraftValue(formatFieldDraft(field, range));
    };

    const commitFieldEdit = (field: EditableTimeField, raw: string) => {
        const parsedMs = parseInlineVideoTrimTimeMs(raw);
        setEditingField(null);
        if (parsedMs === null || !durationMs) return;
        const next = applyFieldMs(field, parsedMs);
        applyRange(next, field === "start" ? "start" : "end");
    };

    const handleFieldBlur = (field: EditableTimeField) => {
        if (skipBlurCommitRef.current) {
            skipBlurCommitRef.current = false;
            return;
        }
        commitFieldEdit(field, draftValue);
    };

    const handleFieldKeyDown = (field: EditableTimeField, event: KeyboardEvent<HTMLInputElement>) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") {
            event.preventDefault();
            skipBlurCommitRef.current = true;
            restoreFocusFieldRef.current = field;
            commitFieldEdit(field, draftValue);
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            skipBlurCommitRef.current = true;
            restoreFocusFieldRef.current = field;
            setEditingField(null);
            return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            if (!durationMs) return;
            const step = inlineVideoTrimKeyboardStepMs(event) * (event.key === "ArrowUp" ? 1 : -1);
            const currentMs = parseInlineVideoTrimTimeMs(draftValue) ?? (
                field === "start" ? range.startMs : field === "end" ? range.endMs : selectedDuration
            );
            const next = applyFieldMs(field, Math.max(0, currentMs + step));
            applyRange(next, field === "start" ? "start" : "end");
            setDraftValue(formatFieldDraft(field, next));
        }
    };

    const beginDrag = (kind: DragSession["kind"], event: ReactPointerEvent<HTMLElement>) => {
        if (busy || !durationMs) return;
        event.preventDefault();
        event.stopPropagation();
        skipBlurCommitRef.current = true;
        setEditingField(null);
        setSnappedEdge(null);
        dragRef.current = {
            kind,
            pointerId: event.pointerId,
            lastClientX: event.clientX,
            wasFineDrag: event.shiftKey,
            rawStartMs: range.startMs,
            rawEndMs: range.endMs,
            lastCommittedRange: range,
            baseRange: range,
            accumulatedDeltaMs: 0,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const continueDrag = (event: ReactPointerEvent<HTMLElement>) => {
        const session = dragRef.current;
        const timeline = timelineRef.current;
        if (!session || session.pointerId !== event.pointerId || !timeline || !durationMs) return;
        const trackWidth = Math.max(1, timeline.getBoundingClientRect().width);
        const stepPx = event.clientX - session.lastClientX;
        session.lastClientX = event.clientX;
        if (event.shiftKey !== session.wasFineDrag) {
            session.wasFineDrag = event.shiftKey;
            session.rawStartMs = session.lastCommittedRange.startMs;
            session.rawEndMs = session.lastCommittedRange.endMs;
            session.baseRange = session.lastCommittedRange;
            session.accumulatedDeltaMs = 0;
        }
        const scale = event.shiftKey ? INLINE_VIDEO_TRIM_FINE_DRAG_FACTOR : 1;
        const stepMs = (stepPx / trackWidth) * durationMs * scale;
        const disableSnap = event.shiftKey || event.altKey;

        let next: InlineVideoTrimRange;
        if (session.kind === "range") {
            const minDelta = -session.baseRange.startMs;
            const maxDelta = Math.max(0, durationMs - session.baseRange.endMs);
            session.accumulatedDeltaMs = Math.min(maxDelta, Math.max(minDelta, session.accumulatedDeltaMs + stepMs));
            next = moveInlineVideoTrimRange(session.baseRange, session.accumulatedDeltaMs, durationMs);
            setSnappedEdge(null);
        } else if (session.kind === "start") {
            const limitMax = session.rawEndMs - INLINE_VIDEO_TRIM_MIN_MS;
            session.rawStartMs = Math.min(limitMax, Math.max(0, session.rawStartMs + stepMs));
            const snap = snapInlineVideoTrimHandleMs("start", session.rawStartMs, session.rawEndMs, durationMs, trackWidth, { disableSnap });
            const startMs = Math.min(limitMax, snap.valueMs);
            next = normalizeInlineVideoTrimRange({ startMs, endMs: session.rawEndMs }, durationMs);
            setSnappedEdge(snap.snapped && startMs === snap.valueMs ? "start" : null);
        } else {
            const limitMin = session.rawStartMs + INLINE_VIDEO_TRIM_MIN_MS;
            session.rawEndMs = Math.min(durationMs, Math.max(limitMin, session.rawEndMs + stepMs));
            const snap = snapInlineVideoTrimHandleMs("end", session.rawEndMs, session.rawStartMs, durationMs, trackWidth, { disableSnap });
            const endMs = Math.max(limitMin, snap.valueMs);
            next = normalizeInlineVideoTrimRange({ startMs: session.rawStartMs, endMs }, durationMs);
            setSnappedEdge(snap.snapped && endMs === snap.valueMs ? "end" : null);
        }
        session.lastCommittedRange = next;
        applyRange(next, session.kind === "end" ? "end" : "start");
    };

    const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
        const session = dragRef.current;
        if (!session || session.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setSnappedEdge(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    const adjustHandleRange = (edge: "start" | "end", event: KeyboardEvent<HTMLButtonElement>) => {
        if (busy || !durationMs || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        event.stopPropagation();
        const delta = inlineVideoTrimKeyboardStepMs(event) * (event.key === "ArrowLeft" ? -1 : 1);
        const next = normalizeInlineVideoTrimRange(edge === "start"
            ? { ...range, startMs: Math.min(range.startMs + delta, range.endMs - INLINE_VIDEO_TRIM_MIN_MS) }
            : { ...range, endMs: Math.max(range.endMs + delta, range.startMs + INLINE_VIDEO_TRIM_MIN_MS) }, durationMs);
        applyRange(next, edge);
    };

    const togglePlayback = () => {
        const preview = retake ? retakePreviewRef.current : canvasNodeVideo(node.id);
        if (!preview) return;
        if (!preview.paused) {
            preview.pause();
            setPlaying(false);
            return;
        }
        if (preview.currentTime * 1000 < range.startMs || preview.currentTime * 1000 >= range.endMs) preview.currentTime = range.startMs / 1000;
        preview.muted = false;
        void preview.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    };

    const handleConfirm = () => {
        if (!onConfirm || busy || !durationMs) return;
        let finalRange = range;
        if (editingField) {
            const parsedMs = parseInlineVideoTrimTimeMs(draftValue);
            skipBlurCommitRef.current = true;
            setEditingField(null);
            if (parsedMs !== null) {
                finalRange = applyFieldMs(editingField, parsedMs);
                userAdjustedRef.current = true;
                setRange(finalRange);
            }
        }
        onConfirm(finalRange, durationMs);
    };

    const renderTimeField = (field: EditableTimeField) => {
        const isEditing = editingField === field;
        const displayValue = field === "start"
            ? formatInlineVideoTrimPoint(range.startMs)
            : field === "end"
                ? formatInlineVideoTrimPoint(range.endMs)
                : formatInlineVideoTrimDuration(selectedDuration);
        const isSnapped = (field === "start" && snappedEdge === "start") || (field === "end" && snappedEdge === "end");
        const inputAriaLabel = field === "start" ? "输入片段起点时间" : field === "end" ? "输入片段终点时间" : "输入片段时长（秒）";
        const triggerAriaLabel = field === "start"
            ? `片段起点 ${displayValue}，点击手动输入`
            : field === "end"
                ? `片段终点 ${displayValue}，点击手动输入`
                : `所选片段时长 ${displayValue}，点击手动输入`;
        const triggerTitle = field === "duration"
            ? "点击输入时长（秒），如 30 或 29.5"
            : "点击输入时间，如 30 或 00:30.00";

        if (isEditing) {
            return (
                <label className={`canvas-video-trim-time-chip is-editing${field === "duration" ? " is-duration" : ""}`}>
                    {field === "duration" ? <span className="canvas-video-trim-time-prefix">时长</span> : null}
                    <input
                        ref={timeInputRef}
                        type="text"
                        inputMode="decimal"
                        aria-label={inputAriaLabel}
                        className="canvas-video-trim-time-input"
                        value={draftValue}
                        onChange={(event) => setDraftValue(event.target.value)}
                        onKeyDown={(event) => handleFieldKeyDown(field, event)}
                        onBlur={() => handleFieldBlur(field)}
                    />
                    {field === "duration" ? <span className="canvas-video-trim-time-unit" aria-hidden>s</span> : null}
                </label>
            );
        }

        return (
            <button
                ref={(element) => { chipRefs.current[field] = element; }}
                type="button"
                className={`canvas-video-trim-time-chip${field === "duration" ? " is-duration" : ""}${isSnapped ? " is-snapped" : ""}`}
                aria-label={triggerAriaLabel}
                title={triggerTitle}
                disabled={busy || !durationMs}
                onClick={() => openFieldEdit(field)}
            >
                {field === "duration" ? <span className="canvas-video-trim-time-prefix">时长</span> : null}
                <span className="canvas-video-trim-time-value">{displayValue}</span>
            </button>
        );
    };

    const cancelButton = (
        <button type="button" className={retake ? "canvas-video-retake-close" : "canvas-video-trim-icon-button is-cancel"} aria-label={retake ? "取消重拍" : "取消剪辑"} disabled={busy} onClick={onCancel}><X /></button>
    );
    const playbackButton = (
        <button type="button" className={retake ? "canvas-video-retake-play" : "canvas-video-trim-icon-button"} aria-label={playing ? "暂停片段预览" : "播放片段预览"} disabled={retake && (!durationMs || !videoUrl)} onClick={togglePlayback}>{playing ? <Pause /> : <Play />}</button>
    );
    const track = (
        <div className="canvas-video-trim-track">
            {retake ? (
                <div className="canvas-video-retake-range-row">
                    <output className="canvas-video-retake-range" aria-label="重拍时间范围">
                        {durationMs ? `${formatCanvasVideoRetakeTime(range.startMs)}–${formatCanvasVideoRetakeTime(range.endMs)}` : "正在读取视频时长"}
                    </output>
                    {cancelButton}
                </div>
            ) : (
                <div className="canvas-video-trim-timebar" role="group" aria-label="剪辑时间与时长">
                    <div className="canvas-video-trim-endpoints">
                        {renderTimeField("start")}
                        <span className="canvas-video-trim-dash" aria-hidden>—</span>
                        {renderTimeField("end")}
                    </div>
                    <div className="canvas-video-trim-duration-group">
                        {renderTimeField("duration")}
                    </div>
                </div>
            )}
            <div className="canvas-video-trim-timeline" ref={timelineRef} data-video-trim-filmstrip="true">
                <div className="canvas-video-trim-strip" aria-hidden>
                    <div className="canvas-video-trim-frames">
                        {visibleFrames.map((frame, index) => <span key={index} style={frame ? { backgroundImage: `url(${JSON.stringify(frame)})` } : undefined} />)}
                    </div>
                    <div className="canvas-video-trim-dim is-before" style={{ width: `${startPercent}%` }} />
                    <div className="canvas-video-trim-dim is-after" style={{ left: `${endPercent}%` }} />
                </div>
                <button
                    type="button"
                    className="canvas-video-trim-selection"
                    aria-label="移动已选片段"
                    style={{ left: `${startPercent}%`, width: `${Math.max(0, endPercent - startPercent)}%` }}
                    onPointerDown={(event) => beginDrag("range", event)}
                    onPointerMove={continueDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                />
                <button
                    type="button"
                    className={`canvas-video-trim-handle is-start${snappedEdge === "start" ? " is-snapped" : ""}`}
                    aria-label="调整片段起点"
                    title="拖动调整起点（Shift 精细拖动，←/→ 微调）"
                    style={{ left: `${startPercent}%` }}
                    onKeyDown={(event) => adjustHandleRange("start", event)}
                    onPointerDown={(event) => beginDrag("start", event)}
                    onPointerMove={continueDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                ><span /></button>
                <button
                    type="button"
                    className={`canvas-video-trim-handle is-end${snappedEdge === "end" ? " is-snapped" : ""}`}
                    aria-label="调整片段终点"
                    title="拖动调整终点（Shift 精细拖动，←/→ 微调）"
                    style={{ left: `${endPercent}%` }}
                    onKeyDown={(event) => adjustHandleRange("end", event)}
                    onPointerDown={(event) => beginDrag("end", event)}
                    onPointerMove={continueDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                ><span /></button>
                {showFrameStatus ? <span className="canvas-video-trim-frame-status" role="status">{frameStatus === "unavailable" ? "缩略图不可用" : "正在读取缩略图"}</span> : null}
            </div>
        </div>
    );

    return (
        <section
            role="dialog"
            aria-label={retake ? "片段重拍" : "视频片段剪辑"}
            aria-modal="false"
            className={retake ? "canvas-video-retake-panel" : "canvas-video-inline-trim"}
            data-canvas-keyboard-scope
            data-canvas-no-zoom
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {onRetake ? (
                <>
                    <div className="canvas-video-retake-selection">
                        <div className="canvas-video-retake-preview">
                            <video ref={retakePreviewRef} src={videoUrl || undefined} poster={fallbackFrame || visibleFrames[0] || undefined} playsInline preload="metadata" aria-label="所选片段预览" />
                            {playbackButton}
                        </div>
                        {track}
                    </div>
                    <div className="canvas-video-retake-instruction">
                        <textarea aria-label="重拍要求" placeholder="描述这段画面要怎么改" rows={2} value={instruction} onChange={(event) => setInstruction(event.target.value)} />
                        <button
                            type="button"
                            className="canvas-video-retake-submit"
                            disabled={busy || !instruction.trim() || range.endMs - range.startMs < INLINE_VIDEO_TRIM_MIN_MS || range.endMs > durationMs}
                            onClick={() => onRetake(range, durationMs, instruction)}
                        ><span>生成重拍</span></button>
                    </div>
                </>
            ) : (
                <>
                    <div className="canvas-video-trim-leading">
                        {cancelButton}
                        <span className="canvas-video-trim-separator" aria-hidden />
                        {playbackButton}
                    </div>
                    {track}
                    <button
                        type="button"
                        className="canvas-video-trim-confirm"
                        aria-label="确认剪辑"
                        disabled={busy || !durationMs}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={handleConfirm}
                    >{busy ? <LoaderCircle className="animate-spin" /> : <Check />}</button>
                </>
            )}
        </section>
    );
}

function canvasNodeVideo(nodeId: string) {
    if (typeof document === "undefined") return null;
    return document.querySelector<HTMLVideoElement>(`[data-node-id="${CSS.escape(nodeId)}"] video`);
}

function waitForMediaEvent(element: HTMLMediaElement, eventName: "loadedmetadata" | "seeked") {
    if (eventName === "loadedmetadata" && element.readyState >= 1) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const onReady = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error("视频帧读取失败")); };
        const cleanup = () => {
            element.removeEventListener(eventName, onReady);
            element.removeEventListener("error", onError);
        };
        element.addEventListener(eventName, onReady, { once: true });
        element.addEventListener("error", onError, { once: true });
    });
}
