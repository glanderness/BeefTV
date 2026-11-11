import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { Button, ConfigProvider } from "antd";

import { CanvasProjectSelectionToolbar } from "@/pages/canvas/canvas-project-selection-toolbar";
import { WorkspaceNotice } from "@/components/layout/workspace-notice";

window.__BEEFTV_HARNESS__ = { embedded: true, apiBase: "/beeftv/app/api", basePath: "/beeftv/app", parentOrigin: window.location.origin };

function Harness() {
    const anchorRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const notice = new URLSearchParams(window.location.search).get("notice") === "1";
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    return (
        <div style={{ minHeight: "100vh", background: "#0f1115", padding: 48 }}>
            <div ref={containerRef} style={{ position: "relative", width: 760, height: 260, border: "1px solid rgba(255,255,255,.14)", borderRadius: 16, background: "#151922" }}>
                <div ref={anchorRef} style={{ position: "absolute", left: 378, top: 150, width: 4, height: 4 }} />
                {mounted ? <CanvasProjectSelectionToolbar
                    anchorRef={anchorRef}
                    containerRef={containerRef}
                    count={2}
                    selectedVideoCount={0}
                    mergingVideos={false}
                    onAlign={() => {}}
                    onArrange={() => {}}
                    onCreateStoryboard={() => {}}
                    onCreateReferenceGroup={() => {}}
                    onBatchConnect={() => {}}
                    onMergeVideos={() => {}}
                    onAskAssistant={() => {}}
                    onSaveWorkflow={() => {}}
                /> : null}
            </div>
            {notice ? <WorkspaceNotice tone="info" title="DSH 新建了画布「雨夜街道」" action={<Button size="small" autoInsertSpace={false}>打开</Button>} onClose={() => {}} /> : null}
        </div>
    );
}

createRoot(document.getElementById("root")!).render(
    <ConfigProvider>
        <Harness />
    </ConfigProvider>,
);
