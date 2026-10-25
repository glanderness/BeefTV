import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasAppearanceControls } from "../../src/components/canvas/canvas-appearance-controls";
import { canvasThemes, type CanvasColorTheme } from "../../src/lib/canvas-theme";
import type { CanvasWheelBehavior } from "../../src/lib/canvas/canvas-wheel";

export function mountCanvasAppearanceHarness(root: HTMLElement) {
    function Harness() {
        const [wheelBehavior, setWheelBehavior] = useState<CanvasWheelBehavior>("auto");
        const [snapToGrid, setSnapToGrid] = useState(false);
        const [showConnections, setShowConnections] = useState(true);
        return <div style={{ width: 288 }}>
            <CanvasAppearanceControls
                appearance={{ mode: "follow" }}
                backgroundMode="dots"
                colorTheme={"light" as CanvasColorTheme}
                theme={canvasThemes.light}
                onAppearanceChange={() => {}}
                onSaveAppearanceDefault={() => {}}
                onBackgroundModeChange={() => {}}
                snapToGrid={snapToGrid}
                onSnapToGridChange={setSnapToGrid}
                showConnections={showConnections}
                onShowConnectionsChange={setShowConnections}
                wheelBehavior={wheelBehavior}
                onWheelBehaviorChange={(value) => {
                    setWheelBehavior(value);
                    (window as unknown as { __wheelBehavior?: string }).__wheelBehavior = value;
                }}
            />
        </div>;
    }
    createRoot(root).render(<Harness />);
}