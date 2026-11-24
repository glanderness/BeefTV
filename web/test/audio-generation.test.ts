import { readFileSync } from "node:fs";
import { describe, expect, spyOn, test } from "bun:test";
import { App } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { buildNodeGenerationContext, hydrateNodeGenerationContext, resolveCanvasNodeGenerationPreview } from "@/components/canvas/canvas-node-generation";
import { buildNodeConfig } from "@/components/canvas/canvas-node-prompt-panel";
import { audioSettingsSummary, audioSpeechProfile, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue, resolveAudioSpeechSettings } from "@/lib/audio-generation";
import { canvasConnectionError } from "@/lib/canvas/canvas-connection-policy";
import { buildCanvasGenerationRequirements } from "@/lib/canvas/canvas-generation-config";
import * as canvasProjectGeneration from "@/lib/canvas/canvas-project-generation";
import { getNodeResourceKind } from "@/lib/canvas/node-registry";
import { audioSubmissionCompatibilityError, modelCompatibilityError } from "@/lib/model-selection";
import { useCanvasGenerationExecutor } from "@/pages/canvas/use-canvas-generation-executor";
import { useCanvasGenerationRetry } from "@/pages/canvas/use-canvas-generation-retry";
import * as projects from "@/services/api/projects";
import { createCanvasPageUiStore } from "@/stores/canvas/use-canvas-page-ui-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import * as configStore from "@/stores/use-config-store";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, type AiConfig } from "@/stores/use-config-store";

function audioNode(patch: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return {
        id: "audio-1",
        type: CanvasNodeType.Audio,
        title: "旁白",
        position: { x: 0, y: 0 },
        width: 320,
        height: 120,
        metadata: {},
        ...patch,
    };
}

function enterpriseConfig(): AiConfig {
    const channel = createModelChannel({
        id: "beeftv",
        name: "BeefTV",
        baseUrl: "https://beeftv.app",
        interfaceType: "openai-audio",
        models: ["minimax-speech-2.8-hd", "minimax-music-v3.0", "gpt-4o-mini-tts"],
        modelProfiles: [
            { model: "minimax-speech-2.8-hd", capability: "audio", protocol: "openai-audio" },
            { model: "minimax-music-v3.0", capability: "audio", protocol: "openai-audio" },
            { model: "gpt-4o-mini-tts", capability: "audio", protocol: "openai-audio" },
        ],
    });
    return {
        ...defaultConfig,
        channels: [channel],
        audioModel: "beeftv::minimax-speech-2.8-hd",
        audioVoice: "alloy",
        audioFormat: "mp3",
        audioSpeed: "1",
    };
}

