import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasScriptEditor } from "../../src/components/canvas/canvas-script-node";
import { getAntThemeConfig } from "../../src/lib/app-theme";
import { createStoryboardRow } from "../../src/lib/canvas/canvas-project-domain";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";

const noop = () => {};
const client = new QueryClient();
function Harness() {
    const [node, setNode] = useState<CanvasNodeData>({
        id: "script", type: CanvasNodeType.Script, title: "分镜", position: { x: 0, y: 0 }, width: 920, height: 360,
        metadata: { storyboard: { referenceNodeIds: [], visibleColumns: ["shotNumber", "durationSeconds", "plotDescription", "dialogue", "imageGenerationPrompt", "videoMotionPrompt", "assets"], rows: [1, 2].map((number) => createStoryboardRow(number, { durationSeconds: 5, plotDescription: "黄衣外卖员站在电梯前", imageGenerationPrompt: "楼层显示13", videoMotionPrompt: "缓慢抬头" })) } },
    });
    return <ConfigProvider theme={getAntThemeConfig(location.search.includes("dark"))}><App><QueryClientProvider client={client}>
        <CanvasScriptEditor node={node} nodes={[node]} open onClose={noop}
            onUpdateRows={(rows) => setNode({ ...node, metadata: { ...node.metadata, storyboard: { ...node.metadata!.storyboard!, rows } } })}
            onVisibleColumnsChange={noop} onGenerateImages={noop} onGenerateVideos={noop} onVideoInputModeChange={noop} />
    </QueryClientProvider></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
