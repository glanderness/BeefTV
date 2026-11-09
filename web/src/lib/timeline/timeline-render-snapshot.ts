import { ownedResourceIdFromMediaRef, resourceStorageKey } from "@/services/api/resources";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineProject } from "@/types/timeline";
import { getVisibleMediaClips } from "./timeline-to-ffmpeg";
import { normalizeTimelineProject } from "./timeline-tracks";

/** The renderer reads owned resources, never live canvas nodes or browser blobs. */
export function prepareTimelineRenderSnapshot(draft: TimelineProject, nodes: CanvasNodeData[]): TimelineProject {
    const snapshot = structuredClone(normalizeTimelineProject(draft));
    const clips = getVisibleMediaClips(snapshot);
    if (!clips.length) throw new Error("时间线没有可渲染的媒体片段");
    const byId = new Map(nodes.map(node => [node.id, node]));
    for (const clip of clips) {
        const node = byId.get(clip.nodeId);
        const media = clip.directMedia;
        const resourceId = media
            ? ownedResourceIdFromMediaRef(media.storageKey, media.url || media.dataUrl || media.content)
            : ownedResourceIdFromMediaRef(node?.metadata?.storageKey, node?.metadata?.content);
        const title = clip.title || media?.title || node?.title || clip.nodeId;
        if (!resourceId) throw new Error(`请先保存素材「${title}」到后端资源，再导出成片`);
        clip.directMedia = {
            id: media?.id || clip.nodeId,
            kind: clip.kind as "video" | "audio" | "image",
            title,
            storageKey: resourceStorageKey(resourceId),
            assetId: media ? media.assetId : node?.metadata?.assetId,
        };
    }
    return snapshot;
}