describe("enterprise MiniMax speech settings", () => {
    test('blank speed stays 1 instead of clamping Number("") to the floor', () => {
        expect(normalizeAudioSpeedValue("", "minimax-speech-2.8-hd")).toBe("1");
        expect(normalizeAudioSpeedValue("  ", "gpt-4o-mini-tts")).toBe("1");
        expect(resolveAudioSpeechSettings("minimax-speech-2.8-hd", {}).audioSpeed).toBe("1");
        expect(normalizeAudioSpeedValue("0", "minimax-speech-2.8-hd")).toBe("1");
        expect(normalizeAudioSpeedValue("1.25", "minimax-speech-2.8-hd")).toBe("1.25");
    });

    test("MiniMax formats follow the native adapter, not OpenAI-only opus", () => {
        expect(audioSpeechProfile("minimax-speech-2.8-hd").formats.map((item) => item.value)).toEqual(["mp3", "wav", "aac", "flac", "pcm"]);
        expect(audioSpeechProfile("minimax-music-v3.0").formats.map((item) => item.value)).toEqual(["mp3"]);
        expect(normalizeAudioFormatValue("flac", "minimax-music-v3.0")).toBe("mp3");
        expect(audioSettingsSummary({ model: "minimax-music-v3.0", audioFormat: "flac" })).toBe("MP3 · 256 kbps");
        expect(audioSpeechProfile("gpt-4o-mini-tts").formats.map((item) => item.value)).toContain("opus");
        expect(normalizeAudioFormatValue("opus", "minimax-speech-2.8-hd")).toBe("mp3");
    });

    test("does not coerce MiniMax voices onto OpenAI alloy", () => {
        expect(normalizeAudioVoiceValue("alloy", "beeftv::minimax-speech-2.8-hd")).toBe("male-qn-qingse");
        expect(normalizeAudioVoiceValue("中文", "minimax-speech-2.8-hd")).toBe("male-qn-qingse");
        expect(normalizeAudioVoiceValue("male-qn-jingying", "minimax-speech-2.8-hd")).toBe("male-qn-jingying");
        expect(normalizeAudioVoiceValue("cloned-voice-abc", "minimax-speech-2.8-hd")).toBe("cloned-voice-abc");
        expect(normalizeAudioVoiceValue("alloy", "gpt-4o-mini-tts")).toBe("alloy");
    });

    test("summary follows the speech contract instead of 中文 · 24k · wav", () => {
        const settings = resolveAudioSpeechSettings("beeftv::minimax-speech-2.8-hd", {
            audioVoice: "alloy",
            audioFormat: "mp3",
            audioSpeed: "1",
        });
        expect(audioSettingsSummary({ model: "beeftv::minimax-speech-2.8-hd", ...settings })).toBe("青涩青年 · MP3 · 1x");
        expect(audioSettingsSummary({ model: "beeftv::minimax-speech-2.8-hd", ...settings })).not.toContain("24k");
        expect(audioSettingsSummary({ model: "beeftv::minimax-speech-2.8-hd", ...settings })).not.toContain("中文");
    });

    test("canvas node config remaps enterprise speech defaults for the selected model", () => {
        const config = buildNodeConfig(enterpriseConfig(), audioNode(), "audio", { capability: "audio" });
        expect(config.model).toContain("minimax-speech-2.8-hd");
        expect(config.audioVoice).toBe("male-qn-qingse");
        expect(config.audioFormat).toBe("mp3");
        expect(audioSettingsSummary(config)).toBe("青涩青年 · MP3 · 1x");
    });

    test("Seed-Audio defaults to auto omni-reference mode and normalizes stale MiniMax/OpenAI voices to auto", () => {
        expect(audioSpeechProfile("beeftv::seed-audio-1.0").kind).toBe("seed-audio");
        expect(audioSpeechProfile("beeftv::seed-audio-1.0").defaultVoice).toBe("auto");
        expect(audioSpeechProfile("beeftv::seed-audio-1.0").formats.map((item) => item.value)).toEqual(["mp3"]);
        expect(audioSpeechProfile("beeftv::seed-audio-1.0").showInstructions).toBe(true);
        expect(audioSpeechProfile("beeftv::seed-audio-1.0").showPitch).toBe(true);
        expect(audioSpeechProfile("beeftv::seed-audio-1.0").showVolume).toBe(true);
        expect(normalizeAudioVoiceValue("male-qn-qingse", "beeftv::seed-audio-1.0")).toBe("auto");
        expect(normalizeAudioVoiceValue("alloy", "beeftv::seed-audio-1.0")).toBe("auto");
        expect(normalizeAudioVoiceValue("zh_female_cancan_uranus_bigtts", "beeftv::seed-audio-1.0")).toBe("zh_female_cancan_uranus_bigtts");
        expect(normalizeAudioVoiceValue("zh_male_taocheng_uranus_bigtts", "beeftv::seed-audio-1.0")).toBe("zh_male_taocheng_uranus_bigtts");
        expect(normalizeAudioVoiceValue("auto", "beeftv::minimax-speech-2.8-hd")).toBe("male-qn-qingse");
        expect(normalizeAudioVoiceValue("zh_female_cancan_uranus_bigtts", "beeftv::minimax-speech-2.8-hd")).toBe("male-qn-qingse");
        expect(audioSettingsSummary({ model: "beeftv::seed-audio-1.0", audioVoice: "male-qn-qingse", audioFormat: "mp3", audioSpeed: "1" })).toBe("自动（全能参考） · MP3 · 1x");
        expect(audioSettingsSummary({ model: "beeftv::seed-audio-1.0", audioVoice: "zh_male_taocheng_uranus_bigtts", audioFormat: "mp3", audioSpeed: "1.25", audioPitch: "2", audioVolume: "1.3" })).toBe("阳光小天 · MP3 · 1.25x · 音调+2 · 音量130%");
    });

    test("prompt panel no longer overlays a fake Seed Audio summary", () => {
        const source = readFileSync(new URL("../src/components/canvas/canvas-node-prompt-panel.tsx", import.meta.url), "utf8");
        expect(source).not.toContain("中文 · 24k · wav");
        expect(source).not.toContain('summaryOverride={localOnly ? "中文');
    });
});

