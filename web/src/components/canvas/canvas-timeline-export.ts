import { exportTimelineToMp4 } from "@/lib/timeline/timeline-export";
import { resolveEffectiveOutputOptions } from "@/lib/timeline/timeline-output-presets";
import { getVisibleMediaClips, type TimelineRenderSource } from "@/lib/timeline/timeline-to-ffmpeg";
import { normalizeTimelineProject } from "@/lib/timeline/timeline-tracks";
import { ApiError, getTransportFailureKind } from "@/services/api/request";
import { ownedResourceIdFromMediaRef, resourceIdFromStorageKey } from "@/services/api/resources";
import { cancelGenerationTask } from "@/services/api/task-center";
import {
    beginLocalExecutorSession,
    isLocalExecutorSessionStop,
    nextLocalExecutorClientOperationId,
    runOwnedTimelineRender,
} from "@/services/local-executor-session";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineClip, TimelineProject } from "@/types/timeline";

export {
    TIMELINE_FPS_OPTIONS,
    TIMELINE_OUTPUT_PRESETS,
    applyOutputPreset,
    getOutputPresetKey,
    resolveEffectiveOutputOptions,
    type TimelineOutputPresetKey,
} from "@/lib/timeline/timeline-output-presets";

function clipHasBackendResource(clip: TimelineClip, nodes: CanvasNodeData[]): boolean {
    if (clip.directMedia) {
        return Boolean(resourceIdFromStorageKey(clip.directMedia.storageKey));
    }
    const node = nodes.find((item) => item.id === clip.nodeId);
    if (!node) return false;
    return Boolean(
        resourceIdFromStorageKey(node.metadata?.storageKey)
        || ownedResourceIdFromMediaRef(node.metadata?.storageKey, node.metadata?.content),
    );
}

/** 仅当存在画布/项目 ID 且所有可见媒体片段均有后端资源归属时，优先走 Go 原生 ffmpeg 渲染。 */
export function canUseNativeTimelineRender(
    projectId: string | undefined,
    draft: TimelineProject,
    nodes: CanvasNodeData[],
): boolean {
    if (!projectId?.trim()) return false;
    const mediaClips = getVisibleMediaClips(draft);
    if (!mediaClips.length) return false;
    return mediaClips.every((clip) => clipHasBackendResource(clip, nodes));
}

/** 仅在本地执行器明确不可用或离线/浏览器单机模式下回退 ffmpeg.wasm，绝不吞掉真实校验/渲染错误。 */
export function shouldFallbackToBrowserWasm(error: unknown): boolean {
    if (isLocalExecutorSessionStop(error)) return false;
    if (error instanceof ApiError) {
        if (error.reason === "local_executor_unavailable" || error.reason === "timeline_render_unavailable") return true;
        if (error.status === 404 || error.status === 501) return true;
        if (error.status === 503 && (error.reason === "service_unavailable" || error.reason === "unavailable")) return true;
    }
    return getTransportFailureKind(error) === "network";
}

function extensionForClipSource(clip: TimelineClip, sourceNode?: CanvasNodeData): string {
    const mime = (clip.directMedia?.mimeType || sourceNode?.metadata?.mimeType || "").toLowerCase().split(";")[0].trim();
    const map: Record<string, string> = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
        "video/x-m4v": ".m4v",
        "video/webm": ".webm",
        "video/x-matroska": ".mkv",
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mp4": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/aac": ".aac",
        "audio/flac": ".flac",
        "audio/ogg": ".ogg",
        "audio/opus": ".opus",
    };
    if (map[mime]) return map[mime];
    if (clip.kind === "image") return ".png";
    if (clip.kind === "audio") return ".mp3";
    return ".mp4";
}

