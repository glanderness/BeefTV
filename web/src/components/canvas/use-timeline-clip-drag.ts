import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { useTimelineEdgeAutoScroll } from "@/components/canvas/use-timeline-edge-auto-scroll";
import { canPlaceAt, clampClipDurationByNeighbors, planClipMove, resolveLeftClampedClipMove } from "@/lib/timeline/timeline-placement";
import { computeSnap } from "@/lib/timeline/timeline-snap";
import { MIN_CLIP_DURATION_MS } from "@/lib/timeline/timeline-view";
import type { TimelineClip, TimelineProject } from "@/types/timeline";

const SNAP_THRESHOLD_PX = 8;

export type ClipDragMode = "move" | "trim-start" | "trim-end";

type DragState =
    | { mode: "move"; pointerId: number; startScrollLeft: number; captureElement: HTMLElement | null; clipId: string; startClientX: number; originalStartMs: number; clips: TimelineClip[]; beforeDraft: TimelineProject }
    | { mode: "trim-start"; pointerId: number; startScrollLeft: number; captureElement: HTMLElement | null; clipId: string; startClientX: number; originalStartMs: number; originalDurationMs: number; originalSourceStartMs: number; beforeDraft: TimelineProject }
    | { mode: "trim-end"; pointerId: number; startScrollLeft: number; captureElement: HTMLElement | null; clipId: string; startClientX: number; originalStartMs: number; originalDurationMs: number; beforeDraft: TimelineProject }
    | null;

type UseTimelineClipDragOptions = {
    open: boolean;
    draft: TimelineProject;
    playheadMs: number;
    pxPerMs: number;
    snapEnabled: boolean;
    trackAreaRef: RefObject<HTMLDivElement | null>;
    onSelectClip: (clipId: string) => void;
    replaceDraft: (updater: (current: TimelineProject) => TimelineProject) => void;
    recordSnapshot: (beforeGesture: TimelineProject) => void;
};

