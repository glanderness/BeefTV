import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { createClientId } from "@/lib/client-id";
import { fitNodeSize, VIDEO_NODE_MAX_SIZE } from "@/lib/canvas/canvas-node-size";
import { resourceFileUrl, resourceStorageKey, type RemoteResource } from "@/services/api/resources";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import { useCanvasOwnerLifetime } from "./canvas-owner-epoch";
import { createOwnedCanvasUploadGuard } from "./canvas-upload-ownership";
import type { StartCanvasUploadStatus } from "./use-canvas-upload";

export function useCanvasAssembledNode(options: {
    canvasId: string;
    getCanvasCenter: () => Position;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    selectInsertedNode: (id: string, dialog: "preserve") => void;
    persistMediaNode: (node: CanvasNodeData, signal: AbortSignal) => Promise<boolean>;
    startUploadStatus: StartCanvasUploadStatus;
}) {
    const { canvasId, getCanvasCenter, setNodes, selectInsertedNode, persistMediaNode, startUploadStatus } = options;
    const { lifetime, mountedRef } = useCanvasOwnerLifetime(canvasId);
    const liveCanvasId = useRef(canvasId);
    liveCanvasId.current = canvasId;
    return useCallback(async (resource: RemoteResource, title: string, signal: AbortSignal): Promise<CanvasNodeData | null> => {
        const guard = createOwnedCanvasUploadGuard({ lifetime, canvasId, getLiveCanvasId: () => liveCanvasId.current, mounted: () => mountedRef.current });
        if (!guard.alive() || signal.aborted) return null;
        const progress = startUploadStatus("合成视频片段", "引用已生成的成片资源", 2);
        try {
            const size = fitNodeSize(resource.width || 1280, resource.height || 720, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height);
            const center = getCanvasCenter();
            const node: CanvasNodeData = {
                id: createClientId(), type: CanvasNodeType.Video, title,
                position: { x: center.x - size.width / 2, y: center.y - size.height / 2 }, ...size,
                metadata: {
                    content: resourceFileUrl(resource.id), storageKey: resourceStorageKey(resource.id), status: "success",
                    naturalWidth: resource.width, naturalHeight: resource.height, bytes: resource.size,
                    durationMs: resource.durationMs, mimeType: resource.mimeType,
                },
            };
            setNodes(current => guard.alive() && !signal.aborted ? [...current, node] : current);
            selectInsertedNode(node.id, "preserve");
            progress.update("写入素材记录", 2);
            const persisted = await persistMediaNode(node, AbortSignal.any([signal, guard.signal]));
            if (!guard.alive() || signal.aborted) return null;
            progress.done(persisted ? "已添加新片段并保存素材记录" : "已添加新片段，素材记录待重试");
            return node;
        } catch (error) {
            if (!guard.alive() || signal.aborted) return null;
            progress.fail(error instanceof Error ? error.message : "添加片段失败");
            throw error;
        }
    }, [canvasId, getCanvasCenter, lifetime, mountedRef, persistMediaNode, selectInsertedNode, setNodes, startUploadStatus]);
}
