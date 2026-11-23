import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { CanvasNodeContextMenu } from "../../src/components/canvas/canvas-context-menu";
import { useCanvasNodeMediaShareActions } from "../../src/pages/canvas/use-canvas-node-media-share-actions";
import { CanvasNodeType } from "../../src/types/canvas";

function Harness() {
    const [open, setOpen] = useState(true);
    const [copiedNode, setCopiedNode] = useState(false);
    const mode = new URLSearchParams(location.search).get("mode");
    const metadata = mode?.endsWith("empty")
        ? {}
        : mode === "missing-original"
            ? { storageKey: "resource:missing", content: "/preview-ok.png", mimeType: "image/png" }
            : { storageKey: "resource:original", content: mode?.endsWith("storage") ? undefined : "/preview.png", mimeType: mode?.startsWith("video") ? "video/mp4" : "image/png" };
    const node = { id: "picture", title: "场景1", type: mode?.startsWith("video") ? CanvasNodeType.Video : CanvasNodeType.Image,
        position: { x: 0, y: 0 }, width: 320, height: 180, metadata };
    const noop = () => undefined;
    const share = useCanvasNodeMediaShareActions({ projectId: "copy-fixture", localOnly: true,
        releaseCopiedNodesPastePriority: noop, handleConfigNodeChange: noop });
    return <>
        <button onClick={() => setOpen(true)}>打开菜单</button>
        {copiedNode && <span>节点已复制</span>}
        {open && <CanvasNodeContextMenu menu={{ type: "node", nodeId: node.id, x: 80, y: 80 }} node={node}
            canUndo={false} canRedo={false} canPaste={false} onClose={() => setOpen(false)}
            onAddNode={noop} onAddFolder={noop} onChooseStyle={noop} onOpenDirector={noop} onUpload={noop}
            onOpenAssets={noop} onOpenProjectCharacters={noop} onOpenGenerationHistory={noop} onUndo={noop}
            onRedo={noop} onPaste={noop} onCopyNode={() => setCopiedNode(true)} onCreateGenerationCopy={noop}
            onDuplicate={noop} onDelete={noop} onSaveAsset={noop} onViewMedia={noop} onEditText={noop}
            onOpenDrawing={noop} onGenerateImage={noop} onCopyContent={() => void share.copyNodeContentToClipboard(node)}
            onCopyMediaUrl={noop} onUploadToArkPrivateAsset={noop} onToggleFrame={noop} />}
    </>;
}
createRoot(document.getElementById("root")!).render(<App><Harness /></App>);
