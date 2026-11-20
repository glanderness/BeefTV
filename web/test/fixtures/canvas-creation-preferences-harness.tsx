import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { getAntThemeConfig } from "@/lib/app-theme";
import { buildGenerationConfig, canvasVideoOperationPreference, preferredMediaGeneratorMetadata } from "@/lib/canvas/canvas-generation-config";
import { buildCanvasResourceReferences } from "@/lib/canvas/canvas-resource-references";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { createModelChannel, defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const query = new URLSearchParams(location.search);
const mode = query.get("mode") === "video" ? "video" : "image";
const useVideoReferences = mode === "video" && query.has("references");
const channel = createModelChannel({ id: "fixture", name: "Fixture", baseUrl: "https://example.invalid", apiKey: "fixture", models: [`${mode}-a`, `${mode}-b`] });
channel.modelProfiles = channel.models.map((model) => {
    const capabilityConfig = defaultModelCapabilityConfig(mode === "image" ? "openai-image" : "openai-videos");
    capabilityConfig.image!.size = { parameter: "size", values: ["1:1", "16:9"], default: "1:1", allowCustom: false };
    capabilityConfig.video!.ratios = model.endsWith("-a") ? ["16:9", "9:16"] : ["9:16"];
    capabilityConfig.video!.defaultRatio = "9:16";
    capabilityConfig.video!.duration = { selection: "enum", values: [5, 10], default: 5 };
    if (useVideoReferences) {
        capabilityConfig.video!.operations = ["text_to_video", "image_to_video", "reference_to_video"];
        capabilityConfig.video!.references = { ...capabilityConfig.video!.references, maxImages: 3 };
    }
    return { model, displayName: model, capability: mode, protocol: mode === "image" ? "openai-image" : "openai-videos", capabilityConfig };
});
const second = createModelChannel({ ...channel, id: "second", name: "Second", models: ["video-c"], modelProfiles: [{ ...channel.modelProfiles[0]!, model: "video-c", displayName: "video-c" }] });
const builtinNames: Record<string, string> = {
    "seedance-2.0-fast": "Seedance 2.0 Fast",
    "seedance-2.0-mini": "Seedance 2.0 Mini",
    "seedance-2.0": "Seedance 2.0",
    "seedance-2.5": "Seedance 2.5",
    "wan3.0-video": "Wan 3.0",
    "minimax-h3": "MiniMax H3",
    "minimax-h3-max": "MiniMax H3 Max",
    "minimax-h3-max-turbo": "MiniMax H3 Max Turbo",
    "kling-video-v3": "TokenHub 可灵 V3",
};
const builtin = createModelChannel({
    id: "beeftv", name: "BeefTV", pinned: true, credentialRef: "beeftv", hasApiKey: true,
    models: Object.keys(builtinNames),
    modelProfiles: Object.entries(builtinNames).map(([model, displayName]) => ({ ...channel.modelProfiles[0]!, model, displayName })),
});
const config = { ...defaultConfig, channels: mode === "video" ? [channel, second, builtin] : [channel], imageModel: "fixture::image-a", videoModel: "fixture::video-a" };
useConfigStore.setState({ config, isAiConfigReady: true });
useCreationPreferencesStore.setState(({ preferences }) => ({ preferences: { ...preferences, [mode]: { model: `fixture::${mode}-a`, ratio: "16:9" } } }));
const initial: CanvasNodeData = { id: "source", type: mode === "image" ? CanvasNodeType.Image : CanvasNodeType.Video, title: "Fixture", width: 500, height: 300, position: { x: 0, y: 0 }, metadata: { model: `fixture::${mode}-a`, size: "16:9", seconds: "10", count: 2, generateAudio: "false", watermark: "false", prompt: "Fixture prompt" } };

const imageNode: CanvasNodeData = {
    id: "reference", type: CanvasNodeType.Image, title: "参考图", width: 100, height: 100, position: { x: 0, y: 0 },
    metadata: { content: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" },
};
const referenceInput = { textCount: 0, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 };

function Harness() {
    const [node, setNode] = useState(initial);
    const [next, setNext] = useState<CanvasNodeData>();
    const preferences = useCreationPreferencesStore(state => state.preferences);
    const referenceConnections: CanvasConnection[] = useVideoReferences
        ? [{ id: "reference-link", fromNodeId: imageNode.id, toNodeId: node.id }] : [];
    const referenceNodes = useVideoReferences ? [imageNode, node] : [node];
    const onGenerate = () => {
        const store = useCreationPreferencesStore.getState();
        const generation = buildGenerationConfig(config, node, mode);
        store.confirmVideoSettings(generation);
        if (useVideoReferences) {
            const operation = canvasVideoOperationPreference(generation, node, referenceInput, store.preferences.videoReferenceMode ?? "all");
            store.rememberVideoReferenceMode(operation === "reference_to_video" ? "all" : "frames");
        }
    };
    return <main style={{ padding: 24, maxWidth: 680 }}>
        <section data-testid="node-panel">
            <CanvasNodePromptPanel projectId="fixture" node={node} isRunning={false} onPromptChange={() => {}} onConfigChange={(_id, patch) => setNode(current => ({ ...current, metadata: { ...current.metadata, ...patch } }))} mentionReferences={buildCanvasResourceReferences(referenceNodes, referenceConnections, node.id)} referenceNodes={referenceNodes} referenceConnections={referenceConnections} onGenerate={onGenerate} />
        </section>
        {useVideoReferences && <button onClick={() => setNode((current) => ({ ...initial, id: current.id + "-next" }))}>Open fresh video node</button>}
        <button onClick={() => setNext({ ...initial, id: "next", metadata: preferredMediaGeneratorMetadata(config, mode) })}>New node</button>
        <output data-testid="current-config">{JSON.stringify(buildGenerationConfig(config, node, mode))}</output>
        <output data-testid="next-config">{next ? JSON.stringify(buildGenerationConfig(config, next, mode)) : ""}</output>
        <output data-testid="preferences">{JSON.stringify(preferences[mode])}</output>
    </main>;
}

createRoot(document.getElementById("root")!).render(<ConfigProvider theme={getAntThemeConfig(false)}><App><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Harness /></QueryClientProvider></App></ConfigProvider>);