export function buildBrowserRenderSources(draft: TimelineProject, nodes: CanvasNodeData[]): TimelineRenderSource[] {
    const mediaClips = getVisibleMediaClips(draft);
    const sources: TimelineRenderSource[] = [];
    for (const clip of mediaClips) {
        const sourceNode = nodes.find((item) => item.id === clip.nodeId);
        const media = clip.directMedia;
        if (sources.some((source) => source.nodeId === clip.nodeId)) continue;
        if (!sourceNode && !media) throw new Error("找不到素材：" + (clip.title || clip.nodeId));
        const ext = extensionForClipSource(clip, sourceNode);
        sources.push({
            nodeId: clip.nodeId,
            fileName: `input-${sources.length}${ext}`,
            durationMs: clip.sourceDurationMs || clip.durationMs,
            storageKey: media ? media.storageKey : sourceNode?.metadata?.storageKey,
            url: media ? media.url || media.dataUrl || media.content : sourceNode?.metadata?.content || undefined,
        });
    }
    if (!sources.length) throw new Error("找不到素材");
    return sources;
}

export type TimelineRenderOutcome =
    | {
          mode: "native";
          resourceId: string;
          fileName: string;
          durationMs?: number;
          width?: number;
          height?: number;
          size?: number;
      }
    | {
          mode: "blob";
          blob: Blob;
      };

export async function executeTimelineRender(params: {
    projectId?: string;
    draft: TimelineProject;
    nodes: CanvasNodeData[];
    controller: AbortController;
    onProgress: (percent: number, detail: string) => void;
}): Promise<TimelineRenderOutcome> {
    const { projectId, draft, nodes, controller, onProgress } = params;
    const normalized = normalizeTimelineProject(draft);
    const mediaClips = getVisibleMediaClips(normalized);
    if (!mediaClips.length) throw new Error("时间线没有可渲染的媒体片段");
    const effectiveOptions = resolveEffectiveOutputOptions(normalized, nodes);

    if (canUseNativeTimelineRender(projectId, normalized, nodes)) {
        const ownedProjectId = projectId!.trim();
        let createdTaskId = "";
        const onAbort = () => {
            if (createdTaskId) void cancelGenerationTask(createdTaskId).catch(() => undefined);
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        try {
            onProgress(5, "提交本地原生渲染任务…");
            const session = beginLocalExecutorSession(ownedProjectId, {
                controller,
                getLiveProjectId: () => ownedProjectId,
            });
            const { result } = await runOwnedTimelineRender({
                session,
                projectId: ownedProjectId,
                timeline: normalized,
                options: effectiveOptions,
                clientOperationId: nextLocalExecutorClientOperationId(null),
                intervalMs: 1000,
                onCreated: (task) => {
                    createdTaskId = task.id;
                    onProgress(Math.max(5, task.progress || 5), task.stage || "时间线渲染任务已进入队列");
                },
                onTaskUpdate: (task) => {
                    onProgress(Math.min(99, Math.max(5, task.progress || 5)), task.stage || "正在本地渲染…");
                },
            });
            onProgress(100, "本地渲染完成");
            return {
                mode: "native",
                resourceId: result.resourceId,
                fileName: result.fileName || "timeline-render.mp4",
                durationMs: result.durationMs,
                width: effectiveOptions.width,
                height: effectiveOptions.height,
                size: result.size,
            };
        } catch (error) {
            if (controller.signal.aborted || isLocalExecutorSessionStop(error)) {
                throw new DOMException("导出已取消", "AbortError");
            }
            if (!shouldFallbackToBrowserWasm(error)) {
                throw error;
            }
            onProgress(0, "本地执行器不可用，改用浏览器导出…");
        } finally {
            controller.signal.removeEventListener("abort", onAbort);
        }
    }

    const sources = buildBrowserRenderSources(normalized, nodes);
    const blob = await exportTimelineToMp4(normalized, sources, {
        signal: controller.signal,
        context: {
            width: effectiveOptions.width,
            height: effectiveOptions.height,
            fps: effectiveOptions.fps,
            sampleRate: effectiveOptions.sampleRate,
            burnSubtitles: effectiveOptions.burnSubtitles,
        },
        onProgress: ({ percent, detail }) => onProgress(percent, detail),
    });
    if (controller.signal.aborted) throw new DOMException("导出已取消", "AbortError");
    return { mode: "blob", blob };
}
