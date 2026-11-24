import { App } from "antd";
import { lazy, Suspense, useState } from "react";

import { useResourceVideoPlayback } from "@/hooks/use-resource-video-playback";
import { extractOwnedResourceId } from "@/lib/canvas/canvas-resource-id";
import { buildCanvasMediaDownloadFileName, mediaFileExtension } from "@/lib/canvas/canvas-media-download";
import { buildLibTVVideoSourceUrl } from "@/lib/canvas/libtv-import";
import { canvasThemes } from "@/lib/canvas-theme";
import { formatImageRatio } from "@/lib/image-display-format";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { isProtectedResourceFileUrl } from "@/services/api/resources";
import { downloadOwnedOrBrowserMedia, isWailsNativeShell } from "@/services/desktop-media-save";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { modelDisplayName, useEffectiveConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

import { CanvasMediaInfoSidebar, formatDateTimeExact } from "./canvas-media-info-sidebar";
import { CanvasMediaViewer } from "./canvas-media-viewer";
import { MediaExportMenu } from "./media-export-menu";

const VideoPlayer = lazy(() => import("@/components/video-player").then((module) => ({ default: module.VideoPlayer })));

type Props = {
    node: CanvasNodeData;
    onClose: () => void;
    onOpenNodeInfo?: (nodeId: string) => void;
};

export function CanvasVideoViewer({ node, onClose, onOpenNodeInfo }: Props) {
    const { message } = App.useApp();
    const theme = canvasThemes[useActiveTheme()];
    const config = useEffectiveConfig();
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [metrics, setMetrics] = useState<{ width: number; height: number; durationMs: number }>();
    const metadata = node.metadata;
    const content = metadata?.content || "";
    const fallback = metadata?.importSource?.provider === "libtv" ? buildLibTVVideoSourceUrl(content) : content;
    const playback = useResourceVideoPlayback(metadata?.storageKey || "", fallback);
    const title = node.title || "视频";
    const width = metrics?.width || metadata?.naturalWidth || 0;
    const height = metrics?.height || metadata?.naturalHeight || 0;
    const durationMs = metrics?.durationMs || metadata?.durationMs || 0;
    const ratio = width > 0 && height > 0 ? width / height : 16 / 9;
    const resourceId = extractOwnedResourceId(metadata?.storageKey, content);
    const extension = mediaFileExtension(metadata?.mimeType, content);
    const fileSize = metadata?.bytes ? formatBytes(metadata.bytes) : "";
    const fileDetails = [fileSize, extension?.toUpperCase()].filter(Boolean).join(" · ");
    const rows = [
        { label: "模型", value: metadata?.model ? modelDisplayName(config, metadata.model) : "未记录" },
        { label: "比例", value: formatImageRatio(metadata?.size, width, height) },
        ...(metadata?.vquality ? [{ label: "分辨率", value: metadata.vquality }] : []),
        { label: "像素尺寸", value: width && height ? `${width} × ${height} px` : "未记录" },
        { label: "视频时长", value: durationMs > 0 ? formatDuration(durationMs) : "未记录" },
        ...(typeof metadata?.hasAudio === "boolean" ? [{ label: "音轨", value: metadata.hasAudio ? "有" : "无" }] : []),
        { label: "文件大小", value: fileDetails || "未记录" },
        { label: "生成时间", value: formatDateTimeExact(metadata?.taskCompletedAt || metadata?.taskCreatedAt) },
    ];

    const downloadOriginal = async () => {
        const fileName = buildCanvasMediaDownloadFileName(node);
        const browserUrl = isProtectedResourceFileUrl(fallback)
            ? ((!playback.compatible ? playback.url : "") || fallback)
            : (fallback || playback.url);
        const result = await downloadOwnedOrBrowserMedia({
            resourceId: resourceId || undefined,
            browserUrl,
            fileName,
        });
        if (result === "saved" && isWailsNativeShell()) message.success("已保存视频");
    };

    const loading = <span role="status">正在加载视频…</span>;

    return (
        <CanvasMediaViewer
            kind="视频"
            testIdPrefix="canvas-video"
            title={title}
            theme={theme}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((value) => !value)}
            onClose={onClose}
            actions={<MediaExportMenu theme={theme} onDownload={downloadOriginal} />}
            sidebar={<CanvasMediaInfoSidebar
                kind="视频"
                testIdPrefix="canvas-video"
                theme={theme}
                prompt={metadata?.prompt?.trim() || ""}
                rows={rows}
                onOpenNodeInfo={onOpenNodeInfo ? () => {
                    onClose();
                    onOpenNodeInfo(node.id);
                } : undefined}
            />}
        >
            <div className="media-viewer-video-stage">
                {playback.error ? (
                    <div role="status" className="text-center">
                        <p>视频暂时无法播放</p>
                        <button type="button" className="mt-2 rounded-[var(--r-md)] border px-3 py-1" onClick={playback.retry}>重试</button>
                    </div>
                ) : playback.url ? (
                    <Suspense fallback={loading}>
                        <div className="media-viewer-video-frame" style={{ aspectRatio: ratio, width: `min(100cqw, ${ratio * 100}cqh)` }}>
                            <VideoPlayer key={playback.url} src={playback.url} mimeType={playback.compatible ? "video/mp4" : metadata?.mimeType}
                                title={title} className="absolute inset-0 size-full bg-black" hasAudio={metadata?.hasAudio} enableSpaceToggle
                                onVideoMetadata={({ videoWidth, videoHeight, duration }) => {
                                    setMetrics({ width: videoWidth, height: videoHeight, durationMs: Number.isFinite(duration) ? duration * 1000 : 0 });
                                }}
                                onError={() => { if (!playback.requestCompatible()) playback.fail(); }}
                            />
                        </div>
                    </Suspense>
                ) : loading}
            </div>
        </CanvasMediaViewer>
    );
}
