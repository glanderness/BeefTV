import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { canvasThemes } from "../src/lib/canvas-theme";
import { ConnectedReferenceShelf, VideoReferenceModeSwitch } from "../src/components/canvas/canvas-node-reference-shelf";
import { findPromptFirstFrameNodeId, resolveVideoReferenceCapabilities, resolveVideoReferenceModeState, stripPromptFirstFrameClauses, togglePromptFirstFrameMention } from "../src/lib/canvas/video-reference-mode";
import { managedVideoCatalogItem } from "./managed-video-fixture";
import type { CanvasResourceReference } from "../src/lib/canvas/canvas-resource-references";

const makeImageRefs = (count: number): CanvasResourceReference[] =>
    Array.from({ length: count }, (_, index) => ({
        id: `img-${index + 1}`,
        nodeId: `img-${index + 1}`,
        kind: "image",
        label: `图片${index + 1}`,
        title: `镜头${index + 1}`,
        active: true,
        previewUrl: `https://example.com/img-${index + 1}.png`,
    }));

describe("resolveVideoReferenceModeState", () => {
    test("1–2 张参考图默认进入首尾帧模式并推导首帧/尾帧角色，支持切换到全能参考", () => {
        const oneImageState = resolveVideoReferenceModeState({
            references: makeImageRefs(1),
        });
        expect(oneImageState.mode).toBe("frames");
        expect(oneImageState.canSelectFrames).toBe(true);
        expect(oneImageState.canSelectAll).toBe(true);
        expect(oneImageState.startFrameNodeId).toBe("img-1");
        expect(oneImageState.endFrameNodeId).toBeUndefined();

        const twoImageState = resolveVideoReferenceModeState({
            references: makeImageRefs(2),
        });
        expect(twoImageState.mode).toBe("frames");
        expect(twoImageState.canSelectFrames).toBe(true);
        expect(twoImageState.startFrameNodeId).toBe("img-1");
        expect(twoImageState.endFrameNodeId).toBe("img-2");

        const switchedToAll = resolveVideoReferenceModeState({
            references: makeImageRefs(2),
            metadata: { videoEditOperation: "reference_to_video" },
        });
        expect(switchedToAll.mode).toBe("all");
        expect(switchedToAll.canSelectFrames).toBe(true);
        expect(switchedToAll.startFrameNodeId).toBeUndefined();
        expect(switchedToAll.endFrameNodeId).toBeUndefined();
    });

    test("3 张及以上参考图或包含视频/音频时自动锁定全能参考并给出禁用原因", () => {
        const fiveImageState = resolveVideoReferenceModeState({
            references: makeImageRefs(5),
        });
        expect(fiveImageState.mode).toBe("all");
        expect(fiveImageState.canSelectFrames).toBe(false);
        expect(fiveImageState.framesDisabledReason).toContain("1–2 张图");

        const videoRefState = resolveVideoReferenceModeState({
            references: [
                ...makeImageRefs(1),
                { nodeId: "vid-1", kind: "video", label: "视频1", title: "参考视频", active: true },
            ],
        });
        expect(videoRefState.mode).toBe("all");
        expect(videoRefState.canSelectFrames).toBe(false);
        expect(videoRefState.framesDisabledReason).toContain("参考视频");

        const characterRefState = resolveVideoReferenceModeState({
            references: [
                ...makeImageRefs(1),
                { nodeId: "char-1", kind: "character", label: "角色1", title: "主角卡", active: true },
            ],
        });
        expect(characterRefState.mode).toBe("all");
        expect(characterRefState.canSelectFrames).toBe(false);
        expect(characterRefState.framesDisabledReason).toContain("角色卡");

        const noRefVideoModelState = resolveVideoReferenceModeState({
            references: makeImageRefs(1),
            referenceVideoSupported: false,
            endFrameSupported: false,
        });
        expect(noRefVideoModelState.mode).toBe("frames");
        expect(noRefVideoModelState.canSelectAll).toBe(false);
        expect(noRefVideoModelState.endFrameSupported).toBe(false);
        expect(
            renderToStaticMarkup(
                <VideoReferenceModeSwitch state={noRefVideoModelState} theme={canvasThemes.dark} onChange={() => {}} />,
            ),
        ).toBe("");

        // 万相 3.0 / Kling v3 / H3 Max Turbo / 带版本号 H3 等统一驱动首尾帧、全能参考与中间帧开关
        const wanCaps = resolveVideoReferenceCapabilities("beeftv::wan3.0-video", managedVideoCatalogItem("wan3.0-video").videoCapabilities, true);
        expect(wanCaps).toEqual({
            maxFrameImages: 2,
            endFrameSupported: true,
            referenceVideoSupported: true,
            maxFrameAudios: 0,
            middleFrameSupport: "unsupported",
            middleFrameSupported: false,
        });
        const wanWithAudioState = resolveVideoReferenceModeState({
            metadata: { videoEditOperation: "image_to_video", videoStartFrameNodeId: "img-1" },
            references: [
                ...makeImageRefs(2),
                { nodeId: "aud-1", kind: "audio", label: "音频1", title: "旁白", active: true },
            ],
            ...wanCaps,
        });
        expect(wanWithAudioState.mode).toBe("all");
        expect(wanWithAudioState.canSelectFrames).toBe(false);

        const klingCaps = resolveVideoReferenceCapabilities("beeftv::kling-video-v3", managedVideoCatalogItem("kling-video-v3").videoCapabilities, true);
        expect(klingCaps).toEqual({
            maxFrameImages: 1,
            endFrameSupported: false,
            referenceVideoSupported: false,
            maxFrameAudios: 0,
            middleFrameSupport: "unsupported",
            middleFrameSupported: false,
        });

        const h3TurboCaps = resolveVideoReferenceCapabilities("beeftv::minimax-h3-max-turbo", managedVideoCatalogItem("minimax-h3-max-turbo").videoCapabilities, true);
        expect(h3TurboCaps).toEqual({
            maxFrameImages: 2,
            endFrameSupported: true,
            referenceVideoSupported: false,
            maxFrameAudios: 1,
            middleFrameSupport: "unsupported",
            middleFrameSupported: false,
        });

        // 真实线上目录 minimax-h3（省略 operationReferences）保留首尾帧最多 1 段音频，2 段音频升为全能参考
        const h3LiveCaps = resolveVideoReferenceCapabilities("beeftv::minimax-h3", managedVideoCatalogItem("minimax-h3").videoCapabilities, true);
        expect(h3LiveCaps).toEqual({
            maxFrameImages: 2,
            endFrameSupported: true,
            referenceVideoSupported: true,
            maxFrameAudios: 1,
            middleFrameSupport: "unsupported",
            middleFrameSupported: false,
        });
        const h3OneAudioState = resolveVideoReferenceModeState({
            references: [...makeImageRefs(1), { nodeId: "aud-1", kind: "audio", label: "音频1", title: "对白", active: true }],
            h3Model: true,
            ...h3LiveCaps,
        });
        expect(h3OneAudioState.mode).toBe("frames");
        expect(h3OneAudioState.canSelectFrames).toBe(true);
        const h3TwoAudioState = resolveVideoReferenceModeState({
            references: [
                ...makeImageRefs(1),
                { nodeId: "aud-1", kind: "audio", label: "音频1", title: "对白", active: true },
                { nodeId: "aud-2", kind: "audio", label: "音频2", title: "环境音", active: true },
            ],
            h3Model: true,
            ...h3LiveCaps,
        });
        expect(h3TwoAudioState.mode).toBe("all");
        expect(h3TwoAudioState.canSelectFrames).toBe(false);

        // 真实线上目录 minimax-h3-max（省略 middleFrame）从契约补齐中间帧支持；显式 middleFrame: false 强制关闭
        const h3MaxLiveCaps = resolveVideoReferenceCapabilities("beeftv::minimax-h3-max", managedVideoCatalogItem("minimax-h3-max").videoCapabilities, true);
        expect(h3MaxLiveCaps.middleFrameSupport).toBe("supported");
        expect(h3MaxLiveCaps.middleFrameSupported).toBe(true);
        const h3MaxExplicitOffCaps = resolveVideoReferenceCapabilities(
            "beeftv::minimax-h3-max",
            { ...managedVideoCatalogItem("minimax-h3-max").videoCapabilities!, middleFrame: false },
            true,
        );
        expect(h3MaxExplicitOffCaps.middleFrameSupport).toBe("unsupported");
        expect(h3MaxExplicitOffCaps.middleFrameSupported).toBe(false);

        // 自定义/BYOK 渠道同名模型不套用 BeefTV 渠道契约
        const customH3MaxCaps = resolveVideoReferenceCapabilities("custom::minimax-h3-max", managedVideoCatalogItem("minimax-h3").videoCapabilities, true);
        expect(customH3MaxCaps.middleFrameSupport).toBe("unsupported");
        expect(customH3MaxCaps.middleFrameSupported).toBe(false);
        expect(customH3MaxCaps.maxFrameAudios).toBe(0);
        const customKlingCaps = resolveVideoReferenceCapabilities(
            "custom::kling-video-v3",
            {
                ...managedVideoCatalogItem("kling-video-v3").videoCapabilities!,
                references: { ...managedVideoCatalogItem("kling-video-v3").videoCapabilities!.references, maxImages: 2, maxAudios: 1 },
            },
            true,
        );
        expect(customKlingCaps.maxFrameImages).toBe(2);
        expect(customKlingCaps.endFrameSupported).toBe(true);
        expect(customKlingCaps.maxFrameAudios).toBe(1);

        // 显式部分或空 operationReferences 继承模型级 references 上限，不回退到契约上限
        const partialOpRefCaps = resolveVideoReferenceCapabilities(
            "beeftv::minimax-h3",
            { ...managedVideoCatalogItem("minimax-h3").videoCapabilities!, operationReferences: { image_to_video: { maxImages: 2 } } },
            true,
        );
        expect(partialOpRefCaps.maxFrameAudios).toBe(3);
        const emptyOpRefCaps = resolveVideoReferenceCapabilities(
            "beeftv::minimax-h3",
            { ...managedVideoCatalogItem("minimax-h3").videoCapabilities!, operationReferences: {} },
            true,
        );
        expect(emptyOpRefCaps.maxFrameAudios).toBe(3);
    });
});

