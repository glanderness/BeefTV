// 时间线标尺：按缩放渲染刻度与播放头，点击/拖拽设置播放头时间。

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { useTimelineEdgeAutoScroll } from "@/components/canvas/use-timeline-edge-auto-scroll";
import { formatTimelineTime, getRulerTickStep } from "@/lib/timeline/timeline-view";
import type { CanvasTheme } from "@/lib/canvas-theme";

type CanvasTimelineRulerProps = {
    pxPerMs: number;
    durationMs: number;
    playheadMs: number;
    width: number;
    theme: CanvasTheme;
    scrollContainerRef?: RefObject<HTMLDivElement | null>;
    onSeek: (ms: number) => void;
};

export function CanvasTimelineRuler({ pxPerMs, durationMs, playheadMs, width: _width, theme, scrollContainerRef, onSeek }: CanvasTimelineRulerProps) {
    const barRef = useRef<HTMLDivElement>(null);
    const activePointerIdRef = useRef<number | null>(null);
    const [scrubbing, setScrubbing] = useState(false);
    const { updateEdgeAutoScroll, stopEdgeAutoScroll } = useTimelineEdgeAutoScroll(scrollContainerRef);

    const ticks = useMemo(() => {
        const stepMs = getRulerTickStep(pxPerMs);
        const count = Math.max(1, Math.ceil(durationMs / stepMs));
        return Array.from({ length: count + 1 }, (_, index) => {
            const ms = index * stepMs;
            const x = Math.round(ms * pxPerMs);
            return { ms, x, major: index % 5 === 0 };
        });
    }, [durationMs, pxPerMs]);

    const computeSeekAtClientX = useCallback(
        (clientX: number) => {
            const rect = barRef.current?.getBoundingClientRect();
            if (!rect) return;
            const offsetX = clientX - rect.left;
            const safeDurationMs = Math.max(0, durationMs);
            const nextMs = Math.min(safeDurationMs, Math.max(0, Math.round(offsetX / Math.max(pxPerMs, 1e-6))));
            onSeek(nextMs);
        },
        [durationMs, onSeek, pxPerMs],
    );

    const seekFromClientX = useCallback(
        (clientX: number, allowEdgeScroll: boolean) => {
            updateEdgeAutoScroll(clientX, computeSeekAtClientX, allowEdgeScroll && activePointerIdRef.current !== null);
        },
        [computeSeekAtClientX, updateEdgeAutoScroll],
    );

    const finishScrub = useCallback(
        (pointerId?: number) => {
            const capturedId = activePointerIdRef.current;
            if (capturedId === null) return;
            if (pointerId !== undefined && pointerId !== capturedId) return;
            activePointerIdRef.current = null;
            stopEdgeAutoScroll();
            setScrubbing(false);
            const el = barRef.current;
            if (el?.hasPointerCapture?.(capturedId)) {
                try {
                    el.releasePointerCapture(capturedId);
                } catch {
                    // 指针捕获已释放时忽略
                }
            }
        },
        [stopEdgeAutoScroll],
    );

    useEffect(() => {
        if (!scrubbing) return;
        const onWindowPointerMove = (event: PointerEvent) => {
            if (activePointerIdRef.current === null || event.pointerId !== activePointerIdRef.current) return;
            seekFromClientX(event.clientX, true);
        };
        const onWindowPointerEnd = (event: PointerEvent) => finishScrub(event.pointerId);
        const onWindowBlur = () => finishScrub();
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
    }, [finishScrub, scrubbing, seekFromClientX]);

    useEffect(
        () => () => {
            activePointerIdRef.current = null;
            stopEdgeAutoScroll();
        },
        [stopEdgeAutoScroll],
    );

    const clampedPlayheadMs = Math.min(Math.max(0, durationMs), Math.max(0, playheadMs));

    return (
        <div
            ref={barRef}
            data-timeline-ruler
            data-scrubbing={scrubbing ? "true" : undefined}
            className="relative shrink-0 cursor-col-resize touch-none select-none overflow-hidden border-b"
            style={{ height: 32, borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
            onPointerDown={(event) => {
                event.preventDefault();
                activePointerIdRef.current = event.pointerId;
                setScrubbing(true);
                try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                    // 合成指针环境不支持捕获时忽略
                }
                seekFromClientX(event.clientX, false);
            }}
            onPointerMove={(event) => {
                if (activePointerIdRef.current === null || event.pointerId !== activePointerIdRef.current) return;
                seekFromClientX(event.clientX, true);
            }}
            onPointerUp={(event) => finishScrub(event.pointerId)}
            onPointerCancel={(event) => finishScrub(event.pointerId)}
            onLostPointerCapture={(event) => finishScrub(event.pointerId)}
        >
            {ticks.map((tick) => (
                <div key={tick.ms} className="absolute top-0 h-full" style={{ left: tick.x }}>
                    <div className="absolute top-0 w-px" style={{ height: tick.major ? 10 : 5, background: theme.timeline.rulerTick }} />
                    {tick.major ? (
                        <span className="absolute left-1 top-1 whitespace-nowrap text-[var(--fs-label)] leading-none tabular-nums opacity-60" style={{ color: theme.timeline.rulerLabel }}>
                            {formatTimelineTime(tick.ms)}
                        </span>
                    ) : null}
                </div>
            ))}
            <div className="pointer-events-none absolute bottom-0 top-0" style={{ left: Math.round(clampedPlayheadMs * pxPerMs), width: 2, background: theme.timeline.playhead }}>
                <span className="absolute -top-0.5 left-1 whitespace-nowrap text-[var(--fs-label)] font-semibold leading-none tabular-nums" style={{ color: theme.timeline.playhead }}>
                    {formatTimelineTime(clampedPlayheadMs)}
                </span>
            </div>
        </div>
    );
}
