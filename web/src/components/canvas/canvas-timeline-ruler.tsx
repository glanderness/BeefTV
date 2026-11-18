// 时间线标尺：按缩放渲染刻度与播放头，点击/拖拽设置播放头时间。

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

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
    const lastClientXRef = useRef<number | null>(null);
    const edgeScrollFrameRef = useRef<number | null>(null);
    const [scrubbing, setScrubbing] = useState(false);

    const ticks = useMemo(() => {
        const stepMs = getRulerTickStep(pxPerMs);
        const count = Math.max(1, Math.ceil(durationMs / stepMs));
        return Array.from({ length: count + 1 }, (_, index) => {
            const ms = index * stepMs;
            const x = Math.round(ms * pxPerMs);
            return { ms, x, major: index % 5 === 0 };
        });
    }, [durationMs, pxPerMs]);

    const stopEdgeScroll = useCallback(() => {
        if (edgeScrollFrameRef.current !== null) {
            cancelAnimationFrame(edgeScrollFrameRef.current);
            edgeScrollFrameRef.current = null;
        }
    }, []);

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

    const applyEdgeScrollStep = useCallback(
        (clientX: number): boolean => {
            const container = scrollContainerRef?.current;
            if (!container || activePointerIdRef.current === null) return false;
            const containerRect = container.getBoundingClientRect();
            const edgeZone = 32;
            if (clientX < containerRect.left + edgeZone && container.scrollLeft > 0) {
                const step = Math.max(8, Math.ceil((containerRect.left + edgeZone - clientX) * 0.85));
                container.scrollLeft = Math.max(0, container.scrollLeft - step);
                return container.scrollLeft > 0;
            }
            if (clientX > containerRect.right - edgeZone) {
                const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
                if (container.scrollLeft < maxScroll) {
                    const step = Math.max(8, Math.ceil((clientX - (containerRect.right - edgeZone)) * 0.85));
                    container.scrollLeft = Math.min(maxScroll, container.scrollLeft + step);
                    return container.scrollLeft < maxScroll;
                }
            }
            return false;
        },
        [scrollContainerRef],
    );

    const seekFromClientX = useCallback(
        (clientX: number, allowEdgeScroll: boolean) => {
            lastClientXRef.current = clientX;
            if (!allowEdgeScroll) {
                stopEdgeScroll();
                computeSeekAtClientX(clientX);
                return;
            }
            const shouldContinue = applyEdgeScrollStep(clientX);
            computeSeekAtClientX(clientX);
            if (!shouldContinue) {
                stopEdgeScroll();
                return;
            }
            if (edgeScrollFrameRef.current === null) {
                const tick = () => {
                    edgeScrollFrameRef.current = null;
                    const heldX = lastClientXRef.current;
                    if (activePointerIdRef.current === null || heldX === null) return;
                    const more = applyEdgeScrollStep(heldX);
                    computeSeekAtClientX(heldX);
                    if (more) edgeScrollFrameRef.current = requestAnimationFrame(tick);
                };
                edgeScrollFrameRef.current = requestAnimationFrame(tick);
            }
        },
        [applyEdgeScrollStep, computeSeekAtClientX, stopEdgeScroll],
    );

    const finishScrub = useCallback(
        (pointerId?: number) => {
            const capturedId = activePointerIdRef.current;
            if (capturedId === null) return;
            if (pointerId !== undefined && pointerId !== capturedId) return;
            activePointerIdRef.current = null;
            lastClientXRef.current = null;
            stopEdgeScroll();
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
        [stopEdgeScroll],
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
            lastClientXRef.current = null;
            stopEdgeScroll();
        },
        [stopEdgeScroll],
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
