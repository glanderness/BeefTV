/**
 * 生成进度 / 画布保存测量夹具（合成数据，不含任何用户内容或凭据）。
 *
 * 目的：给「一个节点正在生成、任务轮询持续把进度写进画布文档」这条路径
 * 造一份形状可信的画布文档，供 measure-canvas-save-cost.ts 反复调用真实
 * 生产函数测量。
 *
 * 文档形状依据：
 * - 节点字段：web/src/types/canvas.ts `CanvasNodeData` / `CanvasNodeMetadata`
 * - 画布文档：web/src/stores/canvas/use-canvas-store.ts `CanvasProject`
 * - 节点类型分布：web/scripts/refactor-performance.ts（70% 图片 / 28% 视频 / 2% 文本）
 */

export type FixtureNode = {
    id: string;
    type: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    position: { x: number; y: number };
    width: number;
    height: number;
    metadata: Record<string, unknown>;
};

export type FixtureConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    fromAnchorRatio: number;
    toAnchorRatio: number;
};

export type FixtureProject = {
    id: string;
    revision: number;
    workspaceProjectId: string;
    projectId: string;
    title: string;
    canvasTitle: string;
    createdAt: string;
    updatedAt: string;
    nodes: FixtureNode[];
    connections: FixtureConnection[];
    chatSessions: Array<Record<string, unknown>>;
    activeChatId: string;
    appearance: { mode: string };
    backgroundMode: string;
    showImageInfo: boolean;
    viewport: { x: number; y: number; k: number };
    directorScenes: unknown[];
};

/** 生成中节点的任务标识；只有这一个节点会被轮询改写。 */
export const GENERATING_NODE_ID = "node-generating";

const PROMPT = "电影感中景，黄昏街道，暖色逆光，浅景深，35mm 胶片质感，人物侧脸特写，微风吹动衣角。".repeat(3);
const ASSISTANT_MESSAGE = "这是上一轮为第 3 镜给出的分镜建议：镜头从人物肩后推入，保持画面右侧留白以便后期加字幕。".repeat(6);

function nodeTypeFor(index: number) {
    if (index % 50 < 35) return "image";
    if (index % 50 < 49) return "video";
    return "text";
}

function completedMetadata(index: number, type: string): Record<string, unknown> {
    const base: Record<string, unknown> = {
        prompt: PROMPT,
        content: `resource-${index}`,
        storageKey: `resources/canvas-fixture/${index}`,
        status: "success",
        resultOrigin: "generated",
        model: "seedream-4.0",
        size: "1024x1024",
        taskId: `task-fixture-${index}`,
        taskStatus: "succeeded",
        taskProgress: 100,
        taskStage: "已完成",
        taskCreatedAt: "2026-10-27T10:00:00.000Z",
        taskUpdatedAt: "2026-10-27T10:01:00.000Z",
        taskCompletedAt: "2026-10-27T10:01:00.000Z",
        generationEffectKeys: [`attach:task-fixture-${index}:${index}:0`],
        references: [`resource-${(index + 7) % 50}`],
        hasAudio: type === "video",
        generateAudio: false,
        watermark: false,
    };
    if (type === "video") {
        base.mimeType = "video/mp4";
        base.bytes = 8_400_000;
        base.durationMs = 5000;
        base.videoPreview = { content: `preview-${index}`, storageKey: `resources/previews/${index}`, width: 320, height: 180, bytes: 24_000, mimeType: "image/webp" };
    } else if (type === "image") {
        base.mimeType = "image/png";
        base.bytes = 1_400_000;
        base.naturalWidth = 1024;
        base.naturalHeight = 1024;
    } else {
        base.mimeType = "text/plain";
        base.bytes = 420;
        base.composerContent = PROMPT;
    }
    return base;
}

function generatingMetadata(progress: number, stage: string, updatedAt: string): Record<string, unknown> {
    return {
        prompt: PROMPT,
        status: "loading",
        model: "seedream-4.0",
        size: "1024x1024",
        taskId: "task-fixture-generating",
        taskType: "canvas_image",
        taskClientOperationId: "op-fixture-generating",
        generationSubmissionState: "accepted",
        taskStatus: "running",
        taskProgress: progress,
        taskStage: stage,
        taskProvider: "beefapi",
        taskStartedAt: "2026-10-27T10:05:00.000Z",
        taskCreatedAt: "2026-10-27T10:05:00.000Z",
        taskUpdatedAt: updatedAt,
        references: ["resource-1", "resource-2"],
    };
}