describe("togglePromptFirstFrameMention", () => {
    test("在全能参考模式下切换 @[node:id] 作为首帧，支持清理开头或句中旧子句", () => {
        const refs = makeImageRefs(5);
        const initialPrompt = "镜头推进，树藤疯狂生长";

        const withImg5 = togglePromptFirstFrameMention(initialPrompt, { nodeId: "img-5", token: "@[node:img-5]" }, refs);
        expect(withImg5).toBe("@[node:img-5] 作为首帧，镜头推进，树藤疯狂生长");
        expect(findPromptFirstFrameNodeId(withImg5, refs)).toBe("img-5");

        const switchedToImg2 = togglePromptFirstFrameMention(withImg5, { nodeId: "img-2", token: "@[node:img-2]" }, refs);
        expect(switchedToImg2).toBe("@[node:img-2] 作为首帧，镜头推进，树藤疯狂生长");
        expect(findPromptFirstFrameNodeId(switchedToImg2, refs)).toBe("img-2");

        const toggledOff = togglePromptFirstFrameMention(switchedToImg2, { nodeId: "img-2", token: "@[node:img-2]" }, refs);
        expect(toggledOff).toBe("镜头推进，树藤疯狂生长");
        expect(findPromptFirstFrameNodeId(toggledOff, refs)).toBeUndefined();

        const midSentencePrompt = "镜头推进，@[node:img-1] 作为首帧，树藤疯狂生长";
        expect(findPromptFirstFrameNodeId(midSentencePrompt, refs)).toBe("img-1");
        expect(togglePromptFirstFrameMention(midSentencePrompt, { nodeId: "img-1", token: "@[node:img-1]" }, refs)).toBe("镜头推进，树藤疯狂生长");
        expect(stripPromptFirstFrameClauses(withImg5)).toBe("镜头推进，树藤疯狂生长");
    });
});