function managedVoiceCloneConfig(): AiConfig {
    // Matches the snake_case mediaCapabilities JSON persisted by backend/internal/beeftv/catalog.go.
    const channel = createModelChannel({
        id: "beeftv",
        name: "BeefTV",
        baseUrl: "https://beeftv.app/v1",
        apiKey: "fixture-key",
        hasApiKey: true,
        credentialRef: "beeftv",
        models: ["seed-audio-1.0", "minimax-speech-2.8-hd", "minimax-music-v3.0"],
        modelProfiles: [
            {
                model: "seed-audio-1.0",
                capability: "audio",
                protocol: "openai-audio",
                mediaCapabilitiesVersion: "v1-seed",
                mediaCapabilities: {
                    audio: {
                        operations: ["synthesize"],
                        options: ["voice", "speed", "pitch", "volume", "instructions"],
                        reference_kinds: ["image", "audio"],
                        max_outputs: 1,
                    },
                } as never,
            },
            {
                model: "minimax-speech-2.8-hd",
                capability: "audio",
                protocol: "openai-audio",
                mediaCapabilitiesVersion: "v1-minimax",
                mediaCapabilities: {
                    audio: {
                        operations: ["synthesize"],
                        options: ["voice", "speed"],
                        reference_kinds: [],
                        max_outputs: 1,
                    },
                } as never,
            },
            {
                model: "minimax-music-v3.0",
                capability: "audio",
                protocol: "openai-audio",
                mediaCapabilitiesVersion: "v1-music",
                mediaCapabilities: {
                    audio: {
                        operations: ["generate"],
                        options: ["lyrics"],
                        reference_kinds: [],
                        max_outputs: 1,
                    },
                } as never,
            },
        ],
    });
    return normalizeConfigSnapshot({
        config: {
            ...defaultConfig,
            channels: [channel],
            audioModel: "beeftv::seed-audio-1.0",
            audioVoice: "auto",
            audioFormat: "mp3",
            audioSpeed: "1",
        },
    }).config;
}

