import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasDirectorNodePanel } from "@/components/canvas/director/canvas-director-node-panel";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { createDirectorScene } from "@/lib/canvas/director/director-scene";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const scene = createDirectorScene("镜头 1");
const node: CanvasNodeData = {
    id: "director-1",
    type: CanvasNodeType.Video,
    title: "镜头 1",
    position: { x: 0, y: 0 },
    width: 384,
    height: 360,
    metadata: { workflowKind: "shot", directorSceneId: scene.id, directorShotId: scene.shots[0].id, composerContent: "夜晚的街道" },
};

function render(readNodeContent: (id: string | undefined) => string | undefined = () => undefined) {
    return renderToStaticMarkup(<CanvasDirectorNodePanel node={node} scene={scene} readNodeContent={readNodeContent} onOpen={() => {}} onPromptChange={() => {}} />);
}

describe("导演台画布节点", () => {
    test("外置标题不在卡片内重复，空态可打开且场景描述独立回显", () => {
        const markup = render();
        expect(markup).not.toContain("镜头 1</div>");
        expect(markup).toContain("打开导演台");
        expect(markup).toContain("在3D空间中搭建场景并进行多视角截图");
        expect(markup).toContain('aria-label="场景描述"');
        expect(markup).toContain("夜晚的街道</textarea>");
        expect(markup).not.toContain("对象</span>");
    });

    test("已有封面保持完整比例且仍可悬停打开", () => {
        const withPreview = { ...node, metadata: { ...node.metadata, directorPreviewNodeId: "image-1" } };
        const markup = renderToStaticMarkup(<CanvasDirectorNodePanel node={withPreview} scene={scene} readNodeContent={() => "https://example.test/cover.png"} onOpen={() => {}} onPromptChange={() => {}} />);
        expect(markup).toContain('src="https://example.test/cover.png"');
        expect(markup).toContain("object-contain");
        expect(markup).toContain("打开导演台");
    });

    test("持久封面优先于旧预览且仍保留旧项目回落", () => {
        const withCover = { ...node, metadata: { ...node.metadata, directorCoverUrl: "https://assets.example/cover.png", directorPreviewNodeId: "legacy" } };
        const markup = renderToStaticMarkup(<CanvasDirectorNodePanel node={withCover} scene={scene} readNodeContent={() => "https://assets.example/legacy.png"} onOpen={() => {}} onPromptChange={() => {}} />);
        expect(markup).toContain('src="https://assets.example/cover.png"');
        expect(markup).not.toContain('src="https://assets.example/legacy.png"');
    });

    test("导演节点不被通用视频节点外壳包成第二张灰色卡片", () => {
        const markup = renderToStaticMarkup(<CanvasNode
            data={node} scale={1} isSelected={false} isRelated={false} isFocusRelated={false}
            isConnectionTarget={false} showImageInfo={false}
            onMouseDown={() => {}} onHoverStart={() => {}} onHoverEnd={() => {}}
            onConnectStart={() => {}} onResize={() => {}} onContentChange={() => {}}
            onContextMenu={() => {}} renderNodeContent={() => <CanvasDirectorNodePanel node={node} scene={scene} readNodeContent={() => undefined} onOpen={() => {}} onPromptChange={() => {}} />}
        />);
        const shell = markup.match(/class="canvas-node-shell[^\"]*"[^>]*style="([^"]*)"/)?.[1];
        expect(shell).toBeDefined();
        expect(shell).toContain("background:transparent");
        expect(shell).toContain("border:0");
        expect(shell).toContain("box-shadow:none");
        const header = markup.match(/class="canvas-node-external-header[^\"]*"[^>]*style="([^"]*)"/)?.[1];
        expect(header).toContain("left:74px");
    });
});
