import type { WorkflowDefinition } from "@/services/api/canvas-workflows";

export const characterReplacementOperation = "video.replace-character";
export const characterReplacementPreset = {
    name: "单人物替换工作流",
    description: "用人物参考图替换原视频中的主体，\n按镜头分段生成并保留原音轨。",
    definition: {
        version: 1,
        presentationVersion: 1,
        editorLayoutVersion: 2,
        nodes: [
            { id: "source-video", title: "原视频", mediaType: "video", role: "input" },
            { id: "character-image", title: "目标人物参考图", mediaType: "image", role: "input" },
            {
                id: "replacement", title: "单人物替换", mediaType: "video", role: "operation",
                operationId: characterReplacementOperation, operationVersion: 1,
                config: { maxSegments: 12, vquality: "720p" },
            },
        ],
        edges: [
            { fromNodeId: "source-video", toNodeId: "replacement", fromPort: "output", toPort: "video" },
            { fromNodeId: "character-image", toNodeId: "replacement", fromPort: "output", toPort: "character" },
        ],
        outputNodeIds: ["replacement"],
        positions: { "source-video": { x: 40, y: 100 }, "character-image": { x: 40, y: 290 }, replacement: { x: 590, y: 60 } },
    } satisfies WorkflowDefinition,
};
