import { buildCanvasMediaDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { ownedResourceIdFromMediaRef } from "@/services/api/resources";
import type { CanvasNodeData } from "@/types/canvas";

export async function copyVideoToSystemClipboard(node: CanvasNodeData) {
    const copy = typeof window === "undefined" ? undefined : window.go?.main?.DesktopApp?.CopyOwnedMediaToClipboard;
    if (!copy) throw new Error("当前环境不支持复制视频文件，请使用最新版 BeefTV 桌面端");
    const resourceId = ownedResourceIdFromMediaRef(node.metadata?.storageKey, node.metadata?.content);
    if (!resourceId) throw new Error("没有可复制的本机视频文件，请先将视频导入本地素材库");
    await copy(buildCanvasMediaDownloadFileName(node), resourceId);
}