/** 管理时间线片段拖动移动与左右边缘裁剪，拖动期间免入历史，松手时整体提交单步撤销快照。 */
export function useTimelineClipDrag({
    open,
    draft,
    playheadMs,
    pxPerMs,
    snapEnabled,
    trackAreaRef,
    onSelectClip,
    replaceDraft,
    recordSnapshot,
}: UseTimelineClipDragOptions) {
    const [clipDragging, setClipDragging] = useState(false);
    const dragRef = useRef<DragState>(null);
    const { updateEdgeAutoScroll, stopEdgeAutoScroll } = useTimelineEdgeAutoScroll(trackAreaRef);

    const updateClipTransient = (clipId: string, patch: Partial<TimelineClip>) => {
        replaceDraft((current) => ({
            ...current,
            clips: current.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)),
        }));
    };

    const moveClip = (clipId: string, candidateStartMs: number, snapshot: TimelineClip[]) => {
        const clip = snapshot.find((item) => item.id === clipId);
        if (!clip) return;
        const clampedCandidateMs = Math.max(0, candidateStartMs);
        const snapped = snapEnabled
            ? computeSnap({ candidateMs: clampedCandidateMs, playheadMs, clips: snapshot, excludeClipId: clipId, pxPerMs, thresholdPx: SNAP_THRESHOLD_PX, enabled: true })
            : { snappedMs: clampedCandidateMs, targets: [] };
        const nextStartMs = Math.max(0, Math.round(snapped.snappedMs));
        let placement = planClipMove({ clipId, trackId: clip.trackId, startMs: nextStartMs, durationMs: clip.durationMs, clips: snapshot });
        if (!placement && nextStartMs < clip.startMs) {
            placement = resolveLeftClampedClipMove({ clipId, trackId: clip.trackId, startMs: nextStartMs, durationMs: clip.durationMs, clips: snapshot });
        }
        if (!placement) return;
        const snapshotStarts = new Map(snapshot.map((item) => [item.id, item.startMs]));
        replaceDraft((current) => ({
            ...current,
            clips: current.clips.map((item) => {
                const baselineStartMs = snapshotStarts.get(item.id);
                if (baselineStartMs === undefined) return item;
                return { ...item, startMs: placement.get(item.id) ?? baselineStartMs };
            }),
        }));
    };

    const trimClipStart = (clipId: string, deltaMs: number, original: { startMs: number; durationMs: number; sourceStartMs: number }) => {
        const clip = draft.clips.find((item) => item.id === clipId);
        if (!clip) return;
        const rightEdgeMs = original.startMs + original.durationMs;
        const isImage = clip.kind === "image";
        const minStartMs = isImage || clip.sourceStartMs === undefined ? 0 : Math.max(0, original.startMs - original.sourceStartMs);
        const newStartMs = Math.max(minStartMs, Math.min(rightEdgeMs - MIN_CLIP_DURATION_MS, original.startMs + deltaMs));
        const newDurationMs = rightEdgeMs - newStartMs;
        const sourceDurationMs = isImage ? undefined : clip.sourceDurationMs;
        let sourceStartMs = original.sourceStartMs + (newStartMs - original.startMs);
        if (sourceDurationMs !== undefined) {
            sourceStartMs = Math.max(0, Math.min(Math.max(0, sourceDurationMs - newDurationMs), sourceStartMs));
        }
        const collision = canPlaceAt({ trackId: clip.trackId, startMs: newStartMs, durationMs: newDurationMs, excludeClipId: clipId, clips: draft.clips });
        if (!collision.ok) return;
        updateClipTransient(clipId, {
            startMs: Math.round(newStartMs),
            durationMs: Math.round(newDurationMs),
            ...(!isImage && clip.sourceStartMs !== undefined ? { sourceStartMs: Math.round(sourceStartMs) } : {}),
        });
    };

    const trimClipEnd = (clipId: string, deltaMs: number, original: { startMs: number; durationMs: number }) => {
        const clip = draft.clips.find((item) => item.id === clipId);
        if (!clip) return;
        const isImage = clip.kind === "image";
        const maxDurationMs = !isImage && clip.sourceDurationMs !== undefined && clip.sourceStartMs !== undefined
            ? Math.max(0, clip.sourceDurationMs - clip.sourceStartMs)
            : undefined;
        const maxDuration = clampClipDurationByNeighbors({
            clipId,
            startMs: original.startMs,
            requestedDurationMs: original.durationMs + deltaMs,
            trackId: clip.trackId,
            clips: draft.clips,
            maxDurationMs,
        });
        updateClipTransient(clipId, { durationMs: Math.round(Math.max(MIN_CLIP_DURATION_MS, maxDuration)) });
    };

    const applyClipPointerMoveRef = useRef<(pointerId: number, clientX: number) => void>(() => undefined);

    const finishClipDrag = useCallback((pointerId?: number) => {
        const drag = dragRef.current;
        if (!drag) return;
        if (pointerId !== undefined && drag.pointerId !== pointerId) return;
        dragRef.current = null;
        stopEdgeAutoScroll();
        setClipDragging(false);
        recordSnapshot(drag.beforeDraft);
        const captureEl = drag.captureElement;
        if (captureEl?.hasPointerCapture?.(drag.pointerId)) {
            try {
                captureEl.releasePointerCapture(drag.pointerId);
            } catch {
                // 指针已释放或未捕获时忽略
            }
        }
    }, [recordSnapshot, stopEdgeAutoScroll]);

    useEffect(() => {
        if (!clipDragging) return;
        const onWindowPointerMove = (event: PointerEvent) => applyClipPointerMoveRef.current(event.pointerId, event.clientX);
        const onWindowPointerEnd = (event: PointerEvent) => finishClipDrag(event.pointerId);
        const onWindowBlur = () => finishClipDrag();
        window.addEventListener("pointermove", onWindowPointerMove);
        window.addEventListener("pointerup", onWindowPointerEnd);
        window.addEventListener("pointercancel", onWindowPointerEnd);
        window.addEventListener("blur", onWindowBlur);
        return () => {
            window.removeEventListener("pointermove", onWindowPointerMove);
            window.removeEventListener("pointerup", onWindowPointerEnd);
            window.removeEventListener("pointercancel", onWindowPointerEnd);
            window.removeEventListener("blur", onWindowBlur);
        };
    }, [clipDragging, finishClipDrag]);

    useEffect(() => {
        if (!open) finishClipDrag();
        return () => finishClipDrag();
    }, [finishClipDrag, open]);

    const handleClipPointerDown = (event: ReactPointerEvent<HTMLDivElement>, clipId: string, mode: ClipDragMode) => {
        const clip = draft.clips.find((item) => item.id === clipId);
        if (!clip) return;
        event.preventDefault();
        event.stopPropagation();
        const targetEl = event.currentTarget as HTMLElement;
        const captureElement = targetEl.closest<HTMLElement>("[data-timeline-clip-id]") ?? targetEl;
        try {
            captureElement.setPointerCapture(event.pointerId);
        } catch {
            // 合成指针环境不支持捕获时忽略
        }
        const startScrollLeft = trackAreaRef.current?.scrollLeft ?? 0;
        onSelectClip(clipId);
        setClipDragging(true);
        if (mode === "move") {
            dragRef.current = { mode, pointerId: event.pointerId, startScrollLeft, captureElement, clipId, startClientX: event.clientX, originalStartMs: clip.startMs, clips: draft.clips, beforeDraft: draft };
        } else if (mode === "trim-start") {
            dragRef.current = {
                mode, pointerId: event.pointerId, startScrollLeft, captureElement, clipId, startClientX: event.clientX,
                originalStartMs: clip.startMs, originalDurationMs: clip.durationMs, originalSourceStartMs: clip.sourceStartMs || 0, beforeDraft: draft,
            };
        } else {
            dragRef.current = { mode, pointerId: event.pointerId, startScrollLeft, captureElement, clipId, startClientX: event.clientX, originalStartMs: clip.startMs, originalDurationMs: clip.durationMs, beforeDraft: draft };
        }
    };

    const applyClipStepAtClientX = (clientX: number) => {
        const drag = dragRef.current;
        if (!drag) return;
        const container = trackAreaRef.current;
        const scrollDeltaPx = (container?.scrollLeft ?? 0) - drag.startScrollLeft;
        const deltaMs = Math.round((clientX - drag.startClientX + scrollDeltaPx) / Math.max(pxPerMs, 1e-6));
        if (drag.mode === "move") moveClip(drag.clipId, drag.originalStartMs + deltaMs, drag.clips);
        else if (drag.mode === "trim-start") trimClipStart(drag.clipId, deltaMs, { startMs: drag.originalStartMs, durationMs: drag.originalDurationMs, sourceStartMs: drag.originalSourceStartMs });
        else trimClipEnd(drag.clipId, deltaMs, { startMs: drag.originalStartMs, durationMs: drag.originalDurationMs });
    };

    const applyClipPointerMove = (pointerId: number, clientX: number) => {
        const drag = dragRef.current;
        if (!drag || pointerId !== drag.pointerId) return;
        const allowScroll = (clientX < drag.startClientX && (trackAreaRef.current?.scrollLeft ?? 0) > 0) || clientX > drag.startClientX;
        updateEdgeAutoScroll(clientX, applyClipStepAtClientX, allowScroll);
    };
    applyClipPointerMoveRef.current = applyClipPointerMove;

    return {
        handleClipPointerDown,
        handleClipPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => applyClipPointerMove(event.pointerId, event.clientX),
        handleClipPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => finishClipDrag(event.pointerId),
    };
}
