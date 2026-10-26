import type { CanvasNodeData } from "@/types/canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { getDiagnosticTraceId, recordDiagnosticEvent } from "./client-diagnostics";

export function canvasNodeDiagnosticContext(node: Pick<CanvasNodeData, "metadata"> & { id?: string }) {
    const candidates = useCanvasStore.getState().projects.filter(project => project.nodes.some(item => item.id === node.id && item.metadata?.taskId === node.metadata?.taskId));
    return { nodeId: node.id, taskId: node.metadata?.taskId, clientOperationId: node.metadata?.taskClientOperationId, canvasId: candidates.length === 1 ? candidates[0].id : undefined, traceId: getDiagnosticTraceId(node.metadata?.taskId) };
}

export function recordCanvasVideoDiagnostic(node: CanvasNodeData, phase: "load_requested" | "metadata_loaded" | "first_frame" | "playback_failed" | "source_failed" | "load_stalled", video?: HTMLVideoElement | null) {
    recordDiagnosticEvent({
        ...canvasNodeDiagnosticContext(node), category: "runtime", level: phase.endsWith("failed") ? "error" : phase === "load_stalled" ? "warning" : "info",
        code: `canvas_video_${phase}`, message: `画布视频：${phase}`,
        media: { phase, readyState: video?.readyState, networkState: video?.networkState, errorCode: video?.error?.code, width: video?.videoWidth, height: video?.videoHeight },
    });
}

/**
 * 静态首帧的取帧失败以前是完全静默的（只丢一个 null），在真实客户端里无法判断
 * 是没触发、取地址失败，还是截帧失败。这里把原因记进诊断事件。
 */
export function recordCanvasVideoPreviewDiagnostic(
    node: Pick<CanvasNodeData, "metadata"> & { id?: string },
    phase: "source_missing" | "capture_empty" | "capture_failed" | "capacity_exhausted",
    error?: unknown,
) {
    recordDiagnosticEvent({
        ...canvasNodeDiagnosticContext(node), category: "runtime", level: phase === "capture_failed" ? "error" : "warning",
        code: `canvas_video_preview_${phase}`,
        message: `画布视频首帧：${phase}${error instanceof Error ? ` · ${error.name}` : ""}`,
    });
}
