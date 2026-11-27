import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";

import { CanvasVideoInlineTrim } from "@/components/canvas/canvas-video-inline-trim";
import { hasDeleteOverlay } from "@/lib/canvas/canvas-keyboard-scope";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const params = new URLSearchParams(window.location.search);
const widthPx = Number(params.get("width") || 520);
const durationMs = Number(params.get("durationMs") || 30_080);

const videoNode: CanvasNodeData = {
    id: "video-3008",
    type: CanvasNodeType.Video,
    title: "30.08秒测试视频",
    position: { x: 0, y: 0 },
    width: 720,
    height: 1280,
    metadata: {
        content: "",
        durationMs,
        naturalWidth: 720,
        naturalHeight: 1280,
        hasAudio: true,
    },
};

function Harness() {
    const [confirmed, setConfirmed] = useState<{ startMs: number; endMs: number; durationMs?: number } | null>(null);
    const [canvasDeletes, setCanvasDeletes] = useState(0);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if ((event.key === "Backspace" || event.key === "Delete") && !hasDeleteOverlay()) {
                setCanvasDeletes((count) => count + 1);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    return (
        <div style={{ padding: 24, background: "#141414", minHeight: "100vh" }}>
            <div style={{ width: widthPx }}>
                <CanvasVideoInlineTrim
                    node={videoNode}
                    busy={false}
                    onCancel={() => undefined}
                    onConfirm={(range, probedDurationMs) => setConfirmed({ ...range, durationMs: probedDurationMs })}
                />
            </div>
            <output data-testid="confirmed-result">{confirmed ? JSON.stringify(confirmed) : ""}</output>
            <output data-testid="canvas-delete-count">{String(canvasDeletes)}</output>
        </div>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
