import { saveAs } from "file-saver";

import { buildCanvasMediaDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { desktopResourceExporter, type DesktopExportResult } from "@/services/desktop-runtime";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type CanvasMediaExportDependencies = {
    desktopExport?: (resourceId: string, fileName: string) => Promise<DesktopExportResult>;
    readBlob: (node: CanvasNodeData) => Promise<Blob | null>;
    saveBlob: (blob: Blob, fileName: string) => void;
};

export type CanvasMediaExportResult =
    | { status: "exported"; path?: string }
    | { status: "canceled" };

export async function exportCanvasMedia(
    node: CanvasNodeData,
    canvasTitle: string,
    dependencies: CanvasMediaExportDependencies = defaultDependencies(),
): Promise<CanvasMediaExportResult> {
    const fileName = buildCanvasMediaDownloadFileName(canvasTitle, node);
    const resourceId = resourceIdFromStorageKey(node.metadata?.storageKey);
    if (dependencies.desktopExport) {
        if (!resourceId) throw new Error("当前媒体尚未保存到本地资源库，无法导出");
        const result = await dependencies.desktopExport(resourceId, fileName);
        return result.canceled ? { status: "canceled" } : { status: "exported", path: result.path };
    }
    const blob = await dependencies.readBlob(node);
    if (!blob) throw new Error("未找到可导出的媒体文件");
    dependencies.saveBlob(blob, fileName);
    return { status: "exported" };
}

function defaultDependencies(): CanvasMediaExportDependencies {
    return {
        desktopExport: desktopResourceExporter(),
        readBlob: async (node) => {
            const storageKey = node.metadata?.storageKey;
            if (storageKey) {
                return node.type === CanvasNodeType.Image ? getImageBlob(storageKey) : getMediaBlob(storageKey);
            }
            const content = node.metadata?.content;
            if (!content) return null;
            const response = await fetch(content);
            if (!response.ok) throw new Error(`读取媒体失败：HTTP ${response.status}`);
            return response.blob();
        },
        saveBlob: (blob, fileName) => saveAs(blob, fileName),
    };
}
