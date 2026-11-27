import React, { useRef } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import "../../src/styles/globals.css";
import { CanvasNodeContent } from "../../src/components/canvas/canvas-node-content";
import { CanvasVideoViewer } from "../../src/components/canvas/image-viewer/canvas-video-viewer";
import { AssetPreviewModal } from "../../src/components/canvas/storyboard-assets-cell";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { CanvasNodeType } from "../../src/types/canvas";
import { AssetMediaPreview } from "../../src/components/asset-media-preview";
import { AssetVideoPreview } from "../../src/pages/assets";
import { CreationMediaPreviewModal } from "../../src/pages/create/creation-workspace";
import { CanvasAssistantAttachments } from "../../src/pages/canvas/canvas-assistant-attachments";
import { CanvasAssistantOutputs } from "../../src/pages/canvas/canvas-assistant-outputs";
import { ProjectAssetVideoPlayer } from "../../src/pages/projects/detail/assets";
import { VideoArtifactPreview } from "../../src/pages/projects/detail/workflow-production-workbench";

function Harness() {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const params = new URLSearchParams(location.search);
    const surface = params.get("surface");
    const initialInteracting = params.get("interacting") === "1";
    const initialZooming = params.get("zooming") === "1";
    const withSubtitles = params.get("subtitles") === "1";
    if (surface === "viewer") return <App><CanvasVideoViewer node={{ id: "video", title: "视频预览", type: CanvasNodeType.Video, width: 320, height: 240, position: { x: 0, y: 0 }, metadata: { content: "/api/resources/video/file", storageKey: "resource:video", status: "success", mimeType: "video/mp4" } }} onClose={() => {}} /></App>;
    if (surface === "creation") return <App><CreationMediaPreviewModal url="/api/resources/video/file" type="video" storageKey="resource:video" onClose={() => {}} /></App>;
    if (surface === "workflow") return <App><VideoArtifactPreview resourceId="video" src="/api/resources/video/file" title="镜头视频" /></App>;
    if (surface === "storyboard") return <App><AssetPreviewModal node={{ id: "video", title: "视频预览", type: CanvasNodeType.Video, width: 320, height: 240, position: { x: 0, y: 0 }, metadata: { content: "/api/resources/video/file", status: "success", mimeType: "video/mp4" } }} onClose={() => {}} /></App>;
    if (surface === "projectAsset") return <App><ProjectAssetVideoPlayer url="/api/resources/video/file" className="" /></App>;
    if (surface === "assistantOutput") return <App><CanvasAssistantOutputs outputs={[{ taskId: "video-task", kind: "video", sourceRevision: 1 }]} /></App>;
    if (surface === "attachment") return <CanvasAssistantAttachments attachments={[{ resourceId: "video", kind: "video", name: "视频", mimeType: "video/mp4", bytes: 100, purpose: "analysis" }]} />;
    if (surface === "drawer") return <AssetVideoPreview storageKey="resource:video" url="/api/resources/video/file" title="视频" className="" />;
    if (surface === "thumbnail") return <AssetMediaPreview alt="视频" asset={{ id: "video", kind: "video", title: "视频", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { storageKey: "resource:video", url: "/api/resources/video/file", width: 64, height: 48, bytes: 100, mimeType: "video/mp4" } }} />;
    return <div data-canvas-viewport data-canvas-viewport-interacting={initialInteracting ? "true" : undefined} data-canvas-viewport-zooming={initialZooming ? "true" : undefined} style={{ width: 320, height: 240 }}><CanvasNodeContent
        node={{ id: "video", title: "视频预览", type: CanvasNodeType.Video, width: 320, height: 240, position: { x: 0, y: 0 }, metadata: { content: "/api/resources/video/file", storageKey: "resource:video", status: "success", mimeType: "video/mp4", ...(withSubtitles ? { subtitleEntries: [{ index: 1, startMs: 0, endMs: 10000, text: "第一句台词" }] } : {}) } }}
        theme={canvasThemes.light} mediaActive isEditingContent={false} textareaRef={textareaRef} isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false} onContentChange={() => {}} onStopEditing={() => {}} mentionReferences={[]}
    /></div>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