describe("buildVideoGenerationMetadata default frame roles", () => {
    test("首尾帧模式未显式写入节点 ID 时默认按连接顺序补齐首帧与尾帧，角色图/音频参考或断开旧帧时不误设", async () => {
        const { buildVideoGenerationMetadata } = await import("../src/lib/canvas/canvas-project-generation");
        const { CanvasNodeType } = await import("../src/types/canvas");
        const twoImageNodes = ["img-1", "img-2"].map((id, index) => ({
            id,
            name: `${id}.png`,
            type: "image/png",
            dataUrl: `https://example.com/${id}.png`,
            position: { x: index * 10, y: 0 },
        }));

        const defaultTwoFrameMeta = buildVideoGenerationMetadata(
            {
                id: "vid-1",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::seedance-2.5" },
            },
            { referenceImages: twoImageNodes, referenceVideos: [], referenceAudios: [] },
        );
        expect(defaultTwoFrameMeta.videoEditOperation).toBe("image_to_video");
        expect(defaultTwoFrameMeta.videoStartFrameNodeId).toBe("img-1");
        expect(defaultTwoFrameMeta.videoEndFrameNodeId).toBe("img-2");

        const singleEndFrameMeta = buildVideoGenerationMetadata(
            {
                id: "vid-2",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::seedance-2.5", videoEndFrameNodeId: "img-1" },
            },
            { referenceImages: [twoImageNodes[0]!], referenceVideos: [], referenceAudios: [] },
        );
        expect(singleEndFrameMeta.videoEditOperation).toBe("image_to_video");
        expect(singleEndFrameMeta.videoStartFrameNodeId).toBeUndefined();
        expect(singleEndFrameMeta.videoEndFrameNodeId).toBe("img-1");

        const staleFrameDroppedMeta = buildVideoGenerationMetadata(
            {
                id: "vid-stale",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::seedance-2.5", videoStartFrameNodeId: "removed-img", videoEndFrameNodeId: "img-1" },
            },
            { referenceImages: [twoImageNodes[0]!], referenceVideos: [], referenceAudios: [] },
        );
        expect(staleFrameDroppedMeta.videoStartFrameNodeId).toBeUndefined();
        expect(staleFrameDroppedMeta.videoEndFrameNodeId).toBe("img-1");

        const withAudioMeta = buildVideoGenerationMetadata(
            {
                id: "vid-audio",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::seedance-2.5" },
            },
            { referenceImages: [twoImageNodes[0]!], referenceVideos: [], referenceAudios: [{ id: "aud-1", name: "a.mp3", type: "audio/mpeg", dataUrl: "" }] },
        );
        expect(withAudioMeta.videoStartFrameNodeId).toBeUndefined();

        const withCharacterImageMeta = buildVideoGenerationMetadata(
            {
                id: "vid-char",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::seedance-2.5" },
            },
            {
                referenceImages: [
                    twoImageNodes[0]!,
                    { id: "character-reference-1", sourceNodeId: "char-1", name: "char.png", type: "image/png", dataUrl: "" },
                ],
                referenceVideos: [],
                referenceAudios: [],
            },
        );
        expect(withCharacterImageMeta.videoStartFrameNodeId).toBeUndefined();
        expect(withCharacterImageMeta.videoEndFrameNodeId).toBeUndefined();

        // 从 H3 Max 切到已声明不支持中间帧的模型时清除残留中间帧字段；部分 AiConfig 缺省字段不抛错，未声明自定义渠道保留自定义中间帧
        const { mergeFetchedChannelModelProfiles } = await import("../src/lib/channel-model-catalog");
        const { createModelChannel, defaultConfig, normalizeConfigSnapshot } = await import("../src/stores/use-config-store");
        const { defaultModelCapabilityConfig } = await import("../src/lib/model-capabilities");
        const beeftvChannel = createModelChannel({
            id: "beeftv",
            name: "BeefTV",
            scope: "system",
            pinned: true,
            credentialRef: "beeftv",
            baseUrl: "https://beeftv.app/v1",
            models: ["wan3.0-video", "minimax-h3-max"],
        });
        beeftvChannel.modelProfiles = mergeFetchedChannelModelProfiles(beeftvChannel, [
            managedVideoCatalogItem("wan3.0-video"),
            managedVideoCatalogItem("minimax-h3-max"),
        ]);
        const declaredWanConfig = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::wan3.0-video", videoModel: "beeftv::wan3.0-video" },
        }).config;

        const switchedFromH3Meta = buildVideoGenerationMetadata(
            {
                id: "vid-from-h3",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: {
                    model: "beeftv::wan3.0-video",
                    videoEditOperation: "image_to_video",
                    videoStartFrameNodeId: "img-1",
                    videoMiddleFrameNodeId: "img-2",
                    videoMiddleFrameTime: 1.8,
                },
            },
            { referenceImages: twoImageNodes, referenceVideos: [], referenceAudios: [] },
            declaredWanConfig,
        );
        expect(switchedFromH3Meta.videoEditOperation).toBe("image_to_video");
        expect(switchedFromH3Meta.videoStartFrameNodeId).toBe("img-1");
        expect(switchedFromH3Meta.videoMiddleFrameNodeId).toBeUndefined();
        expect(switchedFromH3Meta.videoMiddleFrameTime).toBeUndefined();

        const partialConfigMeta = buildVideoGenerationMetadata(
            {
                id: "vid-partial-cfg",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::wan3.0-video", videoEditOperation: "image_to_video", videoStartFrameNodeId: "img-1" },
            },
            { referenceImages: twoImageNodes, referenceVideos: [], referenceAudios: [] },
            { model: "beeftv::wan3.0-video", videoReturnLastFrame: false } as never,
        );
        expect(partialConfigMeta.videoStartFrameNodeId).toBe("img-1");

        const customChannel = createModelChannel({
            id: "custom",
            name: "Custom",
            baseUrl: "https://custom.example/v1",
            models: ["opaque-video"],
        });
        customChannel.modelProfiles = [
            {
                model: "opaque-video",
                capability: "video",
                protocol: "openai-videos",
                capabilityConfig: defaultModelCapabilityConfig(),
            },
        ];
        const opaqueCustomConfig = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [customChannel], model: "custom::opaque-video", videoModel: "custom::opaque-video" },
        }).config;
        const opaqueCustomMeta = buildVideoGenerationMetadata(
            {
                id: "vid-opaque",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: {
                    model: "custom::opaque-video",
                    videoEditOperation: "reference_to_video",
                    videoStartFrameNodeId: "img-1",
                    videoMiddleFrameNodeId: "img-2",
                    videoMiddleFrameTime: 2.5,
                },
            },
            { referenceImages: twoImageNodes, referenceVideos: [], referenceAudios: [] },
            opaqueCustomConfig,
        );
        expect(opaqueCustomMeta.videoEditOperation).toBe("reference_to_video");
        expect(opaqueCustomMeta.videoMiddleFrameNodeId).toBe("img-2");
        expect(opaqueCustomMeta.videoMiddleFrameTime).toBe(2.5);
    });

    test("CanvasConfigComposer 与 CanvasConfigNodePanel 遵循显式 middleFrame 与 operationReferences 声明", async () => {
        const { CanvasConfigComposer } = await import("../src/components/canvas/canvas-config-composer");
        const { buildConfigNodeVideoOperationOptions } = await import("../src/components/canvas/canvas-config-node-panel");
        const { CanvasNodePromptPanel } = await import("../src/components/canvas/canvas-node-prompt-panel");
        const { CanvasNodeType } = await import("../src/types/canvas");
        const { mergeFetchedChannelModelProfiles } = await import("../src/lib/channel-model-catalog");
        const { createModelChannel, defaultConfig, normalizeConfigSnapshot } = await import("../src/stores/use-config-store");
        const wanItem = managedVideoCatalogItem("wan3.0-video");
        const h3MaxOffItem = {
            ...managedVideoCatalogItem("minimax-h3-max"),
            videoCapabilities: { ...managedVideoCatalogItem("minimax-h3-max").videoCapabilities!, middleFrame: false },
        };
        const agnesMidItem = {
            ...wanItem,
            id: "omni-video",
            videoCapabilities: {
                ...wanItem.videoCapabilities!,
                middleFrame: true,
                operationReferences: { image_to_video: { maxImages: 2, maxVideos: 0, maxAudios: 1 } },
            },
        };
        const h3StyleItem = { id: "minimax-h3-max-style-vhs", supportedEndpointTypes: ["openai-video"] };
        const channel = createModelChannel({
            id: "beeftv",
            name: "BeefTV",
            scope: "system",
            pinned: true,
            credentialRef: "beeftv",
            baseUrl: "https://beeftv.app/v1",
            models: ["seedream-5.0", "wan3.0-video", "minimax-h3-max", "omni-video", "minimax-h3-max-style-vhs"],
        });
        channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [
            { id: "seedream-5.0", supportedEndpointTypes: ["openai-image"] },
            wanItem,
            h3MaxOffItem,
            agnesMidItem,
            h3StyleItem,
        ]);
        const nextConfig = normalizeConfigSnapshot({
            config: {
                ...defaultConfig,
                channels: [channel],
                imageModel: "beeftv::seedream-5.0",
                videoModel: "beeftv::wan3.0-video",
            },
        }).config;
        const twoComposerInputs = [
            { nodeId: "img-1", type: "image" as const, title: "分镜1", image: { id: "img-1", name: "1.png", type: "image/png", dataUrl: "https://example.com/1.png", position: { x: 0, y: 0 } } },
            { nodeId: "img-2", type: "image" as const, title: "分镜2", image: { id: "img-2", name: "2.png", type: "image/png", dataUrl: "https://example.com/2.png", position: { x: 0, y: 0 } } },
        ];
        const html = renderToStaticMarkup(
            <CanvasConfigComposer
                config={nextConfig}
                value="主角转身"
                generationMode="video"
                model="beeftv::seedream-5.0"
                metadata={{ model: "beeftv::seedream-5.0", videoEditOperation: "image_to_video" }}
                inputs={twoComposerInputs}
                onChange={() => {}}
                onMetadataChange={() => {}}
                onClose={() => {}}
            />,
        );
        expect(html).toContain("首尾帧");
        expect(html).toContain("全能参考");
        expect(html).toContain("尾帧");

        // 显式 middleFrame: true 的非 H3 模型在 Composer 中渲染中间帧选择器
        const agnesMidHtml = renderToStaticMarkup(
            <CanvasConfigComposer
                config={{ ...nextConfig, videoModel: "beeftv::omni-video" }}
                value="镜头推进"
                generationMode="video"
                model="beeftv::omni-video"
                metadata={{ model: "beeftv::omni-video", videoEditOperation: "reference_to_video" }}
                inputs={twoComposerInputs}
                onChange={() => {}}
                onMetadataChange={() => {}}
                onClose={() => {}}
            />,
        );
        expect(agnesMidHtml).toContain("中间帧");

        // 显式 middleFrame: false 的 H3 Max 在 Composer 与 PromptPanel 中均隐藏中间帧控件
        const h3MaxOffComposerHtml = renderToStaticMarkup(
            <CanvasConfigComposer
                config={{ ...nextConfig, videoModel: "beeftv::minimax-h3-max" }}
                value="镜头推进"
                generationMode="video"
                model="beeftv::minimax-h3-max"
                metadata={{ model: "beeftv::minimax-h3-max", videoEditOperation: "image_to_video" }}
                inputs={twoComposerInputs}
                onChange={() => {}}
                onMetadataChange={() => {}}
                onClose={() => {}}
            />,
        );
        expect(h3MaxOffComposerHtml).not.toContain("中间帧");

        const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
        const queryClient = new QueryClient();
        const h3MaxOffPromptPanelHtml = renderToStaticMarkup(
            <QueryClientProvider client={queryClient}>
                <CanvasNodePromptPanel
                    config={{ ...nextConfig, model: "beeftv::minimax-h3-max", videoModel: "beeftv::minimax-h3-max" }}
                    projectId="proj-1"
                    node={{
                        id: "vid-node",
                        type: CanvasNodeType.Video,
                        title: "Video",
                        position: { x: 0, y: 0 },
                        width: 240,
                        height: 180,
                        metadata: {
                            model: "beeftv::minimax-h3-max",
                            prompt: "测试",
                            videoStartFrameNodeId: "img-1",
                            videoEndFrameNodeId: "img-2",
                        },
                    }}
                    isRunning={false}
                    mentionReferences={makeImageRefs(2)}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(h3MaxOffPromptPanelHtml).not.toContain("展开参数");

        const agnesMidPromptPanelHtml = renderToStaticMarkup(
            <QueryClientProvider client={queryClient}>
                <CanvasNodePromptPanel
                    config={{ ...nextConfig, model: "beeftv::omni-video", videoModel: "beeftv::omni-video" }}
                    projectId="proj-1"
                    node={{
                        id: "vid-node-omni",
                        type: CanvasNodeType.Video,
                        title: "Video",
                        position: { x: 0, y: 0 },
                        width: 240,
                        height: 180,
                        metadata: { model: "beeftv::omni-video", prompt: "测试", videoEditOperation: "reference_to_video" },
                    }}
                    isRunning={false}
                    mentionReferences={makeImageRefs(5)}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(agnesMidPromptPanelHtml).toContain("展开参数");
        expect(agnesMidPromptPanelHtml).not.toContain("写入提示词首帧");

        // CanvasConfigNodePanel 的图生视频选项精确读取 H3 Style 上限（1 图 0 音频）与非 H3 显式音频上限
        const styleSingleImgOptions = buildConfigNodeVideoOperationOptions(
            { ...nextConfig, model: "beeftv::minimax-h3-max-style-vhs" },
            { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 },
        );
        expect(styleSingleImgOptions.find((item) => item.value === "image_to_video")?.disabled).toBe(false);

        const styleTwoImgOptions = buildConfigNodeVideoOperationOptions(
            { ...nextConfig, model: "beeftv::minimax-h3-max-style-vhs" },
            { textCount: 1, imageCount: 2, videoCount: 0, audioCount: 0, characterCount: 0 },
        );
        expect(styleTwoImgOptions.find((item) => item.value === "image_to_video")?.disabled).toBe(true);

        const styleOneAudioOptions = buildConfigNodeVideoOperationOptions(
            { ...nextConfig, model: "beeftv::minimax-h3-max-style-vhs" },
            { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 1, characterCount: 0 },
        );
        expect(styleOneAudioOptions.find((item) => item.value === "image_to_video")?.disabled).toBe(true);

        const agnesOneAudioOptions = buildConfigNodeVideoOperationOptions(
            { ...nextConfig, model: "beeftv::omni-video" },
            { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 1, characterCount: 0 },
        );
        expect(agnesOneAudioOptions.find((item) => item.value === "image_to_video")?.disabled).toBe(false);

        const agnesTwoAudioOptions = buildConfigNodeVideoOperationOptions(
            { ...nextConfig, model: "beeftv::omni-video" },
            { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 2, characterCount: 0 },
        );
        expect(agnesTwoAudioOptions.find((item) => item.value === "image_to_video")?.disabled).toBe(true);

        const { isBeefTVModelRoute, modelCompatibilityError, resolveVideoOperation } = await import("../src/lib/model-selection");
        const { CanvasH3UnsupportedFrames } = await import("../src/components/canvas/canvas-h3-controls");
        const { CanvasConfigNodePanel } = await import("../src/components/canvas/canvas-config-node-panel");
        const { defaultModelCapabilityConfig, videoReferencesForOperation } = await import("../src/lib/model-capabilities");
        expect(
            resolveVideoOperation(
                { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 2, characterCount: 0 },
                "image_to_video",
                { ...managedVideoCatalogItem("minimax-h3").videoCapabilities!, operationReferences: { image_to_video: { maxImages: 2 } } },
                "beeftv::minimax-h3",
                true,
            ),
        ).toBe("image_to_video");
        expect(
            resolveVideoOperation(
                { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 2, characterCount: 0 },
                "image_to_video",
                { ...managedVideoCatalogItem("minimax-h3").videoCapabilities!, operationReferences: {} },
                "beeftv::minimax-h3",
                true,
            ),
        ).toBe("image_to_video");
        expect(
            resolveVideoOperation(
                { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 1, characterCount: 0 },
                "image_to_video",
                managedVideoCatalogItem("minimax-h3").videoCapabilities!,
                "custom::minimax-h3",
                false,
            ),
        ).toBe("reference_to_video");

        // 严格路由判定：有渠道列表时未加渠道前缀的模型（无论渠道顺序如何）或已移除模型均不得误判为 BeefTV 托管路由
        const customDupChannel = createModelChannel({
            id: "custom-dup",
            name: "Custom Dup",
            baseUrl: "https://custom.example/v1",
            models: ["minimax-h3-max", "kling-video-v3"],
        });
        const beeftvWithKlingChannel = createModelChannel({
            ...channel,
            models: [...channel.models, "kling-video-v3"],
        });
        expect(isBeefTVModelRoute("minimax-h3-max")).toBe(false);
        expect(isBeefTVModelRoute("minimax-h3-max", defaultConfig)).toBe(false);
        expect(isBeefTVModelRoute("minimax-h3-max", { ...defaultConfig, baseUrl: "https://beeftv.app/v1" })).toBe(true);
        expect(isBeefTVModelRoute("minimax-h3-max", nextConfig)).toBe(false);
        expect(isBeefTVModelRoute("kling-video-v3", { ...nextConfig, channels: [beeftvWithKlingChannel, customDupChannel] })).toBe(false);
        expect(isBeefTVModelRoute("minimax-h3-max", { ...nextConfig, channels: [customDupChannel, beeftvWithKlingChannel] })).toBe(false);
        expect(isBeefTVModelRoute("custom::removed-model", nextConfig)).toBe(false);
        expect(isBeefTVModelRoute("beeftv::removed-model", nextConfig)).toBe(false);
        expect(isBeefTVModelRoute("beeftv::wan3.0-video", nextConfig)).toBe(true);

        // 未带版本号的自定义 BeefTV 端点渠道：显式 operationReferences 与 middleFrame: false 不得被契约修复覆盖
        const baseUnversionedCap = defaultModelCapabilityConfig("newapi-channel-2", "minimax-h3-max");
        const unversionedBeeftvChannel = createModelChannel({
            id: "my-beeftv",
            name: "My BeefTV",
            baseUrl: "https://beeftv.app/v1",
            models: ["minimax-h3-max", "minimax-h3"],
        });
        unversionedBeeftvChannel.modelProfiles = [
            {
                model: "minimax-h3-max",
                capability: "video",
                protocol: "newapi-channel-2",
                capabilitySource: "user",
                capabilityConfig: {
                    ...baseUnversionedCap,
                    video: { ...baseUnversionedCap.video!, middleFrame: false, operationReferences: {} },
                },
            },
            {
                model: "minimax-h3",
                capability: "video",
                protocol: "newapi-channel-2",
                capabilitySource: "user",
                capabilityConfig: {
                    ...baseUnversionedCap,
                    video: {
                        ...baseUnversionedCap.video!,
                        references: { ...baseUnversionedCap.video!.references, maxAudios: 3 },
                        operationReferences: { image_to_video: { maxImages: 2 } },
                    },
                },
            },
        ];
        const unversionedNormalized = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [unversionedBeeftvChannel], model: "my-beeftv::minimax-h3-max", videoModel: "my-beeftv::minimax-h3-max" },
        }).config;
        const normalizedH3Max = unversionedNormalized.channels[0]!.modelProfiles!.find((p) => p.model === "minimax-h3-max")!.capabilityConfig!.video!;
        expect(normalizedH3Max.middleFrame).toBe(false);
        expect(normalizedH3Max.operationReferences).toEqual({});
        const normalizedH3 = unversionedNormalized.channels[0]!.modelProfiles!.find((p) => p.model === "minimax-h3")!.capabilityConfig!.video!;
        expect(normalizedH3.operationReferences).toEqual({ image_to_video: { maxImages: 2 } });
        expect(videoReferencesForOperation(normalizedH3, "image_to_video").maxAudios).toBe(3);

        // 仅支持首尾帧但 maxImages=9 的模型接入 3 张图时不得回退为 image_to_video 放行
        const frameOnlyMax9Cap = defaultModelCapabilityConfig("openai-videos", "frame9-video");
        frameOnlyMax9Cap.video = {
            ...frameOnlyMax9Cap.video!,
            operations: ["text_to_video", "image_to_video"],
            references: { ...frameOnlyMax9Cap.video!.references, maxImages: 9, maxVideos: 0, maxAudios: 0 },
        };
        const frame9Channel = createModelChannel({
            id: "custom-frame9",
            name: "Custom Frame9",
            baseUrl: "https://custom.example/v1",
            models: ["frame9-video"],
        });
        frame9Channel.modelProfiles = [
            { model: "frame9-video", capability: "video", protocol: "openai-videos", capabilitySource: "user", capabilityConfig: frameOnlyMax9Cap },
        ];
        const frame9Config = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [frame9Channel], model: "custom-frame9::frame9-video", videoModel: "custom-frame9::frame9-video" },
        }).config;
        const threeImagesInput = { textCount: 1, imageCount: 3, videoCount: 0, audioCount: 0, characterCount: 0 };
        expect(resolveVideoOperation(threeImagesInput, undefined, frameOnlyMax9Cap.video, "custom-frame9::frame9-video", false)).toBe("reference_to_video");
        expect(resolveVideoOperation(threeImagesInput, "reference_to_video", frameOnlyMax9Cap.video, "beeftv::minimax-h3-max-turbo", true)).toBe("reference_to_video");
        expect(modelCompatibilityError(frame9Config, "custom-frame9::frame9-video", { capability: "video", input: threeImagesInput })).toBe("最多支持 2 张参考图");

        expect(
            renderToStaticMarkup(
                <CanvasH3UnsupportedFrames
                    model="beeftv::minimax-h3-max"
                    metadata={{ videoMiddleFrameNodeId: "img-2", videoMiddleFrameTime: 2.5 }}
                    middleFrameSupported
                    endFrameSupported
                    onChange={() => {}}
                />,
            ),
        ).toBe("");
        expect(
            renderToStaticMarkup(
                <CanvasH3UnsupportedFrames
                    model="beeftv::minimax-h3-max"
                    metadata={{ videoMiddleFrameNodeId: "img-2", videoMiddleFrameTime: 2.5 }}
                    middleFrameSupported={false}
                    endFrameSupported
                    onChange={() => {}}
                />,
            ),
        ).toContain("清除不支持的帧设置");

        // 完整面板渲染回归：支持中间帧的 H3 Max 已选中间帧时不显示清理提示；显式关闭时 PromptPanel 与 ConfigNodePanel 均显示清理提示
        const liveH3MaxChannel = createModelChannel({
            id: "beeftv",
            name: "BeefTV",
            scope: "system",
            pinned: true,
            apiKey: "synthetic-ui-test-key",
            baseUrl: "https://beeftv.app/v1",
            models: ["minimax-h3-max"],
        });
        liveH3MaxChannel.modelProfiles = mergeFetchedChannelModelProfiles(liveH3MaxChannel, [managedVideoCatalogItem("minimax-h3-max")]);
        const liveH3MaxConfig = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [liveH3MaxChannel], model: "beeftv::minimax-h3-max", videoModel: "beeftv::minimax-h3-max", videoSeconds: "5" },
        }).config;
        const offH3MaxChannel = createModelChannel({
            id: "beeftv",
            name: "BeefTV",
            scope: "system",
            pinned: true,
            apiKey: "synthetic-ui-test-key",
            baseUrl: "https://beeftv.app/v1",
            models: ["minimax-h3-max"],
        });
        offH3MaxChannel.modelProfiles = mergeFetchedChannelModelProfiles(offH3MaxChannel, [h3MaxOffItem]);
        const offH3MaxConfig = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [offH3MaxChannel], model: "beeftv::minimax-h3-max", videoModel: "beeftv::minimax-h3-max", videoSeconds: "5" },
        }).config;
        const h3MidMetadata = {
            generationMode: "video" as const,
            model: "beeftv::minimax-h3-max",
            prompt: "测试",
            videoStartFrameNodeId: "img-1",
            videoMiddleFrameNodeId: "img-2",
            videoEndFrameNodeId: "img-3",
            videoMiddleFrameTime: 2.5,
        };
        const supportedPromptPanelHtml = renderToStaticMarkup(
            <QueryClientProvider client={queryClient}>
                <CanvasNodePromptPanel
                    config={liveH3MaxConfig}
                    projectId="proj-1"
                    node={{ id: "vid-h3-on", type: CanvasNodeType.Video, title: "Video", position: { x: 0, y: 0 }, width: 240, height: 180, metadata: h3MidMetadata }}
                    isRunning={false}
                    mentionReferences={makeImageRefs(3)}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(supportedPromptPanelHtml).toContain("展开参数");
        expect(supportedPromptPanelHtml).not.toContain("写入提示词首帧");

        const unsupportedPromptPanelHtml = renderToStaticMarkup(
            <QueryClientProvider client={queryClient}>
                <CanvasNodePromptPanel
                    config={offH3MaxConfig}
                    projectId="proj-1"
                    node={{ id: "vid-h3-off", type: CanvasNodeType.Video, title: "Video", position: { x: 0, y: 0 }, width: 240, height: 180, metadata: h3MidMetadata }}
                    isRunning={false}
                    mentionReferences={makeImageRefs(3)}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(unsupportedPromptPanelHtml).not.toContain("展开参数");

        const supportedConfigNodeHtml = renderToStaticMarkup(
            <CanvasConfigNodePanel
                config={liveH3MaxConfig}
                node={{ id: "cfg-h3-on", type: CanvasNodeType.Config, title: "Config", position: { x: 0, y: 0 }, width: 240, height: 180, metadata: h3MidMetadata }}
                isRunning={false}
                inputSummary={{ textCount: 1, imageCount: 2, videoCount: 0, audioCount: 0, characterCount: 0 }}
                onConfigChange={() => {}}
                onGenerate={() => {}}
                onComposerToggle={() => {}}
            />,
        );
        expect(supportedConfigNodeHtml).toContain("提示词增强");
        expect(supportedConfigNodeHtml).not.toContain("清除不支持的帧设置");

        const unsupportedConfigNodeHtml = renderToStaticMarkup(
            <CanvasConfigNodePanel
                config={offH3MaxConfig}
                node={{ id: "cfg-h3-off", type: CanvasNodeType.Config, title: "Config", position: { x: 0, y: 0 }, width: 240, height: 180, metadata: h3MidMetadata }}
                isRunning={false}
                inputSummary={{ textCount: 1, imageCount: 2, videoCount: 0, audioCount: 0, characterCount: 0 }}
                onConfigChange={() => {}}
                onGenerate={() => {}}
                onComposerToggle={() => {}}
            />,
        );
        expect(unsupportedConfigNodeHtml).toContain("提示词增强");
        expect(unsupportedConfigNodeHtml).toContain("清除不支持的帧设置");
    });
});