describe("audio reference cloning compatibility and connections", () => {
    test("normalizes snake_case mediaCapabilities from backend config snapshots", () => {
        const config = managedVoiceCloneConfig();
        const seedProfile = config.channels[0]?.modelProfiles?.find((item) => item.model === "seed-audio-1.0");
        expect(seedProfile?.mediaCapabilities?.audio?.referenceKinds).toEqual(["image", "audio"]);
        expect(seedProfile?.mediaCapabilities?.audio?.maxOutputs).toBe(1);
    });

    test("allows Seed-Audio voice cloning and image-to-voice while blocking unsupported audio models", () => {
        const config = managedVoiceCloneConfig();
        const trackNode = audioNode({
            id: "track-1",
            title: "sample · 音轨",
            metadata: { storageKey: "resource:res-1", mimeType: "audio/mpeg", durationMs: 12000 },
        });
        const genNode = audioNode({
            id: "audio-gen-1",
            metadata: { model: "beeftv::seed-audio-1.0", audioVoice: "auto", audioFormat: "mp3", audioSpeed: "1" },
        });
        const connections: CanvasConnection[] = [{ id: "edge-1", fromNodeId: trackNode.id, toNodeId: genNode.id }];
        const prompt = "新文案：【测试朗读】@[node:track-1]";

        expect(getNodeResourceKind(trackNode)).toBe("audio");

        const preview = resolveCanvasNodeGenerationPreview(genNode, "audio", prompt, [trackNode, genNode], connections, []);
        expect(preview.inputSummary.audioCount).toBe(1);
        const requirements = buildCanvasGenerationRequirements(config, genNode, "audio", preview.inputSummary);
        expect(modelCompatibilityError(config, "beeftv::seed-audio-1.0", requirements)).toBe("");
        expect(modelCompatibilityError(config, "beeftv::minimax-speech-2.8-hd", requirements)).toBe("不支持参考音频");
        expect(modelCompatibilityError(config, "beeftv::minimax-music-v3.0", requirements)).toBe("不支持参考音频");

        const built = buildNodeGenerationContext(genNode.id, [trackNode, genNode], connections, prompt, []);
        expect(built.prompt).toBe("新文案：【测试朗读】@音频1");
        expect(built.referenceAudios).toHaveLength(1);
        expect(built.referenceAudios[0]?.storageKey).toBe("resource:res-1");

        expect(modelCompatibilityError(config, "beeftv::seed-audio-1.0", { capability: "audio", input: { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 } })).toBe("");
        expect(modelCompatibilityError(config, "beeftv::minimax-speech-2.8-hd", { capability: "audio", input: { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 } })).toBe("不支持参考图片");
        expect(modelCompatibilityError(config, "beeftv::seed-audio-1.0", { capability: "audio", input: { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 1, characterCount: 0 } })).toBe("");
        expect(modelCompatibilityError(config, "beeftv::seed-audio-1.0", { capability: "audio", input: { textCount: 1, imageCount: 0, videoCount: 1, audioCount: 0, characterCount: 0 } })).toBe("音频模型不支持参考视频");
        expect(modelCompatibilityError(config, "beeftv::seed-audio-1.0", { capability: "audio", input: { textCount: 1, imageCount: 0, videoCount: 0, audioCount: 0, characterCount: 2 } })).toBe("角色配音一次只能引用一个角色卡");
        expect(modelCompatibilityError(config, "beeftv::minimax-speech-2.8-hd", { capability: "audio", input: { textCount: 1, imageCount: 0, videoCount: 0, audioCount: 0, characterCount: 1 } })).toBe("");
    });

    test("checks hydrated character card portrait compatibility before audio submission", async () => {
        const config = managedVoiceCloneConfig();
        const characterSpy = spyOn(projects, "getProjectCharacter");
        const baseContext = {
            prompt: "你好世界",
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            characterReferences: [{ nodeId: "char-node", assetId: "char-1" }],
            resolvedCharacterVersions: [],
            resolvedCharacterVoices: [],
            textCount: 1,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
        try {
            characterSpy.mockResolvedValueOnce({
                asset: { id: "char-1", title: "角色A" },
                character: { versionId: "v1", definition: {}, representations: [{ id: "rep-1", resourceId: "res-portrait", role: "primary" }] },
            } as Awaited<ReturnType<typeof projects.getProjectCharacter>>);
            const voicelessHydrated = await hydrateNodeGenerationContext(baseContext, "canvas-1", "project-1", "audio", false, false);
            const voicelessInput = { textCount: 1, imageCount: voicelessHydrated.imageCount, videoCount: 0, audioCount: voicelessHydrated.audioCount, characterCount: 0 };
            expect(voicelessHydrated.imageCount).toBe(1);
            expect(modelCompatibilityError(config, "beeftv::minimax-speech-2.8-hd", { capability: "audio", input: voicelessInput })).toBe("不支持参考图片");
            expect(modelCompatibilityError(config, "beeftv::seed-audio-1.0", { capability: "audio", input: voicelessInput })).toBe("");

            characterSpy.mockResolvedValueOnce({
                asset: { id: "char-1", title: "角色A" },
                character: {
                    versionId: "v2",
                    definition: {},
                    representations: [{ id: "rep-1", resourceId: "res-portrait", role: "primary" }],
                    voice: { profile: { voiceKey: "male-qn-qingse" } },
                },
            } as Awaited<ReturnType<typeof projects.getProjectCharacter>>);
            const voicedHydrated = await hydrateNodeGenerationContext(baseContext, "canvas-1", "project-1", "audio", false, false);
            const voicedInput = { textCount: 1, imageCount: voicedHydrated.imageCount, videoCount: 0, audioCount: voicedHydrated.audioCount, characterCount: 0 };
            expect(voicedHydrated.imageCount).toBe(0);
            expect(modelCompatibilityError(config, "beeftv::minimax-speech-2.8-hd", { capability: "audio", input: voicedInput })).toBe("");
            expect(audioSubmissionCompatibilityError(config, "beeftv::minimax-speech-2.8-hd", voicelessInput)).toBe("当前音频模型不支持参考图片。请切换兼容模型或调整已连接的参考素材。");
            expect(audioSubmissionCompatibilityError(config, "beeftv::seed-audio-1.0", { textCount: 1, imageCount: 0, videoCount: 1, audioCount: 0, characterCount: 0 })).toBe("音频模型不支持参考视频。请切换兼容模型或调整已连接的参考素材。");
            expect(audioSubmissionCompatibilityError(config, "beeftv::seed-audio-1.0", { textCount: 1, imageCount: 0, videoCount: 0, audioCount: 0, characterCount: 2 })).toBe("角色配音一次只能引用一个角色卡。请切换兼容模型或调整已连接的参考素材。");
        } finally {
            characterSpy.mockRestore();
        }
    });

    test("executor and retry hooks enforce post-hydration audio compatibility for voiceless character cards", async () => {
        const config = managedVoiceCloneConfig();
        const characterNode: CanvasNodeData = {
            id: "char-node",
            type: CanvasNodeType.Text,
            title: "角色A",
            position: { x: 0, y: 0 },
            width: 320,
            height: 320,
            metadata: {
                content: "角色设定",
                workflowKind: "character",
                characterAssetId: "char-1",
            },
        };
        const minimaxAudioNode = audioNode({
            id: "audio-minimax",
            metadata: {
                status: "error",
                prompt: "你好世界",
                model: "beeftv::minimax-speech-2.8-hd",
                audioVoice: "male-qn-qingse",
                audioFormat: "mp3",
                audioSpeed: "1",
            },
        });
        const seedAudioNode = audioNode({
            id: "audio-seed",
            metadata: {
                status: "error",
                prompt: "你好世界",
                model: "beeftv::seed-audio-1.0",
                audioVoice: "auto",
                audioFormat: "mp3",
                audioSpeed: "1",
            },
        });
        const connections: CanvasConnection[] = [
            { id: "edge-minimax", fromNodeId: characterNode.id, toNodeId: minimaxAudioNode.id },
            { id: "edge-seed", fromNodeId: characterNode.id, toNodeId: seedAudioNode.id },
        ];
        const characterSpy = spyOn(projects, "getProjectCharacter").mockResolvedValue({
            asset: { id: "char-1", title: "角色A" },
            character: { versionId: "v1", definition: {}, representations: [{ id: "rep-1", resourceId: "res-portrait", role: "primary" }] },
        } as Awaited<ReturnType<typeof projects.getProjectCharacter>>);
        const consumerCalls: Array<Parameters<typeof canvasProjectGeneration.runCanvasGenerationTaskToConsumer>[0]> = [];
        const consumerSpy = spyOn(canvasProjectGeneration, "runCanvasGenerationTaskToConsumer").mockImplementation(async (input) => {
            consumerCalls.push(input);
        });
        const errorToasts: string[] = [];
        const appSpy = spyOn(App, "useApp").mockReturnValue({
            message: {
                loading: () => {},
                destroy: () => {},
                error: (text: string) => { errorToasts.push(String(text)); },
                info: () => {},
                warning: () => {},
            },
            modal: { confirm: () => ({ destroy() {} }) },
            notification: {},
        } as unknown as ReturnType<typeof App.useApp>);

        const configSpy = spyOn(configStore, "useEffectiveConfig").mockReturnValue(config);
        const pageUi = createCanvasPageUiStore();
        const nodesRef = { current: [characterNode, minimaxAudioNode, seedAudioNode] };
        const connectionsRef = { current: connections };
        let generate!: ReturnType<typeof useCanvasGenerationExecutor>;
        let retry!: ReturnType<typeof useCanvasGenerationRetry>;
        function Harness() {
            generate = useCanvasGenerationExecutor({
                pageUi,
                projectId: "canvas-audio-guard",
                domainProjectId: "project-1",
                addedSkills: [],
                assets: [],
                nodesRef,
                connectionsRef,
                setNodes: (updater) => {
                    nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
                },
                setConnections: (updater) => {
                    connectionsRef.current = typeof updater === "function" ? updater(connectionsRef.current) : updater;
                },
                setRunningNodeId: () => {},
                startGenerationRequest: () => new AbortController(),
                finishGenerationRequest: () => {},
                bindGenerationTask: () => {},
                applyGenerationTaskResult: async () => {},
            });
            retry = useCanvasGenerationRetry({
                projectId: "canvas-audio-guard",
                domainProjectId: "project-1",
                addedSkills: [],
                assets: [],
                nodesRef,
                connectionsRef,
                setNodes: (updater) => {
                    nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
                },
                setRunningNodeId: () => {},
                startGenerationRequest: () => new AbortController(),
                finishGenerationRequest: () => {},
                bindGenerationTask: () => {},
                applyGenerationTaskResult: async () => {},
                regenerateImageBatch: async () => {},
            });
            return null;
        }

        try {
            renderToStaticMarkup(createElement(Harness));

            await generate(minimaxAudioNode.id, "audio", "你好世界");
            expect(consumerCalls).toHaveLength(0);
            expect(nodesRef.current.find((item) => item.id === minimaxAudioNode.id)?.metadata?.generationPreflightError).toBe("当前音频模型不支持参考图片。请切换兼容模型或调整已连接的参考素材。");

            await retry(minimaxAudioNode);
            expect(consumerCalls).toHaveLength(0);
            expect(nodesRef.current.find((item) => item.id === minimaxAudioNode.id)?.metadata?.errorDetails).toBe("当前音频模型不支持参考图片。请切换兼容模型或调整已连接的参考素材。");

            await retry(seedAudioNode);
            expect(consumerCalls).toHaveLength(1);
            expect(consumerCalls[0]?.mode).toBe("audio");
            expect(consumerCalls[0]?.config.model).toBe("beeftv::seed-audio-1.0");
            expect(consumerCalls[0]?.referenceImages).toHaveLength(1);
            expect(errorToasts).toEqual([
                "当前音频模型不支持参考图片。请切换兼容模型或调整已连接的参考素材。",
                "当前音频模型不支持参考图片。请切换兼容模型或调整已连接的参考素材。",
            ]);
        } finally {
            configSpy.mockRestore();
            appSpy.mockRestore();
            characterSpy.mockRestore();
            consumerSpy.mockRestore();
        }
    });

    test("does not falsely block undeclared custom audio channels on reference media", () => {
        const config = enterpriseConfig();
        expect(modelCompatibilityError(config, "beeftv::minimax-speech-2.8-hd", { capability: "audio", input: { textCount: 1, imageCount: 0, videoCount: 0, audioCount: 1, characterCount: 0 } })).toBe("");
        expect(modelCompatibilityError(config, "beeftv::minimax-speech-2.8-hd", { capability: "audio", input: { textCount: 1, imageCount: 0, videoCount: 1, audioCount: 0, characterCount: 0 } })).toBe("音频模型不支持参考视频");
    });

    test("allows wiring reference audio and image into audio nodes when a configured audio model supports them", () => {
        const config = managedVoiceCloneConfig();
        const trackNode = audioNode({ id: "track-1", metadata: { storageKey: "resource:res-1" } });
        const imgNode: CanvasNodeData = { id: "img-1", type: CanvasNodeType.Image, title: "图", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "https://example.com/a.png" } };
        const videoNode: CanvasNodeData = { id: "vid-1", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "https://example.com/a.mp4" } };
        const upscaleNode: CanvasNodeData = { id: "up-1", type: CanvasNodeType.Upscale, title: "超分", position: { x: 0, y: 0 }, width: 360, height: 240, metadata: {} };
        const target = audioNode({ id: "target" });
        const nodes = [trackNode, imgNode, videoNode, upscaleNode, target];

        expect(canvasConnectionError(config, nodes, [], { fromNodeId: trackNode.id, toNodeId: target.id })).toBe("");
        expect(canvasConnectionError(config, nodes, [], { fromNodeId: imgNode.id, toNodeId: target.id })).toBe("");
        expect(canvasConnectionError(config, nodes, [], { fromNodeId: videoNode.id, toNodeId: target.id })).toBe("音频生成节点不能连接参考视频");
        expect(canvasConnectionError(config, nodes, [], { fromNodeId: upscaleNode.id, toNodeId: target.id })).toBe("超分节点右侧只连接图片或视频结果节点");

        const speechOnlyChannel = createModelChannel({
            id: "beeftv",
            name: "BeefTV",
            baseUrl: "https://beeftv.app/v1",
            credentialRef: "beeftv",
            models: ["minimax-speech-2.8-hd"],
            modelProfiles: [
                {
                    model: "minimax-speech-2.8-hd",
                    capability: "audio",
                    protocol: "openai-audio",
                    mediaCapabilitiesVersion: "v1-minimax",
                    mediaCapabilities: { audio: { operations: ["synthesize"], options: ["voice"], referenceKinds: [], maxOutputs: 1 } },
                },
            ],
        });
        const speechOnlyConfig = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [speechOnlyChannel] } }).config;
        expect(canvasConnectionError(speechOnlyConfig, nodes, [], { fromNodeId: trackNode.id, toNodeId: target.id })).toBe("已配置音频模型均不支持参考音频");
        expect(canvasConnectionError(speechOnlyConfig, nodes, [], { fromNodeId: imgNode.id, toNodeId: target.id })).toBe("已配置音频模型均不支持参考图");
        expect(canvasConnectionError(speechOnlyConfig, nodes, [], { fromNodeId: trackNode.id, toNodeId: target.id }, { ignoreCapacity: true })).toBe("已配置音频模型均不支持参考音频");
        expect(canvasConnectionError(speechOnlyConfig, nodes, [], { fromNodeId: imgNode.id, toNodeId: target.id }, { ignoreCapacity: true })).toBe("已配置音频模型均不支持参考图");
    });
});
