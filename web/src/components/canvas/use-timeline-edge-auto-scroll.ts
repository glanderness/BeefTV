import { useCallback, useEffect, useRef, type RefObject } from "react";

const DEFAULT_EDGE_ZONE_PX = 32;
const DEFAULT_SPEED_FACTOR = 0.85;

/**
 * 标尺拖拽与轨道片段拖拽共用的边缘连续自动横滚（requestAnimationFrame 驱动）：
 * 当指针停在轨道滚动容器左右边缘内侧或越过边缘时，即使指针静止不再触发 pointermove，
 * 仍按帧持续滚动并通过回调同步更新当前位置。
 */
export function useTimelineEdgeAutoScroll(
    scrollContainerRef: RefObject<HTMLDivElement | null> | undefined,
    options?: { edgeZonePx?: number; speedFactor?: number },
) {
    const edgeZone = options?.edgeZonePx ?? DEFAULT_EDGE_ZONE_PX;
    const speedFactor = options?.speedFactor ?? DEFAULT_SPEED_FACTOR;
    const frameRef = useRef<number | null>(null);
    const activeClientXRef = useRef<number | null>(null);
    const onStepCallbackRef = useRef<((clientX: number) => void) | null>(null);

    const stopEdgeAutoScroll = useCallback(() => {
        if (frameRef.current !== null) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        }
        activeClientXRef.current = null;
        onStepCallbackRef.current = null;
    }, []);

    const stepContainerScroll = useCallback(
        (clientX: number): boolean => {
            const container = scrollContainerRef?.current;
            if (!container) return false;
            const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
            if (maxScroll <= 0) return false;
            const rect = container.getBoundingClientRect();
            if (clientX < rect.left + edgeZone && container.scrollLeft > 0) {
                const step = Math.max(8, Math.ceil((rect.left + edgeZone - clientX) * speedFactor));
                container.scrollLeft = Math.max(0, container.scrollLeft - step);
                return container.scrollLeft > 0;
            }
            if (clientX > rect.right - edgeZone && container.scrollLeft < maxScroll) {
                const step = Math.max(8, Math.ceil((clientX - (rect.right - edgeZone)) * speedFactor));
                container.scrollLeft = Math.min(maxScroll, container.scrollLeft + step);
                return container.scrollLeft < maxScroll;
            }
            return false;
        },
        [edgeZone, scrollContainerRef, speedFactor],
    );

    const updateEdgeAutoScroll = useCallback(
        (clientX: number, onStep: (clientX: number) => void, allowScroll = true) => {
            activeClientXRef.current = clientX;
            onStepCallbackRef.current = onStep;
            if (!allowScroll) {
                if (frameRef.current !== null) {
                    cancelAnimationFrame(frameRef.current);
                    frameRef.current = null;
                }
                onStep(clientX);
                return;
            }
            const shouldContinue = stepContainerScroll(clientX);
            onStep(clientX);
            if (!shouldContinue) {
                if (frameRef.current !== null) {
                    cancelAnimationFrame(frameRef.current);
                    frameRef.current = null;
                }
                return;
            }
            if (frameRef.current === null) {
                const tick = () => {
                    frameRef.current = null;
                    const heldX = activeClientXRef.current;
                    const cb = onStepCallbackRef.current;
                    if (heldX === null || !cb) return;
                    const more = stepContainerScroll(heldX);
                    cb(heldX);
                    if (more) {
                        frameRef.current = requestAnimationFrame(tick);
                    }
                };
                frameRef.current = requestAnimationFrame(tick);
            }
        },
        [stepContainerScroll],
    );

    useEffect(() => () => stopEdgeAutoScroll(), [stopEdgeAutoScroll]);

    return { updateEdgeAutoScroll, stopEdgeAutoScroll };
}
