import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import "@/styles/globals.css";
import { getAntThemeConfig } from "@/lib/app-theme";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { createModelChannel, defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { CreationComposer } from "@/pages/create/creation-workspace";
import { creationAttachmentKind, type CreationAttachment } from "@/pages/create/creation-assets";
import { buildCreationMentionReferences, creationReferenceKindMessage, creationReferenceLimitsFor, type CreationReferenceLimits } from "@/pages/create/creation-references";

// 只用于截图：用仓库真实的 CreationComposer 与真实的模型能力配置渲染参考内容面板，
// 不连接后端、不提交任何任务。三类素材数量可通过 ?images=9&videos=3&audios=3 调整。
const params = new URLSearchParams(location.search);
const count = (name: string, fallback: number) => {
    const value = Number(params.get(name));
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
};

const channel = createModelChannel({ id: "fixture", name: "Fixture", baseUrl: "https://example.invalid", apiKey: "fixture", models: ["seedance-2.0"] });
channel.modelProfiles = [{
    model: "seedance-2.0",
    displayName: "Seedance 2.0",
    capability: "video",
    protocol: "openai-videos",
    capabilityConfig: defaultModelCapabilityConfig("openai-videos", "seedance-2.0"),
}];
const config = { ...defaultConfig, channels: [channel], videoModel: "fixture::seedance-2.0" };
useConfigStore.setState({ config, isAiConfigReady: true });

const model = "fixture::seedance-2.0";
const capability = modelCapabilityConfigFor(config, model);
const videoProfile = capability.video!;
const imageProfile = capability.image!;
const referenceLimits: CreationReferenceLimits = creationReferenceLimitsFor("video", capability);

function imageAttachment(index: number): CreationAttachment {
    const hue = (index * 47) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="hsl(${hue} 62% 58%)"/><text x="120" y="132" font-size="64" font-family="sans-serif" fill="white" text-anchor="middle">${index + 1}</text></svg>`;
    const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    return { id: `image-${index}`, name: `参考图${index + 1}.png`, type: "image/png", dataUrl, previewUrl: dataUrl, width: 240, height: 240, bytes: 1024 };
}

function videoAttachment(index: number): CreationAttachment {
    return { id: `video-${index}`, name: `参考视频${index + 1}.mp4`, type: "video/mp4", url: "about:blank", storageKey: `fixture:video-${index}`, previewUrl: "", bytes: 1024, durationSeconds: 4 };
}

function audioAttachment(index: number): CreationAttachment {
    return { id: `audio-${index}`, name: `参考音频${index + 1}.mp3`, type: "audio/mpeg", url: "about:blank", storageKey: `fixture:audio-${index}`, previewUrl: "", bytes: 1024, durationSeconds: 3 };
}

const initialAttachments: CreationAttachment[] = [
    ...Array.from({ length: count("images", 9) }, (_, index) => imageAttachment(index)),
    ...Array.from({ length: count("videos", 3) }, (_, index) => videoAttachment(index)),
    ...Array.from({ length: count("audios", 3) }, (_, index) => audioAttachment(index)),
];

function Harness() {
    const { message } = App.useApp();
    const [attachments, setAttachments] = useState<CreationAttachment[]>(initialAttachments);
    const [prompt, setPrompt] = useState("让参考图里的人物走进雨夜的霓虹街道，镜头缓慢推进");
    const composerFocusRef = useRef<HTMLTextAreaElement>(null);
    const references = buildCreationMentionReferences([], attachments);

    // 与创作页 handleLibrarySelect 相同的提示：再选 3 张图会超过「参考图最多 9 张」。
    const simulateLibraryOverflow = () => {
        const extra = [10, 11, 12].map((index) => imageAttachment(index - 1));
        const fitted = [...attachments, ...extra].reduce<{ kept: CreationAttachment[]; dropped: CreationAttachment[] }>(
            (state, attachment) => {
                const kind = creationAttachmentKind(attachment);
                const limit = referenceLimits[kind];
                const used = state.kept.filter((item) => creationAttachmentKind(item) === kind).length;
                if (limit !== undefined && used >= limit) state.dropped.push(attachment);
                else state.kept.push(attachment);
                return state;
            },
            { kept: [], dropped: [] },
        );
        setAttachments(fitted.kept);
        if (fitted.dropped.length) message.warning(`${creationReferenceKindMessage(referenceLimits, fitted.dropped[0])}，超出的 ${fitted.dropped.length} 个素材没有加入`);
    };

    return <div className="creation-page" style={{ padding: 28, display: "grid", gap: 18, maxWidth: 1120 }}>
        <CreationComposer
            variant="thread"
            mode="video"
            prompt={prompt}
            setPrompt={setPrompt}
            busy={false}
            generationActive={false}
            referenceReplacementBusy={false}
            attachments={attachments}
            referenceLimits={referenceLimits}
            references={references}
            onRemoveAttachment={(id) => setAttachments((current) => current.filter((item) => item.id !== id))}
            onClearAttachments={() => setAttachments([])}
            onClearComposer={() => setPrompt("")}
            onReorderAttachments={setAttachments}
            onReplaceAttachment={() => {}}
            onReplaceReferenceFiles={() => {}}
            onOpenLibrary={simulateLibraryOverflow}
            onModeChange={() => {}}
            model={model}
            modelRequirements={{ capability: "video" }}
            videoProfile={videoProfile}
            imageProfile={imageProfile}
            config={config}
            onModelChange={() => {}}
            ratio={videoProfile.defaultRatio}
            setRatio={() => {}}
            seconds={String(videoProfile.duration.default)}
            setSeconds={() => {}}
            quality="auto"
            setQuality={() => {}}
            videoQuality={videoProfile.defaultResolution}
            setVideoQuality={() => {}}
            count="1"
            setCount={() => {}}
            textStreaming
            setTextStreaming={() => {}}
            textThinking={false}
            setTextThinking={() => {}}
            promptOptimizerProvider={null}
            composerFocusRef={composerFocusRef}
            onPromptFocus={() => {}}
            onSubmit={() => {}}
        />
        <p style={{ color: "#8a8a8a", fontSize: 13 }} data-testid="limits">{JSON.stringify(referenceLimits)}</p>
    </div>;
}

createRoot(document.getElementById("root")!).render(
    <ConfigProvider theme={getAntThemeConfig(false)}>
        <App>
            <Harness />
        </App>
    </ConfigProvider>,
);