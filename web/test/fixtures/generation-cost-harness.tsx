import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { getAntThemeConfig } from "@/lib/app-theme";
import { applySkinTheme, DEFAULT_CLASSIC_SKIN } from "@/lib/skin-themes";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { ModelPicker } from "@/components/model-picker";
import { CanvasAssistantTurnView } from "@/pages/canvas/canvas-assistant-turn";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, useConfigStore } from "@/stores/use-config-store";
import type { AssistantTurn } from "@/services/api/agent-assistant";
import "@/pages/canvas/canvas-assistant-sidebar.css";

/**
 * 费用展示的浏览器夹具：模型选择器的价格弹层和助手提议卡的费用行。
 * 价格全部来自模型档案里的企业目录单价与后端 estimate，夹具只负责把它们摆到界面上。
 */
const config = normalizeConfigSnapshot({
    config: {
        ...defaultConfig,
        channels: [createModelChannel({
            id: "beefapi", name: "BeefAPI", baseUrl: "https://beefapi.com", apiKey: "",
            models: ["gpt-image-2", "minimax-h3-max-turbo", "speech-2.8-hd"],
            modelProfiles: [
                { model: "gpt-image-2", capability: "image", protocol: "openai-image", capabilityConfig: defaultModelCapabilityConfig("openai-image", "gpt-image-2"), pricing: { currency: "CNY", kind: "image", mode: "per_request", image_price_table: { output: { high: { "1K": 0.35, "2K": 0.6 } }, reference: 0.15, default_quality: "high", default_size: "1K", auto_quality: "high" } } },
                { model: "minimax-h3-max-turbo", capability: "video", protocol: "newapi", capabilityConfig: defaultModelCapabilityConfig("newapi", "minimax-h3-max-turbo"), pricing: { currency: "CNY", kind: "video", per_second_cny: { "1080p": 0.43 }, reference_image_cny: 0.215, free_reference_images: 5 } },
                { model: "speech-2.8-hd", capability: "audio", protocol: "openai-audio", capabilityConfig: defaultModelCapabilityConfig("openai-audio", "speech-2.8-hd"), pricing: { currency: "CNY", kind: "audio", input_cny: 350 } },
            ],
        })],
        imageModel: "beefapi::gpt-image-2",
        videoModel: "beefapi::minimax-h3-max-turbo",
        audioModel: "beefapi::speech-2.8-hd",
    },
}).config;
useConfigStore.getState().replaceConfig(config);

const turn: AssistantTurn = {
    turnId: "cost-turn",
    userText: "把这个剧本做成一条 30 秒短片",
    selectedNodeIds: [],
    reply: "按三个镜头做，确认后开始生成。",
    toolCalls: [],
    change: null,
    error: null,
    cancelled: false,
    createdAt: "2026-10-27T10:00:00Z",
    proposals: [{
        proposalId: "gp-cost",
        kind: "image",
        nodeIds: ["img-1", "vid-1", "vid-2", "tts-1"],
        model: "gpt-image-2",
        modelKey: "beefapi::gpt-image-2",
        production: {
            targets: [
                { nodeId: "img-1", title: "分镜1-首帧图", kind: "image", modelKey: "beefapi::gpt-image-2", prompt: "雨夜巷口，远景", parameters: { size: "1K", count: "1" }, referenceNodeIds: [] },
                { nodeId: "vid-1", title: "分镜1-6s视频", kind: "video", modelKey: "beefapi::minimax-h3-max-turbo", prompt: "镜头1视频", parameters: { vquality: "1080p", seconds: "6", count: "1" }, referenceNodeIds: ["img-1"] },
                { nodeId: "vid-2", title: "分镜2-5s视频", kind: "video", modelKey: "beefapi::minimax-h3-max-turbo", prompt: "镜头2视频", parameters: { vquality: "1080p", seconds: "5", count: "1" }, referenceNodeIds: ["img-1"] },
                { nodeId: "tts-1", title: "旁白1", kind: "audio", modelKey: "beefapi::speech-2.8-hd", prompt: "把春天带回家。", parameters: { audioVoice: "female-tianmei", count: "1" }, referenceNodeIds: [] },
            ],
        },
        estimate: {
            currency: "CNY", total: 5.08, known: false, unknownCount: 1,
            items: [
                { nodeId: "img-1", title: "分镜1-首帧图", kind: "image", model: "gpt-image-2", amount: 0.35, basis: "1K 高质量 ¥0.35 × 1 张" },
                { nodeId: "vid-1", title: "分镜1-6s视频", kind: "video", model: "minimax-h3-max-turbo", amount: 2.58, basis: "1080p ¥0.43/秒 × 6秒" },
                { nodeId: "vid-2", title: "分镜2-5s视频", kind: "video", model: "minimax-h3-max-turbo", amount: 2.15, basis: "1080p ¥0.43/秒 × 5秒" },
                { nodeId: "tts-1", title: "旁白1", kind: "audio", model: "speech-2.8-hd", amount: null, basis: "缺少台词文本" },
            ],
            text: "预计费用 ¥5.08（已知部分），另有 1 项暂无价格",
        },
        source: { canvasId: "c1", canvasRevision: 1, modelConfigRevision: 1 },
    }],
};

const dark = new URLSearchParams(location.search).get("theme") === "dark";
applySkinTheme(DEFAULT_CLASSIC_SKIN, dark ? "dark" : "light");

createRoot(document.getElementById("root")!).render(
    <ConfigProvider theme={getAntThemeConfig(dark, DEFAULT_CLASSIC_SKIN)}><App>
        <main style={{ padding: 20, maxWidth: 520, background: dark ? "#141414" : "#fff", minHeight: "100vh" }}>
            <section data-testid="model-picker">
                <ModelPicker config={config} value="beefapi::gpt-image-2" capability="image" onChange={() => {}} />
            </section>
            <section data-testid="proposal-card">
                <CanvasAssistantTurnView turn={turn} handledProposals={new Set()} nodes={[]}
                    onLocate={() => {}} onUndo={() => {}} onRunProposal={() => {}} onDismissProposal={() => {}} />
            </section>
        </main>
    </App></ConfigProvider>,
);
