import { createRoot } from "react-dom/client";
import { CanvasNodeAnglePanel } from "../../src/components/canvas/canvas-node-angle-dialog";

const root = createRoot(document.getElementById("root")!);
const params = new URLSearchParams(location.search);
const dataUrl = params.get("dataUrl") ?? "/api/resources/res-desktop-574/file";
const storageKey = params.get("storageKey") ?? "resource:res-desktop-574";
root.render(
    <div style={{ width: 640, height: 540 }}>
        <CanvasNodeAnglePanel
            dataUrl={dataUrl}
            storageKey={storageKey || undefined}
            onClose={() => {}}
            onConfirm={() => {}}
        />
    </div>,
);
