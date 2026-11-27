import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { CanvasScriptNodeContent } from "@/components/canvas/canvas-script-node";
import { StoryboardAssetsCell } from "@/components/canvas/storyboard-assets-cell";
import { deriveStoryboardPipelineProgress } from "@/lib/canvas/canvas-storyboard-progress";
import { CanvasNodeType, type CanvasNodeData, type StoryboardAssetBinding, type StoryboardRow } from "@/types/canvas";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const assetNode: CanvasNodeData = {
    id: "hero-image",
    type: CanvasNodeType.Image,
    title: "林岚定妆照",
    position: { x: 0, y: 0 },
    width: 320,
    height: 180,
    metadata: { content: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=" },
};

const sampleRow: StoryboardRow = {
    id: "row-1",
    shotNumber: 1,
    durationSeconds: 5,
    plotDescription: "雨夜出场",
    dialogue: "",
    characters: [],
    narrativeIntent: "",
    viewerPOV: "",
    performanceBlocking: "",
    shotSize: "",
    emotion: "",
    lightingAndAtmosphere: "",
    audioEffects: "",
    camera: "",
    motion: "",
    timeBeats: "",
    imageGenerationPrompt: "",
    videoMotionPrompt: "",
    mustHave: [],
    optionalDetails: [],
    continuityOut: "",
    negativePrompt: "",
    assetBindings: [],
    status: "idle",
};

const scriptNode: CanvasNodeData = {
    id: "script-1",
    type: CanvasNodeType.Script,
    title: "第一集分镜",
    position: { x: 0, y: 0 },
    width: 920,
    height: 460,
    metadata: { storyboard: { rows: [sampleRow], visibleColumns: [] } },
};

const noop = () => {};

function Harness() {
    const [bindings, setBindings] = useState<StoryboardAssetBinding[]>([]);
    const [canvasClicks, setCanvasClicks] = useState(0);
    const nodes = [scriptNode, assetNode];
    const pipeline = deriveStoryboardPipelineProgress(scriptNode, nodes, []);

    return (
        <QueryClientProvider client={queryClient}>
            <ConfigProvider theme={{ token: { motion: false } }} button={{ autoInsertSpace: false }}>
                <App>
                <div
                    data-testid="canvas-surface"
                    onClick={() => setCanvasClicks((count) => count + 1)}
                    style={{ padding: 48, display: "grid", gap: 32 }}
                >
                    <div data-testid="canvas-clicks">{canvasClicks}</div>
                    <div data-testid="binding-count">{bindings.length}</div>
                    <div style={{ width: 220 }}>
                        <StoryboardAssetsCell bindings={bindings} nodes={nodes} onChange={setBindings} />
                    </div>
                    <div style={{ width: 920, height: 460 }}>
                        <CanvasScriptNodeContent
                            node={scriptNode}
                            nodes={nodes}
                            pipeline={pipeline}
                            scale={1}
                            mentionReferences={[]}
                            onOpen={noop}
                            onCreateImageNodes={noop}
                            onCreateVideoNodes={noop}
                            onGenerateImages={noop}
                            onGenerateVideos={noop}
                            onVideoInputModeChange={noop}
                            onMergeVideos={noop}
                            onCreateActionBoards={noop}
                            onRetryBatch={noop}
                            onRetryBatchItem={noop}
                            onStopBatch={noop}
                            onAddRow={noop}
                            onRemoveRow={noop}
                            onUpdateRow={noop}
                            onPromptChange={noop}
                            onGenerateScript={noop}
                            onModelChange={noop}
                            onShotDurationChange={noop}
                            onShotCountChange={noop}
                            onComposerHeightChange={noop}
                            onConnectStart={noop}
                            onScrollTopChange={noop}
                        />
                    </div>
                </div>
                </App>
            </ConfigProvider>
        </QueryClientProvider>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