export function buildCanvasFixture(nodeCount: number, options: { generatingNode?: boolean } = {}) {
    const generatingNode = options.generatingNode !== false;
    const nodes: FixtureNode[] = Array.from({ length: nodeCount }, (_, index) => {
        const type = nodeTypeFor(index);
        return {
            id: `node-${index}`,
            type,
            title: `节点 ${index}`,
            createdAt: "2026-10-26T09:00:00.000Z",
            updatedAt: "2026-10-27T10:01:00.000Z",
            position: { x: (index % 40) * 380, y: Math.floor(index / 40) * 300 },
            width: type === "text" ? 320 : 340,
            height: type === "text" ? 220 : 480,
            metadata: completedMetadata(index, type),
        };
    });
    if (generatingNode) {
        nodes.push({
            id: GENERATING_NODE_ID,
            type: "image",
            title: "生成中的镜头",
            createdAt: "2026-10-27T10:05:00.000Z",
            updatedAt: "2026-10-27T10:05:00.000Z",
            position: { x: 0, y: 0 },
            width: 340,
            height: 480,
            metadata: generatingMetadata(0, "正在生成画面", "2026-10-27T10:05:00.000Z"),
        });
    }
    const allNodes = nodes;
    const connections: FixtureConnection[] = [];
    for (let index = 0; index + 1 < allNodes.length; index += 5) {
        connections.push({
            id: `edge-${index}`,
            fromNodeId: allNodes[index].id,
            toNodeId: allNodes[Math.min(index + 1, allNodes.length - 1)].id,
            fromAnchorRatio: 0.5,
            toAnchorRatio: 0.5,
        });
    }
    const project: FixtureProject = {
        id: "canvas-fixture",
        revision: 12,
        workspaceProjectId: "workspace-fixture",
        projectId: "domain-fixture",
        title: "测量夹具画布",
        canvasTitle: "测量夹具画布",
        createdAt: "2026-10-26T09:00:00.000Z",
        updatedAt: "2026-10-27T10:05:00.000Z",
        nodes: allNodes,
        connections,
        chatSessions: [{
            id: "session-fixture",
            title: "分镜讨论",
            createdAt: "2026-10-26T09:10:00.000Z",
            updatedAt: "2026-10-27T09:50:00.000Z",
            messages: Array.from({ length: 20 }, (_, index) => ({
                id: `message-${index}`,
                role: index % 2 === 0 ? "user" : "assistant",
                content: index % 2 === 0 ? "帮我看下第 3 镜的分镜。" : ASSISTANT_MESSAGE,
                createdAt: "2026-10-27T09:40:00.000Z",
            })),
        }],
        activeChatId: "session-fixture",
        appearance: { mode: "dark" },
        backgroundMode: "dots",
        showImageInfo: false,
        viewport: { x: -120, y: -240, k: 0.42 },
        directorScenes: [],
    };
    return project;
}

/**
 * 模拟一次任务轮询落到画布文档上的改动。
 *
 * 与生产的对应关系（web/src/pages/canvas/canvas-generation-failure.ts:98-126
 * `canvasGenerationTaskNodes` + web/src/lib/canvas/canvas-project-generation.ts:232-256
 * `generationTaskMetadata`）：只替换目标节点的 metadata，其余节点保持同一引用；
 * 目标节点本身产生新对象。progress / stage / taskUpdatedAt 每次轮询都变。
 */
export function tickGenerationProgress(project: FixtureProject, progress: number, stage = "正在生成画面", updatedAt = new Date(Date.now()).toISOString()) {
    const nodes = project.nodes.map((node) => node.id === GENERATING_NODE_ID
        ? { ...node, metadata: { ...node.metadata, ...generatingMetadata(progress, stage, updatedAt) } }
        : node);
    return { ...project, nodes };
}

/** 纯视口更新：nodes 数组保持同一引用（对应 project.tsx 的 updateProject(id, { viewport })。 */
export function changeViewportOnly(project: FixtureProject, k: number) {
    return { ...project, viewport: { ...project.viewport, k } };
}

/** 编辑器自动保存 effect 传进去的字段集合（use-canvas-project-lifecycle.ts:543）。 */
export function editorSnapshotFields(project: FixtureProject) {
    return {
        nodes: project.nodes,
        connections: project.connections,
        chatSessions: project.chatSessions,
        activeChatId: project.activeChatId,
        canvasAppearance: project.appearance,
        backgroundMode: project.backgroundMode,
        showImageInfo: project.showImageInfo,
    };
}
