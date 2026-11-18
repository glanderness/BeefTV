import { describe, expect, test } from "bun:test";
import { App as AntdApp } from "antd";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { CanvasStoryboardBindSubmenu, collectCanvasStoryboardTargets } from "@/components/canvas/canvas-context-menu-storyboard";
import {
    CanvasScriptEditor,
    resolveStoryboardGenerationRowIds,
    storyboardEditorImageButtonLabel,
    storyboardEditorVideoButtonLabel,
} from "@/components/canvas/canvas-script-editor";
import { StoryboardAssetBindingPanel, StoryboardAssetsCell } from "@/components/canvas/storyboard-assets-cell";
import { createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import {
    applyAssetsToStoryboardRows,
    collectSelectedBindableAssetNodes,
    mergeStoryboardAssetBindings,
    removeStoryboardAssetBinding,
    storyboardAssetNodeBadge,
    storyboardAssetRoleForNode,
    toggleStoryboardAssetBinding,
    updateStoryboardAssetBindingRole,
} from "@/lib/canvas/canvas-storyboard-assets";
import { CanvasNodeType, type CanvasNodeData, type StoryboardAssetBinding } from "@/types/canvas";

function makeNode(
    id: string,
    type: CanvasNodeData["type"],
    title: string,
    metadata: CanvasNodeData["metadata"] = {},
): CanvasNodeData {
    return {
        id,
        type,
        title,
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata,
    };
}

describe("storyboard asset role inference and batch binding helpers", () => {
    const characterCard = makeNode("char-1", CanvasNodeType.Text, "林默", {
        workflowKind: "character",
        characterAssetId: "asset-char-1",
        characterVersionId: "ver-1",
    });
    const sceneImg = makeNode("scene-1", CanvasNodeType.Image, "雨夜街道", {
        content: "https://example.com/rain.png",
        assetCategory: "environment",
    });
    const generalImg = makeNode("img-1", CanvasNodeType.Image, "走廊参考", {
        content: "https://example.com/corridor.png",
    });
    const videoRef = makeNode("vid-1", CanvasNodeType.Video, "奔跑镜头参考", {
        content: "https://example.com/run.mp4",
    });
    const audioRef = makeNode("aud-1", CanvasNodeType.Audio, "环境雨声", {
        content: "https://example.com/rain.wav",
    });

    test("infers default role and badge for character, scene, image, video, and audio nodes", () => {
        expect(storyboardAssetRoleForNode(characterCard)).toBe("character");
        expect(storyboardAssetRoleForNode(sceneImg)).toBe("environment");
        expect(storyboardAssetRoleForNode(generalImg)).toBe("environment");
        expect(storyboardAssetRoleForNode(videoRef)).toBe("motion");
        expect(storyboardAssetRoleForNode(audioRef)).toBe("audio");

        expect(storyboardAssetNodeBadge(characterCard)).toBe("角色");
        expect(storyboardAssetNodeBadge(sceneImg)).toBe("场景");
        expect(storyboardAssetNodeBadge(generalImg)).toBe("图片");
        expect(storyboardAssetNodeBadge(videoRef)).toBe("视频");
        expect(storyboardAssetNodeBadge(audioRef)).toBe("音频");
    });

    test("mergeStoryboardAssetBindings deduplicates by nodeId and preserves customized roles", () => {
        const existing: StoryboardAssetBinding[] = [
            { nodeId: "img-1", role: "wardrobe", priority: 80 },
        ];
        const merged = mergeStoryboardAssetBindings(existing, [characterCard, generalImg, videoRef, audioRef]);
        expect(merged).toEqual([
            { nodeId: "img-1", role: "wardrobe", priority: 80 },
            { nodeId: "char-1", role: "character", priority: 100 },
            { nodeId: "vid-1", role: "motion", priority: 70 },
            { nodeId: "aud-1", role: "audio", priority: 70 },
        ]);
    });

    test("toggle, role update, remove, and batch shot row application work deterministically", () => {
        let bindings = toggleStoryboardAssetBinding([], characterCard);
        expect(bindings.map((item) => item.nodeId)).toEqual(["char-1"]);

        bindings = toggleStoryboardAssetBinding(bindings, generalImg);
        expect(bindings.map((item) => item.nodeId)).toEqual(["char-1", "img-1"]);

        bindings = updateStoryboardAssetBindingRole(bindings, "img-1", "prop");
        expect(bindings.find((item) => item.nodeId === "img-1")?.role).toBe("prop");

        bindings = removeStoryboardAssetBinding(bindings, "char-1");
        expect(bindings).toEqual([{ nodeId: "img-1", role: "prop", priority: 80 }]);

        const rows = [
            createStoryboardRow(1, { id: "shot-a", assetBindings: bindings }),
            createStoryboardRow(2, { id: "shot-b", assetBindings: [] }),
        ];
        const applied = applyAssetsToStoryboardRows(rows, ["shot-a", "shot-b"], [characterCard, generalImg, audioRef]);
        expect(applied.updatedShotNumbers).toEqual([1, 2]);
        expect(applied.rows[0].assetBindings).toEqual([
            { nodeId: "img-1", role: "prop", priority: 80 },
            { nodeId: "char-1", role: "character", priority: 100 },
            { nodeId: "aud-1", role: "audio", priority: 70 },
        ]);
        expect(applied.rows[1].assetBindings.map((item) => item.nodeId)).toEqual(["char-1", "img-1", "aud-1"]);
    });
});

describe("StoryboardAssetsCell and StoryboardAssetBindingPanel interactive UX", () => {
    const charNode = makeNode("char-1", CanvasNodeType.Text, "主角阿杰", {
        workflowKind: "character",
        characterAssetId: "c-1",
    });
    const sceneNode = makeNode("scene-1", CanvasNodeType.Image, "天台夜景", {
        content: "data:image/png;base64,iVBORw0KGgo=",
        assetCategory: "environment",
    });
    const audioNode = makeNode("audio-1", CanvasNodeType.Audio, "角色独白", {
        content: "data:audio/wav;base64,UklGRg==",
    });
    const nodes = [charNode, sceneNode, audioNode];

    test("renders read-only placeholder when onChange is omitted, and + 关联 button with data-canvas-no-zoom when interactive", () => {
        const readOnlyHtml = renderToStaticMarkup(<StoryboardAssetsCell bindings={[]} nodes={nodes} />);
        expect(readOnlyHtml).toContain("未关联");
        expect(readOnlyHtml).not.toContain("+ 关联");

        const interactiveHtml = renderToStaticMarkup(
            <StoryboardAssetsCell bindings={[]} nodes={nodes} onChange={() => undefined} />,
        );
        expect(interactiveHtml).toContain("+ 关联");
        expect(interactiveHtml).toContain("data-canvas-no-zoom");
    });

    test("StoryboardAssetBindingPanel renders batch actions, bound role controls, and updates across add/role/remove states", () => {
        let bindings: StoryboardAssetBinding[] = [
            { nodeId: "scene-1", role: "environment", priority: 90 },
        ];
        const initialHtml = renderToStaticMarkup(
            <StoryboardAssetBindingPanel
                bindings={bindings}
                nodes={nodes}
                selectedCanvasNodeIds={["char-1", "audio-1"]}
                onChange={() => undefined}
            />,
        );
        expect(initialHtml).toContain("一键勾选当前画布已选素材 (2)");
        expect(initialHtml).toContain("全选画布参考图");
        expect(initialHtml).toContain("已关联 1 项");
        expect(initialHtml).toContain('aria-label="天台夜景 资产角色"');
        expect(initialHtml).toContain('aria-label="移除 天台夜景"');
        expect(initialHtml).toContain("角色");
        expect(initialHtml).toContain("场景");
        expect(initialHtml).toContain("音频");

        const selectedNodes = collectSelectedBindableAssetNodes(nodes, ["char-1", "audio-1"]);
        bindings = mergeStoryboardAssetBindings(bindings, selectedNodes);
        bindings = updateStoryboardAssetBindingRole(bindings, "scene-1", "wardrobe");
        bindings = removeStoryboardAssetBinding(bindings, "audio-1");

        const updatedHtml = renderToStaticMarkup(
            <StoryboardAssetBindingPanel
                bindings={bindings}
                nodes={nodes}
                onChange={() => undefined}
            />,
        );
        expect(updatedHtml).toContain("已关联 2 项");
        expect(updatedHtml).toContain('aria-label="主角阿杰 资产角色"');
        expect(updatedHtml).toContain('option value="wardrobe" selected=""');
        expect(updatedHtml).not.toContain('aria-label="移除 角色独白"');
    });
});

describe("CanvasScriptEditor generation targeting and context menu storyboard binding", () => {
    const row1 = createStoryboardRow(1, { id: "r1", plotDescription: "第一镜：主角登场", videoMotionPrompt: "推镜" });
    const row2 = createStoryboardRow(2, { id: "r2", plotDescription: "第二镜：转身拔剑", videoMotionPrompt: "环绕" });
    const scriptNode = makeNode("script-1", CanvasNodeType.Script, "第一集分镜", {
        storyboard: {
            rows: [row1, row2],
            visibleColumns: ["shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"],
            referenceNodeIds: [],
        },
    });
    const videoNode = makeNode("video-1", CanvasNodeType.Video, "参考配音视频", {
        content: "https://example.com/voice.mp4",
    });

    test("auto-targets all filtered rows when no checkboxes are selected in CanvasScriptEditor", () => {
        expect(resolveStoryboardGenerationRowIds([row1, row2], [])).toEqual(["r1", "r2"]);
        expect(resolveStoryboardGenerationRowIds([row1, row2], ["r2"])).toEqual(["r2"]);
        expect(resolveStoryboardGenerationRowIds([], [])).toEqual([]);

        expect(storyboardEditorImageButtonLabel("direct", 0, 2)).toBe("生成全部分镜图 (2)");
        expect(storyboardEditorImageButtonLabel("direct", 1, 2)).toBe("生成分镜图 (1)");
        expect(storyboardEditorImageButtonLabel("keyframe", 0, 2)).toBe("生成全部首帧 (2)");
        expect(storyboardEditorImageButtonLabel("keyframe", 1, 2)).toBe("生成首帧 (1)");
        expect(storyboardEditorVideoButtonLabel("direct", 0, 2)).toBe("生成全部视频 (2)");
        expect(storyboardEditorVideoButtonLabel("direct", 2, 2)).toBe("生成视频 (2)");
        expect(storyboardEditorVideoButtonLabel("keyframe", 0, 2)).toBe("确认首帧并生成全部 (2)");
        expect(storyboardEditorVideoButtonLabel("keyframe", 1, 2)).toBe("确认首帧并生成 (1)");

        const closedHtml = renderToStaticMarkup(
            <AntdApp>
                <CanvasScriptEditor
                    node={scriptNode}
                    nodes={[scriptNode, videoNode]}
                    selectedCanvasNodeIds={["video-1"]}
                    open={false}
                    onClose={() => undefined}
                    onUpdateRows={() => undefined}
                    onVisibleColumnsChange={() => undefined}
                    onGenerateImages={() => undefined}
                    onGenerateVideos={() => undefined}
                    onVideoInputModeChange={() => undefined}
                />
            </AntdApp>,
        );
        expect(closedHtml).toContain("ant-app");
    });

    test("CanvasNodeContextMenu exposes 关联至分镜镜头 and 提取音频为节点", () => {
        const noop = () => undefined;
        const targets = collectCanvasStoryboardTargets([scriptNode, videoNode]);
        expect(targets).toHaveLength(1);
        expect(targets[0].shots.map((shot) => shot.shotNumber)).toEqual([1, 2]);

        const baseProps = {
            canUndo: false,
            canRedo: false,
            canPaste: false,
            onClose: noop,
            onAddNode: noop,
            onAddFolder: noop,
            onChooseStyle: noop,
            onOpenDirector: noop,
            onUpload: noop,
            onOpenAssets: noop,
            onOpenProjectCharacters: noop,
            onOpenGenerationHistory: noop,
            onUndo: noop,
            onRedo: noop,
            onPaste: noop,
            onCopyNode: noop,
            onCreateGenerationCopy: noop,
            onDuplicate: noop,
            onDelete: noop,
            onSaveAsset: noop,
            onViewMedia: noop,
            onEditText: noop,
            onOpenDrawing: noop,
            onGenerateImage: noop,
            onCopyContent: noop,
            onCopyMediaUrl: noop,
            onUploadToArkPrivateAsset: noop,
            onToggleFrame: noop,
            bindableAssetCount: 3,
            storyboardTargets: targets,
            onBindAssetsToStoryboardShots: noop,
            onExtractAudioNode: noop,
        };

        const multiMenuHtml = renderToStaticMarkup(
            <CanvasNodeContextMenu
                {...baseProps}
                selectedCount={3}
                menu={{ type: "node", x: 120, y: 120, nodeId: "video-1" }}
            />,
        );
        expect(multiMenuHtml).toContain("关联至分镜镜头");
        expect(multiMenuHtml).toContain("批量关联 3 个素材");

        const singleVideoMenuHtml = renderToStaticMarkup(
            <CanvasNodeContextMenu
                {...baseProps}
                workspaceMode="simple"
                selectedCount={1}
                bindableAssetCount={1}
                node={videoNode}
                menu={{ type: "node", x: 120, y: 120, nodeId: "video-1" }}
            />,
        );
        expect(singleVideoMenuHtml).toContain("提取音频为节点");
        expect(singleVideoMenuHtml).toContain("关联至分镜镜头");

        const submenuHtml = renderToStaticMarkup(
            <CanvasStoryboardBindSubmenu
                targets={targets}
                assetCount={3}
                onBack={noop}
                onBindShots={noop}
            />,
        );
        expect(submenuHtml).toContain("全部选中镜头 (2)");
        expect(submenuHtml).toContain("镜 1");
        expect(submenuHtml).toContain("镜 2");
    });
});
