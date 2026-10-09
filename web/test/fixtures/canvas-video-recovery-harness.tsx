import React, { useRef } from "react";
import { createRoot } from "react-dom/client";
import { CanvasNodeContent } from "../../src/components/canvas/canvas-node-content";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { CanvasNodeType } from "../../src/types/canvas";

function Harness() {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    return <div style={{ width: 320, height: 240 }}><CanvasNodeContent
        node={{ id: "video", title: "视频预览", type: CanvasNodeType.Video, width: 320, height: 240, position: { x: 0, y: 0 }, metadata: { content: "/api/resources/video/file", storageKey: "resource:video", status: "success", mimeType: "video/mp4" } }}
        theme={canvasThemes.light} mediaActive isEditingContent={false} textareaRef={textareaRef} isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false} onContentChange={() => {}} onStopEditing={() => {}} mentionReferences={[]}
    /></div>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