describe("VideoReferenceModeSwitch & ConnectedReferenceShelf UI", () => {
    test("首尾帧模式渲染 [首尾帧 | 全能参考] 切换器、缩略图首帧/尾帧角标与 ⇄ 互换按钮", () => {
        const refs = makeImageRefs(2);
        const state = resolveVideoReferenceModeState({ references: refs });
        const switchHtml = renderToStaticMarkup(
            <VideoReferenceModeSwitch state={state} theme={canvasThemes.dark} onChange={() => {}} />,
        );
        expect(switchHtml).toContain("首尾帧");
        expect(switchHtml).toContain("全能参考");

        const shelfHtml = renderToStaticMarkup(
            <ConnectedReferenceShelf
                references={refs}
                theme={canvasThemes.dark}
                videoModeState={state}
                onInsert={() => {}}
                onVideoMetadataChange={() => {}}
            />,
        );
        expect(shelfHtml).toContain("首帧");
        expect(shelfHtml).toContain("尾帧");
        expect(shelfHtml).toContain("互换首尾帧");
    });

    test("全能参考模式在图片缩略图上渲染提示词首帧快捷按钮", () => {
        const refs = makeImageRefs(5);
        const prompt = "@[node:img-5] 作为首帧，镜头推进";
        const state = resolveVideoReferenceModeState({ references: refs, prompt });
        const shelfHtml = renderToStaticMarkup(
            <ConnectedReferenceShelf
                references={refs}
                theme={canvasThemes.dark}
                videoModeState={state}
                onInsert={() => {}}
                onTogglePromptFirstFrame={() => {}}
            />,
        );
        expect(shelfHtml).toContain("将 图片4 写入提示词首帧");
        expect(shelfHtml).toContain("取消 图片5 提示词首帧");
        expect(state.promptFirstFrameNodeId).toBe("img-5");
    });

    test("H3 首尾帧默认角色、超限模型内联提示、adaptive 比例文案与上传进度/媒体扩展名去重", async () => {
        const { buildVideoGenerationMetadata } = await import("../src/lib/canvas/canvas-project-generation");
        const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
        const { CanvasNodePromptPanel } = await import("../src/components/canvas/canvas-node-prompt-panel");
        const { VideoSettingsPanel } = await import("../src/components/video-settings-panel");
        const { buildNodeGenerationContext } = await import("../src/components/canvas/canvas-node-generation");
        const { formatReferenceUploadProgressDetail } = await import("../src/lib/operation-progress");
        const { mergeFetchedChannelModelProfiles } = await import("../src/lib/channel-model-catalog");
        const { createModelChannel, defaultConfig, normalizeConfigSnapshot } = await import("../src/stores/use-config-store");
        const { CanvasNodeType } = await import("../src/types/canvas");

        const beeftvChannel = createModelChannel({
            id: "beeftv",
            name: "BeefTV",
            scope: "system",
            pinned: true,
            credentialRef: "beeftv",
            baseUrl: "https://beeftv.app/v1",
            models: ["minimax-h3-max", "wan3.0-video"],
        });
        const singleFrameOnlyItem = {
            ...managedVideoCatalogItem("wan3.0-video"),
            id: "single-frame-video",
            displayName: "Single Frame Video",
            videoCapabilities: {
                ...managedVideoCatalogItem("wan3.0-video").videoCapabilities!,
                operations: ["text_to_video", "image_to_video"],
                ratios: ["adaptive", "16:9"],
                references: { minImages: 0, maxImages: 1, maxVideos: 0, maxAudios: 0 },
                operationReferences: { image_to_video: { minImages: 1, maxImages: 1, maxVideos: 0, maxAudios: 0 } },
            },
        };
        beeftvChannel.models.push("single-frame-video");
        beeftvChannel.modelProfiles = mergeFetchedChannelModelProfiles(beeftvChannel, [
            managedVideoCatalogItem("minimax-h3-max"),
            managedVideoCatalogItem("wan3.0-video"),
            singleFrameOnlyItem,
        ]);
        const h3Config = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::minimax-h3-max", videoModel: "beeftv::minimax-h3-max" },
        }).config;
        const twoImageNodes = ["img-1", "img-2"].map((id, index) => ({
            id,
            name: `${id}.png`,
            type: "image/png",
            dataUrl: `https://example.com/${id}.png`,
            position: { x: index * 10, y: 0 },
        }));
        const h3TwoFramesWithAudio = buildVideoGenerationMetadata(
            {
                id: "vid-h3-pair",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::minimax-h3-max" },
            },
            {
                referenceImages: twoImageNodes,
                referenceVideos: [],
                referenceAudios: [{ id: "aud-1", name: "voice.mp3", type: "audio/mpeg", url: "https://example.com/voice.mp3" }],
            },
            h3Config,
        );
        expect(h3TwoFramesWithAudio.videoEditOperation).toBe("image_to_video");
        expect(h3TwoFramesWithAudio.videoStartFrameNodeId).toBe("img-1");
        expect(h3TwoFramesWithAudio.videoEndFrameNodeId).toBe("img-2");

        const singleFrameConfig = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::single-frame-video", videoModel: "beeftv::single-frame-video" },
        }).config;
        const incompatiblePanelHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={{
                        id: "vid-incompatible",
                        type: CanvasNodeType.Video,
                        title: "Video",
                        position: { x: 0, y: 0 },
                        width: 320,
                        height: 180,
                        metadata: { model: "beeftv::single-frame-video", prompt: "测试镜头" },
                    }}
                    config={singleFrameConfig}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={makeImageRefs(2)}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(incompatiblePanelHtml).toContain("最多支持 1 张参考图");
        expect(incompatiblePanelHtml).toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        const settingsHtml = renderToStaticMarkup(
            <VideoSettingsPanel config={singleFrameConfig} theme={canvasThemes.dark} onConfigChange={() => {}} />,
        );
        expect(settingsHtml).toContain("自适应");
        expect(settingsHtml).not.toContain(">adaptive<");

        expect(formatReferenceUploadProgressDetail("transferring", "reference")).toBe("正在上传参考素材");
        expect(formatReferenceUploadProgressDetail("processing", "first_frame")).toBe("正在确认首帧参考图");
        expect(formatReferenceUploadProgressDetail("preparing", "reference_audio")).toBe("正在准备参考音频");
        expect(formatReferenceUploadProgressDetail("transferring", "source")).toBe("正在上传源素材");
        expect(formatReferenceUploadProgressDetail("transferring", "edit_source")).toBe("正在上传编辑源图");

        const mediaNodes = [
            { id: "aud-node", type: CanvasNodeType.Audio, title: "sample.mp3", position: { x: 0, y: 0 }, width: 120, height: 80, metadata: { content: "https://example.com/sample.mp3" } },
            { id: "aud-bare", type: CanvasNodeType.Audio, title: "voice", position: { x: 0, y: 50 }, width: 120, height: 80, metadata: { content: "https://example.com/voice" } },
            { id: "vid-node", type: CanvasNodeType.Video, title: "clip.mp4", position: { x: 0, y: 100 }, width: 120, height: 80, metadata: { content: "https://example.com/clip.mp4" } },
            { id: "target-vid", type: CanvasNodeType.Video, title: "Target", position: { x: 200, y: 0 }, width: 320, height: 180, metadata: {} },
        ];
        const genCtx = buildNodeGenerationContext(
            "target-vid",
            mediaNodes,
            [
                { id: "c1", fromNodeId: "aud-node", toNodeId: "target-vid" },
                { id: "c2", fromNodeId: "aud-bare", toNodeId: "target-vid" },
                { id: "c3", fromNodeId: "vid-node", toNodeId: "target-vid" },
            ],
            "@[node:aud-node] @[node:aud-bare] @[node:vid-node]",
            [],
        );
        expect(genCtx.referenceAudios[0]?.name).toBe("sample.mp3");
        expect(genCtx.referenceAudios[1]?.name).toBe("voice.mp3");
        expect(genCtx.referenceVideos[0]?.name).toBe("clip.mp4");
    });

    test("与 buildNodeGenerationContext 共享兼容门禁（视频全量连线媒体 vs 生图显式 @ 子集/嵌套文本）、ModelPicker 告警、浮层互斥、无封面播放按钮与 auto 比例预览", async () => {
        const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
        const { CanvasNodePromptPanel } = await import("../src/components/canvas/canvas-node-prompt-panel");
        const { buildNodeGenerationContext } = await import("../src/components/canvas/canvas-node-generation");
        const { InactiveVideoPreview } = await import("../src/components/canvas/canvas-node-content");
        const { ModelPicker } = await import("../src/components/model-picker");
        const { VideoSettingsPanel } = await import("../src/components/video-settings-panel");
        const { notifyCanvasPopoverOpen, subscribeCanvasPopoverOpen } = await import("../src/lib/canvas/canvas-popover-layer");
        const { mergeFetchedChannelModelProfiles } = await import("../src/lib/channel-model-catalog");
        const { defaultImageCapabilityConfig } = await import("../src/lib/model-capabilities-image");
        const { useAssetStore } = await import("../src/stores/use-asset-store");
        const { createModelChannel, defaultConfig, normalizeConfigSnapshot } = await import("../src/stores/use-config-store");
        const { CanvasNodeType } = await import("../src/types/canvas");

        const beeftvChannel = createModelChannel({
            id: "beeftv",
            name: "BeefTV",
            scope: "system",
            pinned: true,
            credentialRef: "beeftv",
            baseUrl: "https://beeftv.app/v1",
            models: ["minimax-h3-max", "single-frame-video", "single-ref-image", "text-only-image"],
        });
        const singleFrameOnlyItem = {
            ...managedVideoCatalogItem("wan3.0-video"),
            id: "single-frame-video",
            displayName: "Single Frame Video",
            videoCapabilities: {
                ...managedVideoCatalogItem("wan3.0-video").videoCapabilities!,
                operations: ["text_to_video", "image_to_video"],
                ratios: ["auto", "adaptive", "16:9"],
                references: { minImages: 0, maxImages: 1, maxVideos: 0, maxAudios: 0 },
                operationReferences: { image_to_video: { minImages: 1, maxImages: 1, maxVideos: 0, maxAudios: 0 } },
            },
        };
        const baseImgCap = defaultImageCapabilityConfig();
        const singleRefImageItem = {
            id: "single-ref-image",
            displayName: "Single Ref Image",
            modelType: "image" as const,
            supportedEndpointTypes: ["openai-image"],
            imageCapabilitiesVersion: "2026-04-01",
            imageCapabilities: { ...baseImgCap, references: { ...baseImgCap.references, maxImages: 1 } },
        };
        const textOnlyImageItem = {
            id: "text-only-image",
            displayName: "Text Only Image",
            modelType: "image" as const,
            supportedEndpointTypes: ["openai-image"],
            imageCapabilitiesVersion: "2026-04-01",
            imageCapabilities: { ...baseImgCap, references: { ...baseImgCap.references, maxImages: 0 } },
        };
        beeftvChannel.modelProfiles = mergeFetchedChannelModelProfiles(beeftvChannel, [
            managedVideoCatalogItem("minimax-h3-max"),
            singleFrameOnlyItem,
            singleRefImageItem,
            textOnlyImageItem,
        ]);
        const h3Config = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::minimax-h3-max", videoModel: "beeftv::minimax-h3-max" },
        }).config;
        const singleFrameConfig = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::single-frame-video", videoModel: "beeftv::single-frame-video" },
        }).config;
        const singleRefImageConfig = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::single-ref-image", imageModel: "beeftv::single-ref-image" },
        }).config;
        const textOnlyImageConfig = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::text-only-image", imageModel: "beeftv::text-only-image" },
        }).config;

        const fiveImageNodes = Array.from({ length: 5 }, (_, idx) => ({
            id: `img-${idx + 1}`,
            type: CanvasNodeType.Image,
            title: `镜头${idx + 1}`,
            position: { x: idx * 20, y: 0 },
            width: 120,
            height: 80,
            metadata: { content: `https://example.com/img-${idx + 1}.png` },
        }));
        const edgesTo = (targetId: string, sourceIds: string[]) =>
            sourceIds.map((fromNodeId, idx) => ({ id: `e-${targetId}-${idx}`, fromNodeId, toNodeId: targetId }));

        // 视频执行路径 promptOnly=true 会带入全部已连线媒体：5 张连线图下只 @ 两张或只 @ 文本仍实际提交 5 张，门禁必须如实报错。
        const h3VideoTarget = {
            id: "vid-h3-subset",
            type: CanvasNodeType.Video,
            title: "Video",
            position: { x: 0, y: 120 },
            width: 320,
            height: 180,
            metadata: { model: "beeftv::minimax-h3-max", prompt: "@[node:img-1] @[node:img-2] 推镜" },
        };
        const h3GraphNodes = [h3VideoTarget, ...fiveImageNodes];
        const h3GraphEdges = edgesTo("vid-h3-subset", fiveImageNodes.map((n) => n.id));
        expect(buildNodeGenerationContext("vid-h3-subset", h3GraphNodes, h3GraphEdges, h3VideoTarget.metadata.prompt, [], true, { preserveMediaBindings: true }).imageCount).toBe(5);
        const h3OverLimitHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={h3VideoTarget}
                    referenceNodes={h3GraphNodes}
                    referenceConnections={h3GraphEdges}
                    config={h3Config}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={makeImageRefs(5)}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(h3OverLimitHtml).toContain("最多支持 2 张参考图");
        expect(h3OverLimitHtml).toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        const textNode = {
            id: "txt-1",
            type: CanvasNodeType.Text,
            title: "分镜脚本",
            position: { x: 100, y: 0 },
            width: 160,
            height: 80,
            metadata: { content: "夜景雨巷" },
        };
        const videoTextTarget = {
            id: "vid-text-only",
            type: CanvasNodeType.Video,
            title: "Video",
            position: { x: 0, y: 120 },
            width: 320,
            height: 180,
            metadata: { model: "beeftv::single-frame-video", prompt: "@[node:txt-1] 按分镜生成" },
        };
        const videoTextNodes = [videoTextTarget, ...fiveImageNodes, textNode];
        const videoTextEdges = edgesTo("vid-text-only", [...fiveImageNodes.map((n) => n.id), "txt-1"]);
        expect(buildNodeGenerationContext("vid-text-only", videoTextNodes, videoTextEdges, videoTextTarget.metadata.prompt, [], true, { preserveMediaBindings: true }).imageCount).toBe(5);
        const videoTextOverLimitHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={videoTextTarget}
                    referenceNodes={videoTextNodes}
                    referenceConnections={videoTextEdges}
                    config={singleFrameConfig}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={[
                        ...makeImageRefs(5),
                        { id: "txt-1", nodeId: "txt-1", kind: "text", label: "文本1", title: "分镜脚本", text: "夜景雨巷", active: true },
                    ]}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(videoTextOverLimitHtml).toContain("最多支持 1 张参考图");
        expect(videoTextOverLimitHtml).toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        // 生图执行路径 promptOnly=false, preserveMediaBindings=false：显式 @ 只计被引用图片，文本内嵌套的 @[node:img-1] 不会误算参考图。
        const imageSubsetTarget = {
            id: "img-target-subset",
            type: CanvasNodeType.Image,
            title: "Image",
            position: { x: 0, y: 120 },
            width: 320,
            height: 180,
            metadata: { model: "beeftv::single-ref-image", prompt: "@[node:img-1] 局部重绘" },
        };
        const imageSubsetNodes = [imageSubsetTarget, ...fiveImageNodes];
        const imageSubsetEdges = edgesTo("img-target-subset", fiveImageNodes.map((n) => n.id));
        expect(buildNodeGenerationContext("img-target-subset", imageSubsetNodes, imageSubsetEdges, imageSubsetTarget.metadata.prompt, [], false).imageCount).toBe(1);
        const imageSubsetHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={imageSubsetTarget}
                    referenceNodes={imageSubsetNodes}
                    referenceConnections={imageSubsetEdges}
                    config={singleRefImageConfig}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={makeImageRefs(5)}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(imageSubsetHtml).not.toContain("最多支持");
        expect(imageSubsetHtml).not.toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        const nestedMediaTextNode = {
            id: "txt-nested-img",
            type: CanvasNodeType.Text,
            title: "带图token脚本",
            position: { x: 100, y: 0 },
            width: 160,
            height: 80,
            metadata: { content: "镜头参考 @[node:img-1] 的构图" },
        };
        const imageNestedTarget = {
            id: "img-nested-target",
            type: CanvasNodeType.Image,
            title: "Image",
            position: { x: 0, y: 120 },
            width: 320,
            height: 180,
            metadata: { model: "beeftv::text-only-image", prompt: "@[node:txt-nested-img] 生成概念图" },
        };
        const imageNestedNodes = [imageNestedTarget, fiveImageNodes[0]!, nestedMediaTextNode];
        const imageNestedEdges = edgesTo("img-nested-target", ["img-1", "txt-nested-img"]);
        expect(buildNodeGenerationContext("img-nested-target", imageNestedNodes, imageNestedEdges, imageNestedTarget.metadata.prompt, [], false).imageCount).toBe(0);
        const imageNestedHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={imageNestedTarget}
                    referenceNodes={imageNestedNodes}
                    referenceConnections={imageNestedEdges}
                    config={textOnlyImageConfig}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={[
                        makeImageRefs(1)[0]!,
                        { id: "txt-nested-img", nodeId: "txt-nested-img", kind: "text", label: "文本1", title: "带图token脚本", text: "镜头参考 @[node:img-1] 的构图", active: true },
                    ]}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(imageNestedHtml).not.toContain("最多支持");
        expect(imageNestedHtml).not.toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        const selfVideoRegenHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={{
                        id: "vid-self",
                        type: CanvasNodeType.Video,
                        title: "Video",
                        position: { x: 0, y: 0 },
                        width: 320,
                        height: 180,
                        metadata: { model: "beeftv::single-frame-video", prompt: "重新生成新镜头", content: "https://example.com/old.mp4" },
                    }}
                    config={singleFrameConfig}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={[{ id: "vid-self", nodeId: "vid-self", kind: "video", label: "视频1", title: "Video", active: true }]}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(selfVideoRegenHtml).not.toContain("不支持参考视频");
        expect(selfVideoRegenHtml).not.toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        const prevAssets = useAssetStore.getState().assets;
        const prevInitialAssets = useAssetStore.getInitialState().assets;
        try {
            const now = "2026-11-12T00:00:00.000Z";
            const mockAssets = ["asset-1", "asset-2"].map((id, idx) => ({
                id,
                kind: "image" as const,
                title: `素材图${idx + 1}`,
                coverUrl: `https://example.com/${id}.png`,
                tags: [],
                createdAt: now,
                updatedAt: now,
                data: { dataUrl: `https://example.com/${id}.png`, width: 512, height: 512, bytes: 1024, mimeType: "image/png" },
            }));
            useAssetStore.getInitialState().assets = mockAssets;
            useAssetStore.setState({ assets: mockAssets });
            const assetOverflowHtml = renderToStaticMarkup(
                <QueryClientProvider client={new QueryClient()}>
                    <CanvasNodePromptPanel
                        node={{
                            id: "vid-asset-overflow",
                            type: CanvasNodeType.Video,
                            title: "Video",
                            position: { x: 0, y: 0 },
                            width: 320,
                            height: 180,
                            metadata: { model: "beeftv::single-frame-video", prompt: "@[asset:asset-1] @[asset:asset-2] 双图运动" },
                        }}
                        config={singleFrameConfig}
                        projectId="proj-1"
                        isRunning={false}
                        mentionReferences={[]}
                        onPromptChange={() => {}}
                        onConfigChange={() => {}}
                        onGenerate={() => {}}
                    />
                </QueryClientProvider>,
            );
            expect(assetOverflowHtml).toContain("最多支持 1 张参考图");
            expect(assetOverflowHtml).toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);
        } finally {
            useAssetStore.getInitialState().assets = prevInitialAssets;
            useAssetStore.setState({ assets: prevAssets });
        }

        const pickerWarningHtml = renderToStaticMarkup(
            <ModelPicker
                config={singleFrameConfig}
                value="beeftv::single-frame-video"
                capability="video"
                requirements={{ capability: "video", input: { textCount: 1, imageCount: 2, videoCount: 0, audioCount: 0, characterCount: 0 } }}
                onChange={() => {}}
            />,
        );
        expect(pickerWarningHtml).toContain('aria-invalid="true"');
        expect(pickerWarningHtml).toContain("最多支持 1 张参考图");

        const hadWindow = "window" in globalThis;
        const previousWindow = (globalThis as { window?: unknown }).window;
        if (!hadWindow || !previousWindow) {
            (globalThis as { window?: unknown }).window = new EventTarget();
        }
        try {
            let closedCount = 0;
            const unsubscribe = subscribeCanvasPopoverOpen("video-settings", () => {
                closedCount += 1;
            });
            notifyCanvasPopoverOpen("video-settings");
            expect(closedCount).toBe(0);
            notifyCanvasPopoverOpen("model-picker");
            expect(closedCount).toBe(1);
            unsubscribe();
            notifyCanvasPopoverOpen("model-picker");
            expect(closedCount).toBe(1);
        } finally {
            if (!hadWindow) delete (globalThis as { window?: unknown }).window;
            else (globalThis as { window?: unknown }).window = previousWindow;
        }

        const inactiveVideoHtml = renderToStaticMarkup(
            <InactiveVideoPreview
                node={{
                    id: "vid-inactive",
                    type: CanvasNodeType.Video,
                    title: "测试成片",
                    position: { x: 0, y: 0 },
                    width: 320,
                    height: 180,
                    metadata: { content: "https://example.com/out.mp4" },
                }}
                theme={canvasThemes.dark}
                hoverEnabled={false}
                onPlay={() => {}}
            />,
        );
        expect(inactiveVideoHtml).toContain('aria-label="播放 测试成片"');
        expect(inactiveVideoHtml).not.toContain("absolute left-1/2 top-1/2");
        expect(inactiveVideoHtml.indexOf('aria-label="播放 测试成片"')).toBeLessThan(inactiveVideoHtml.indexOf('title="测试成片"'));

        const autoAndAdaptiveSettingsHtml = renderToStaticMarkup(
            <VideoSettingsPanel config={singleFrameConfig} theme={canvasThemes.dark} onConfigChange={() => {}} />,
        );
        expect(autoAndAdaptiveSettingsHtml.match(/>自适应</g)?.length).toBe(2);
        expect(autoAndAdaptiveSettingsHtml).not.toContain(">auto<");
        expect(autoAndAdaptiveSettingsHtml).not.toContain(">adaptive<");
        expect(autoAndAdaptiveSettingsHtml.match(/rounded-\[2px\]/g)?.length).toBe(1);
    });
});
