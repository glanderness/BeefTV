import type { CanvasNodeData } from "@/types/canvas";

/** Apply an attempt's output state without reverting edits made while it prepared. */
export function rebaseCanvasGenerationTarget(live: CanvasNodeData, planned: CanvasNodeData, captured: CanvasNodeData | undefined): CanvasNodeData {
    const metadata = { ...live.metadata, ...planned.metadata };
    for (const key of ["prompt", "composerContent"] as const) {
        if (live.metadata?.[key] !== captured?.metadata?.[key]) metadata[key] = live.metadata?.[key];
    }
    return { ...live, metadata };
}
