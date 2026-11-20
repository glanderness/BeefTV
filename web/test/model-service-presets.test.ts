import { expect, test } from "bun:test";
import * as ReactNamespace from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyFetchedChannelModelCatalog } from "../src/lib/channel-model-catalog";
import { normalizeChannelBaseUrl } from "../src/lib/channel-url";
import { ModelLogo } from "../src/components/model-logo";
import { BUILTIN_PRESETS, applyPartnerCatalogMetadata, clearDynamicPartnerModulesForTest, getBuiltinPresetsVersion, getPartnerIndicatorVersion, livePartnerSyncIssues, markPartnersNoticed, nextActivePartnerWindowDelayMs, resetDynamicPartnersInMemoryForReloadTest, syncBuiltinPresetFromModule, unnoticedLivePartners } from "../src/lib/builtin-service-presets";
import { clearTransientPartnerRetryForTest, nextTransientPartnerRetryDelayMs, recordTransientPartnerRetryForTest, syncPartnerCatalogFromBackend } from "../src/services/plugin-sync";
import { MODEL_SERVICE_PRESETS, builtinPresetIntro, createPluginServiceChannel, createServicePresetChannel, ll2ProtocolsAvailable, ysduiProtocolsAvailable, partnerServicePresets, pluginServices, mergeSavedServiceChannel, presetCatalogFor, presetKeysUrl, presetPluginId, presetPromoText, serviceConnectionError, serviceModelProfile, servicePresetFor, standardServicePresets } from "../src/lib/model-service-presets";
import { modelConnectionResultDetail, testChannelModelConnection } from "../src/lib/model-connection-test";
import { channelValidationError, modelConfigChannelStatusLabel } from "../src/pages/settings/channel-settings-pane";
import { refreshNewBuiltinDraftProfiles, removeManualModelEntry, updateManualModelEntry } from "../src/pages/settings/model-service-editor";
import "../src/lib/plugins/plugin-client-loader";
import { backendProviderConfig } from "../src/services/api/generation-task";
import { configWithoutCachedSecrets, createModelChannel, defaultConfig, normalizeConfigSnapshot, useConfigStore } from "../src/stores/use-config-store";
import { defaultModelCapabilityConfig, sanitizeServerImageCapability, sanitizeServerVideoCapability } from "../src/lib/model-capabilities";
import { defaultProtocolForCapability, modelProtocolDefinition, type ModelProtocolDefinition } from "../src/lib/model-protocols";
import { serviceCredentialGuide } from "../src/lib/service-credentials";
import { toProviderDefinitions } from "../src/services/api/plugin-catalog";
import { currentModelConnectionReceipt, useModelConnectionTests } from "../src/stores/use-model-connection-tests";

const protocols = [
    ["chat-completion", "text"], ["gemini-generate-content", "text"], ["gemini-image", "image"],
    ["volcengine-ark-video", "video"], ["newapi", "video"],
].map(([value, capability]) => ({ value, capability, enabled: true } as ModelProtocolDefinition));

test("BytePlus import selects Ark without changing third-party or saved protocols", () => {
    const item = { id: "dreamina-seedance-2-0-fast-260128" };
    const channel = createModelChannel({ baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3" });
    expect(serviceModelProfile(channel, item, protocols)).toMatchObject({ protocol: "volcengine-ark-video", capabilityConfig: { video: { resolutions: ["480p", "720p"] } } });
    for (const baseUrl of ["https://ark.ap-southeast.bytepluses.com.example.com/api/v3", "https://other.example.com/v1"]) {
        expect(serviceModelProfile({ ...channel, baseUrl }, item, protocols).protocol).toBeUndefined();
    }
    const saved = { model: item.id, capability: "video" as const, protocol: "newapi" as const };
    expect(serviceModelProfile({ ...channel, modelProfiles: [saved] }, item, protocols)).toEqual(saved);
});

test("persisted boolean video options are normalized without turning false back on", () => {
    const channel = createModelChannel({ id: "custom", models: ["seedance-2.0-mini"], modelProfiles: [{ model: "seedance-2.0-mini", capability: "video", protocol: "newapi" }] });
    for (const enabled of [true, false]) {
        const persisted = JSON.parse(JSON.stringify({ ...defaultConfig, channels: [channel], model: "custom::seedance-2.0-mini", videoGenerateAudio: enabled, videoWatermark: false, videoArkPrivateAssetUpload: true }));
        expect(backendProviderConfig(persisted)).toMatchObject({ videoGenerateAudio: String(enabled), videoWatermark: "false", videoArkPrivateAssetUpload: "true" });
    }
});

test("catalog endpoint metadata classifies opaque video names and selects only installed provider contracts", () => {
    const channel = createModelChannel({ baseUrl: "https://video.example.com/v1" });
    const item = { id: "原生不卡人脸-全参2.5", supportedEndpointTypes: ["full-video"] };
    expect(serviceModelProfile(channel, item, protocols).protocol).toBeUndefined();
    const installed = [...protocols, { value: "full-video", capability: "video", enabled: true } as ModelProtocolDefinition];
    const profile = serviceModelProfile(channel, item, installed);
    expect(profile.capability).toBe("video");
    expect(profile.protocol).toBe("full-video");
    for (const id of ["sd-native-full-2.0", "sd-native-full-2.5", "原生不卡人脸-全参2.0", "原生不卡人脸-全参2.5"]) {
        expect(serviceModelProfile(channel, { id }, installed)).toMatchObject({ capability: "video", protocol: undefined });
    }
    expect(serviceModelProfile({ ...channel, baseUrl: "https://other.example" }, { id: "sd-native-full-2.5" }, installed).protocol).not.toBe("full-video");
    expect(profile.capabilityConfig?.video).toMatchObject({ duration: { min: 4, max: 30 }, resolutions: ["480p", "720p"], references: { maxVideos: 10 } });
    expect(serviceModelProfile(channel, { id: "H3-KS", supportedEndpointTypes: ["openai-video"] }, installed).protocol).toBe("newapi");
    expect(serviceModelProfile({ ...channel, baseUrl: "https://other.example" }, item, installed).protocol).toBe("full-video");
    expect(serviceModelProfile(channel, item, installed.map(p => ({ ...p, enabled: false }))).protocol).toBeUndefined();
});

test("test receipts apply only to the exact tested connection and model profile", () => {
    const channel = createModelChannel({ id: "receipt-channel", apiKey: "synthetic-key", modelProfiles: [{ model: "test", capability: "text", protocol: "chat-completion" }] });
    useModelConnectionTests.getState().record(channel, "test", { success: true, detail: "OK" });
    const receipts = useModelConnectionTests.getState().receipts;
    expect(currentModelConnectionReceipt(receipts, channel, "test")?.success).toBe(true);
    expect(currentModelConnectionReceipt(receipts, { ...channel, apiKey: "changed" }, "test")).toBeUndefined();
    expect(currentModelConnectionReceipt(receipts, { ...channel, baseUrl: "https://other.example" }, "test")).toBeUndefined();
    expect(currentModelConnectionReceipt(receipts, { ...channel, referenceAssetOrigin: "https://assets.example.com" }, "test")).toBeUndefined();
    expect(currentModelConnectionReceipt(receipts, { ...channel, headers: [{ name: "X-Key", value: "other" }] }, "test")).toBeUndefined();
    expect(currentModelConnectionReceipt(receipts, { ...channel, modelProfiles: [{ model: "test", capability: "text", protocol: "openai-response" }] }, "test")).toBeUndefined();
});

test("native provider models use installed native adapters and never invent a missing adapter", () => {
    const gemini = createModelChannel({ baseUrl: "https://generativelanguage.googleapis.com", apiFormat: "gemini" });
    expect(serviceModelProfile(gemini, { id: "gemini-pro" }, protocols).protocol).toBe("gemini-generate-content");
    expect(serviceModelProfile(gemini, { id: "gemini-image" }, protocols).protocol).toBe("gemini-image");
    expect(serviceModelProfile(gemini, { id: "veo-video" }, protocols).protocol).toBeUndefined();
    const ark = createModelChannel({ baseUrl: "https://ark.cn-beijing.volces.com/api/v3" });
    expect(serviceModelProfile(ark, { id: "endpoint-abc" }, protocols, "video").protocol).toBe("volcengine-ark-video");
    const regionalArk = { ...ark, baseUrl: "https://ark.cn-shanghai.volces.com/api/v3" };
    expect(serviceModelProfile(regionalArk, { id: "endpoint-abc" }, protocols, "video").protocol).toBe("volcengine-ark-video");
    const unrelated = { ...ark, baseUrl: "https://ark.cn-shanghai.volces.com.example.org/api/v3" };
    expect(serviceModelProfile(unrelated, { id: "endpoint-abc" }, protocols, "video").protocol).toBeUndefined();
});

test("external video protocols require an explicit contract and keep user selections", () => {
    const channel = createModelChannel({ baseUrl: "https://www.whatstoken.ai/v1" });
    const installed = [...protocols, { value: "video-generations-json", capability: "video", enabled: true } as ModelProtocolDefinition];
    for (const id of ["seedance-2.5", "sora-2", "veo-video", "opaque"]) {
        expect(serviceModelProfile(channel, { id }, installed, "video").protocol).toBeUndefined();
    }
    expect(serviceModelProfile(channel, { id: "seedance-2.5", supportedEndpointTypes: ["openai"] }, installed).protocol).toBeUndefined();
    expect(serviceModelProfile(channel, { id: "seedance-2.5", supportedEndpointTypes: [" video-generations-json "] }, installed).protocol).toBe("video-generations-json");
    expect(serviceModelProfile(channel, { id: "seedance-2.5", supportedEndpointTypes: ["video-generations-json"] }, protocols).protocol).toBeUndefined();
    const configured = { ...channel, modelProfiles: [{ model: "seedance-2.5", capability: "video" as const, protocol: "volcengine-ark-video" }] };
    expect(serviceModelProfile(configured, { id: "seedance-2.5" }, installed).protocol).toBe("volcengine-ark-video");
    expect(serviceModelProfile({ ...channel, baseUrl: "https://api.openai.com/v1" }, { id: "sora-2" }, installed).protocol).toBe("newapi");
});

test("saving a model inherits an enabled channel protocol of the same capability without mutating its draft", () => {
    const channel = createModelChannel({ baseUrl: "https://video.example.com/v1", interfaceType: "video-generations-json", modelProfiles: [{ model: "seedance-2.5", capability: "video" }] });
    const installed = [...protocols, { value: "video-generations-json", capability: "video", enabled: true } as ModelProtocolDefinition];
    expect(serviceModelProfile(channel, { id: "seedance-2.5" }, installed).protocol).toBe("video-generations-json");
    expect(channel.modelProfiles?.[0]?.protocol).toBeUndefined();
    expect(serviceModelProfile(channel, { id: "seedance-2.5" }, protocols).protocol).toBeUndefined();
    expect(serviceModelProfile(channel, { id: "seedance-2.5" }, installed.map((p) => ({ ...p, enabled: false }))).protocol).toBeUndefined();
    expect(serviceModelProfile({ ...channel, interfaceType: "chat-completion" }, { id: "seedance-2.5" }, installed).protocol).toBeUndefined();
    expect(serviceModelProfile(channel, { id: "sd-native-full-2.5" }, installed).protocol).toBe("video-generations-json");
});

test("refresh keeps selected/manual models and user capability limits", () => {
    const config = defaultModelCapabilityConfig("newapi", "video-manual")!;
    const channel = createModelChannel({ id: "custom", models: ["video-manual"], modelProfiles: [{ model: "video-manual", capability: "video", protocol: "newapi", capabilityConfig: config }] });
    const next = applyFetchedChannelModelCatalog(channel, { models: ["video-manual", "new-model"], catalog: [{ id: "video-manual", modelType: "text" }, { id: "new-model" }] });
    expect(next.models).toEqual(["video-manual"]);
    expect(next.modelProfiles?.find((p) => p.model === "video-manual")).toEqual(channel.modelProfiles![0]);
});

test("a plugin service becomes one provider choice whose listed models use the plugin interface", () => {
    const comfy = { value: "comfyui-app", label: "ComfyUI", capability: "image", enabled: true, module: true, authType: "none", baseUrl: "http://127.0.0.1:8188" } as ModelProtocolDefinition;
    const services = pluginServices([...protocols, comfy, { ...comfy }, { ...comfy, value: "off", enabled: false }]);
    expect(services.map((item) => item.value)).toEqual(["comfyui-app"]);

    const channel = createPluginServiceChannel(comfy, "comfy");
    expect(channel).toMatchObject({ id: "comfy", name: "ComfyUI", baseUrl: "http://127.0.0.1:8188", interfaceType: "comfyui-app" });
    // 本机 ComfyUI 不要密钥：还没选模型时也能直接读取模型。
    expect(serviceConnectionError(channel, { protocols: [comfy] })).toBe("");
    expect(serviceCredentialGuide(channel, [comfy]).apiKeyHelp).toBe("这个服务不用密钥，可以留空。");
    expect(serviceConnectionError(createPluginServiceChannel({ ...comfy, authType: "bearer" }, "keyed"), { protocols: [{ ...comfy, authType: "bearer" }] })).toBe("请填写 API Key");

    expect(serviceModelProfile(channel, { id: "portrait.app.json", modelType: "image" }, [...protocols, comfy])).toMatchObject({ capability: "image", protocol: "comfyui-app" });
});

test("a plugin interface that makes images and videos is one service, and both kinds of model use it", () => {
    const item = { id: "comfyui", version: "0.1.0", name: "ComfyUI", vendor: "ComfyUI", categories: ["image", "video"], scopes: ["user.custom-channel"], enabled: true, module: true, authType: "none", baseUrl: "http://127.0.0.1:8188" };
    expect(toProviderDefinitions(item).map((definition) => `${definition.value}:${definition.capability}`)).toEqual(["comfyui:image", "comfyui:video"]);
    expect(toProviderDefinitions(item, "video").map((definition) => definition.capability)).toEqual(["video"]);
    expect(toProviderDefinitions(item, "audio")).toEqual([]);

    const available = [...protocols, ...toProviderDefinitions(item)];
    const services = pluginServices(available);
    expect(services.map((service) => service.value)).toEqual(["comfyui"]);
    const channel = createPluginServiceChannel(services[0], "comfy");
    expect(serviceModelProfile(channel, { id: "invert.app.json", modelType: "image" }, available)).toMatchObject({ capability: "image", protocol: "comfyui" });
    expect(serviceModelProfile(channel, { id: "clip.json", modelType: "video" }, available)).toMatchObject({ capability: "video", protocol: "comfyui" });
});

test("connection validation rejects full endpoints and embedded credentials", () => {
    const channel = createModelChannel({ baseUrl: "https://api.example.com/v1", apiKey: "synthetic-key" });
    expect(serviceConnectionError(channel)).toBe("");
    expect(serviceConnectionError({ ...channel, baseUrl: "https://api.example.com/v1/chat/completions" })).not.toBe("");
    expect(serviceConnectionError({ ...channel, baseUrl: "https://secret@api.example.com" })).not.toBe("");
    expect(serviceConnectionError({ ...channel, referenceAssetOrigin: "https://assets.example.com" })).toBe("");
    expect(serviceConnectionError({ ...channel, referenceAssetOrigin: "http://10.0.0.8:9000" })).toBe("");
    expect(serviceConnectionError({ ...channel, referenceAssetOrigin: "https://assets.example.com:444" })).toBe("");
    for (const referenceAssetOrigin of ["https://assets.example.com/path", "https://user@assets.example.com", "https://assets.example.com?key=value", "http://assets.example.com#sig"]) {
        expect(serviceConnectionError({ ...channel, referenceAssetOrigin })).not.toBe("");
    }
});

test("API key is optional only when every selected protocol auth is none", () => {
    const channel = createModelChannel({ baseUrl: "http://127.0.0.1:11434", apiKey: "", models: ["llama3"], modelProfiles: [{ model: "llama3", capability: "text", protocol: "ollama-chat", authType: "none" }] });
    const ollama = { value: "ollama-chat", capability: "text", enabled: true, authType: "none" } as ModelProtocolDefinition;
    const bearer = { value: "ollama-chat", capability: "text", enabled: true, authType: "bearer" } as ModelProtocolDefinition;
    expect(serviceConnectionError(channel)).toBe("");
    expect(serviceConnectionError(channel, { protocols: [ollama] })).toBe("");
    expect(serviceConnectionError(channel, { protocols: [bearer] })).not.toBe("");
    expect(serviceConnectionError({ ...channel, apiKey: "" }, { requireCredential: false })).toBe("");
    expect(serviceConnectionError(createModelChannel({ baseUrl: "https://api.example.com/v1", apiKey: "" }))).toBe("请填写 API Key");
    expect(serviceConnectionError(createModelChannel({ baseUrl: "https://api.example.com/v1", apiKey: "" }), { requireCredential: false })).toBe("");
    const mixed = createModelChannel({ baseUrl: "http://127.0.0.1:11434", apiKey: "", models: ["llama3", "gpt"], modelProfiles: [{ model: "llama3", capability: "text", protocol: "ollama-chat", authType: "none" }, { model: "gpt", capability: "text", protocol: "chat-completion" }] });
    expect(serviceConnectionError(mixed, { protocols: [ollama, ...protocols] })).toBe("请填写 API Key");
    expect(modelConfigChannelStatusLabel(channel, { status: "saved", revision: 1, dirty: false, error: "" })).toBe("已保存 · 尚未测试");
});

test("explicit asset origin survives channel creation and generation request assembly", () => {
    const channel = createModelChannel({ id: "custom", baseUrl: "https://api.example.com/v1", referenceAssetOrigin: " https://assets.example.com ", models: ["sd-native-full-2.5"], modelProfiles: [{ model: "sd-native-full-2.5", capability: "video", protocol: "full-video" }] });
    const config = { ...defaultConfig, channels: [channel], model: "custom::sd-native-full-2.5" };
    expect(channel.referenceAssetOrigin).toBe("https://assets.example.com");
    expect(backendProviderConfig(config)).toMatchObject({ referenceAssetOrigin: channel.referenceAssetOrigin, interfaceType: "full-video" });
});

test("saved credentials do not imply tested generation and browser cache omits all credential copies", () => {
    const channel = createModelChannel({ id: "manual", apiKey: "synthetic-key", secretKey: "synthetic-secret", headers: [{ name: "X-Key", value: "synthetic-header" }] });
    expect(modelConfigChannelStatusLabel(channel, { status: "saved", revision: 1, dirty: false, error: "" })).toBe("已保存 · 尚未测试");
    const config = { ...defaultConfig, apiKey: "synthetic-root", channels: [channel] };
    expect(JSON.stringify(configWithoutCachedSecrets(config))).not.toContain("synthetic-");
    expect(config.channels[0].apiKey).toBe("synthetic-key");
});

test("generation test uses production config including headers and waits for a final output", async () => {
    const capabilityConfig = defaultModelCapabilityConfig("newapi", "test-video")!;
    capabilityConfig.video!.duration = { selection: "enum", values: [8, 4, 12], default: 8 };
    capabilityConfig.video!.resolutions = ["1080", "720"];
    const channel = createModelChannel({ id: "manual", apiKey: "synthetic-key", models: ["test-video"], headers: [{ name: "X-Project", value: "test-project" }], modelProfiles: [{ model: "test-video", capability: "video", protocol: "newapi", capabilityConfig }] });
    let resolve!: (value: { video: { dataUrl: string; storageKey: string } }) => void;
    const completion = new Promise<{ video: { dataUrl: string; storageKey: string } }>((r) => { resolve = r; });
    let done = false;
    const testResult = testChannelModelConnection(channel, "test-video", "video", "newapi", async (options) => {
        expect(options.config.videoSeconds).toBe("4");
        expect(options.config.vquality).toBe("720");
        const request = backendProviderConfig(options.config);
        expect(request).toMatchObject({ headers: channel.headers, model: "test-video", apiKey: "synthetic-key", interfaceType: "newapi" });
        return completion;
    }).then((value) => { done = true; return value; });
    await Promise.resolve();
    expect(done).toBe(false);
    resolve({ video: { storageKey: "resource:generated", dataUrl: "" } });
    expect(await testResult).toContain("已完成视频生成");
    expect(() => modelConnectionResultDetail({}, "video")).toThrow("没有返回可用结果");
    expect(() => modelConnectionResultDetail({ text: " " }, "text")).toThrow();
});

test("video test uses configured range defaults and ranks K resolutions above ordinary P tiers", async () => {
    const capabilityConfig = defaultModelCapabilityConfig("newapi", "test-video")!;
    capabilityConfig.video!.resolutions = ["2K", "768P"];
    const channel = createModelChannel({ apiKey: "synthetic", modelProfiles: [{ model: "test-video", capability: "video", protocol: "newapi", capabilityConfig }] });
    await testChannelModelConnection(channel, "test-video", "video", "newapi", async ({ config }) => {
        expect(config.videoSeconds).toBe(String(capabilityConfig.video!.duration.default));
        expect(config.videoSeconds).not.toBe("1");
        expect(config.vquality).toBe("768P");
        return { video: { storageKey: "fixture", dataUrl: "" } };
    });
});

test("official OpenAI and Gemini presets stop advertising discontinued video APIs", () => {
    const presets = new Map(MODEL_SERVICE_PRESETS.map((preset) => [preset.id, preset.subtitle]));
    for (const id of ["openai", "gemini"]) {
        const subtitle = presets.get(id as "openai" | "gemini") || "";
        expect(subtitle).toContain("已停用");
        expect(subtitle).not.toMatch(/·\s*(Veo\s*)?视频\s*$/);
    }
    expect(presets.get("compatible")).toContain("中转");
    expect(presets.get("ll2")).toContain("视频");
    expect(presets.get("ysdui")).toContain("视频");
    expect(presets.get("ark")).toContain("Seedance 视频");
});

test("Ysdui service preset resolves all 4 Ysdui protocols when plugin is enabled and fails closed when disabled", () => {
    const ysduiProtocols = [
        ...protocols,
        { value: "ysdui-image", capability: "image", authType: "bearer", enabled: true } as ModelProtocolDefinition,
        { value: "ysdui-image-task", capability: "image", authType: "bearer", enabled: true } as ModelProtocolDefinition,
        { value: "ysdui-video", capability: "video", authType: "bearer", enabled: true } as ModelProtocolDefinition,
    ];
    expect(ysduiProtocolsAvailable(ysduiProtocols)).toBe(true);
    expect(ysduiProtocolsAvailable(protocols)).toBe(false);

    const channel = createServicePresetChannel("ysdui", "ysdui-test", ysduiProtocols);
    const catalog = presetCatalogFor("ysdui");
    const ysduiPreset = MODEL_SERVICE_PRESETS.find((item) => item.id === "ysdui");
    expect(ysduiPreset?.icon).toBe("Ysdui");
    expect(builtinPresetIntro("ysdui")).toBe("银盛通信有限公司成立于2002年，注册资本5亿元，国家高新技术企业。银盛·云枢壹算是银盛通信有限公司旗下企业级一站式AI服务平台，为企业提供算力支持以及AI产品解决方案。");
    expect(builtinPresetIntro("ll2")).toBe("");
    const renderedLogo = renderToStaticMarkup(createElement(ModelLogo, { icon: ysduiPreset?.icon, size: 24 }));
    expect(renderedLogo).toContain('viewBox="0 0 1024 1024"');
    expect(renderedLogo).toContain('fill="#005CD2"');
    expect(renderedLogo).not.toContain("<mask");
    expect(renderedLogo).not.toContain("<clipPath");
    expect(servicePresetFor(channel)).toBe("ysdui");
    expect(channel.name).toBe("银盛云枢壹算");
    expect(channel.baseUrl).toBe("https://tokenhub.ysdui.cn");
    expect(channel.models).toHaveLength(32);
    expect(catalog).toHaveLength(32);
    expect(channel.models).toEqual(expect.arrayContaining(["hy3", "hy-role", "hy-mt2-pro"]));

    for (const profile of channel.modelProfiles || []) {
        if (profile.capability === "image") {
            expect(sanitizeServerImageCapability(profile.capabilityConfig?.image)).not.toBeNull();
        } else if (profile.capability === "video") {
            expect(sanitizeServerVideoCapability(profile.capabilityConfig?.video)).not.toBeNull();
        }
    }
    const seedreamPro = channel.modelProfiles?.find((item) => item.model === "doubao-seedream-5-0-pro-260628");
    expect(seedreamPro?.capabilityConfig?.image?.sequentialGeneration?.supported).toBe(false);
    expect(seedreamPro?.capabilityConfig?.image?.transparentBackground?.supported).toBe(true);
    const seedreamLite = channel.modelProfiles?.find((item) => item.model === "doubao-seedream-5-0-260128");
    expect(seedreamLite?.capabilityConfig?.image?.sequentialGeneration?.supported).toBe(true);

    const legacyYsduiChannel = createModelChannel({
        id: "ysdui",
        baseUrl: "https://tokenhub.ysdui.cn",
        models: ["doubao-seedream-5-0-pro-260628", "doubao-seedance-2-0-fast-260128", "wand-vega-video-1.0-lite"],
        modelProfiles: [
            {
                model: "doubao-seedream-5-0-pro-260628",
                capability: "image",
                protocol: "ysdui-image" as ModelProtocolDefinition["value"],
                capabilityConfig: {
                    version: 1,
                    image: {
                        ...defaultModelCapabilityConfig("openai-image", "fixture").image!,
                        transparentBackground: { supported: false, default: false },
                        sequentialGeneration: { supported: true, default: false },
                    },
                },
            },
            {
                model: "doubao-seedance-2-0-fast-260128",
                capability: "video",
                protocol: "ysdui-video" as ModelProtocolDefinition["value"],
                capabilityConfig: {
                    version: 1,
                    video: {
                        ...defaultModelCapabilityConfig("newapi", "fixture").video!,
                        resolutions: ["480P", "720P", "1080P"],
                        defaultResolution: "1080P",
                    },
                },
            },
            {
                model: "wand-vega-video-1.0-lite",
                capability: "video",
                protocol: "ysdui-video" as ModelProtocolDefinition["value"],
                capabilityConfig: {
                    version: 1,
                    video: {
                        ...defaultModelCapabilityConfig("newapi", "fixture").video!,
                        resolutions: ["720P", "1080P"],
                        defaultResolution: "720P",
                    },
                },
            },
        ],
    });
    const hydratedYsdui = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [legacyYsduiChannel] } }).config.channels[0];
    expect(hydratedYsdui.modelProfiles?.[0]?.capabilityConfig?.image?.sequentialGeneration?.supported).toBe(false);
    expect(hydratedYsdui.modelProfiles?.[0]?.capabilityConfig?.image?.transparentBackground?.supported).toBe(true);
    expect(hydratedYsdui.modelProfiles?.[1]?.capabilityConfig?.video?.resolutions).toEqual(["480P", "720P"]);
    expect(hydratedYsdui.modelProfiles?.[1]?.capabilityConfig?.video?.defaultResolution).toBe("720P");
    expect(hydratedYsdui.modelProfiles?.[2]?.capabilityConfig?.video?.resolutions).toEqual(["768P", "1080P"]);
    expect(hydratedYsdui.modelProfiles?.[2]?.capabilityConfig?.video?.defaultResolution).toBe("768P");

    const resolvedProtocols = new Set(
        catalog.map((item) => serviceModelProfile(channel, item, ysduiProtocols).protocol),
    );
    expect([...resolvedProtocols].sort()).toEqual([
        "chat-completion",
        "ysdui-image",
        "ysdui-image-task",
        "ysdui-video",
    ]);

    const unknownImage = serviceModelProfile(channel, { id: "custom-ysdui-image-model", modelType: "image" }, ysduiProtocols);
    expect(unknownImage.protocol).toBeUndefined();

    const withoutPlugin = catalog.map((item) => serviceModelProfile(channel, item, protocols));
    expect(withoutPlugin.find((profile) => profile.capability === "text")?.protocol).toBe("chat-completion");
    for (const mediaProfile of withoutPlugin.filter((profile) => profile.capability !== "text")) {
        expect(mediaProfile.protocol).toBeUndefined();
    }
});

test("LL2 service preset resolves all 7 LL2 protocols when plugin is enabled and fails closed when disabled", () => {
    const ll2Protocols = [
        ...protocols,
        ...["ll2-wan3-video", "ll2-seedance-video", "ll2-vidu-video", "ll2-minimax-video", "ll2-super-vega-video", "ll2-auto-hd-video"].map(
            (value) => ({ value, capability: "video", authType: "bearer", enabled: true } as ModelProtocolDefinition),
        ),
    ];
    expect(ll2ProtocolsAvailable(ll2Protocols)).toBe(true);
    expect(ll2ProtocolsAvailable(protocols)).toBe(false);

    const channel = createServicePresetChannel("ll2", "ll2-test", ll2Protocols);
    const catalog = presetCatalogFor("ll2");
    expect(servicePresetFor(channel)).toBe("ll2");
    expect(channel.name).toBe("LL2 (DMC)");
    expect(channel.baseUrl).toBe("https://api.ll2.cn");
    expect(channel.models).toHaveLength(16);
    expect(catalog).toHaveLength(16);

    const resolvedProtocols = new Set(
        catalog.map((item) => serviceModelProfile(channel, item, ll2Protocols).protocol),
    );
    expect([...resolvedProtocols].sort()).toEqual([
        "chat-completion",
        "ll2-auto-hd-video",
        "ll2-minimax-video",
        "ll2-seedance-video",
        "ll2-super-vega-video",
        "ll2-vidu-video",
        "ll2-wan3-video",
    ]);

    // When the LL2 plugin is disabled/missing, video models must not resolve to unavailable ll2-* protocols.
    const withoutPlugin = catalog.map((item) => serviceModelProfile(channel, item, protocols));
    expect(withoutPlugin.find((profile) => profile.capability === "text")?.protocol).toBe("chat-completion");
    for (const videoProfile of withoutPlugin.filter((profile) => profile.capability === "video")) {
        expect(videoProfile.protocol).toBeUndefined();
    }

    // Switching back to another preset clears LL2 preset models.
    const switched = createServicePresetChannel("compatible", "ll2-test", ll2Protocols);
    expect(switched.models).toEqual([]);
    expect(presetCatalogFor("compatible")).toEqual([]);
});

test("mergeSavedServiceChannel prioritizes exact channel id, collapses duplicate LL2 channels, and remaps model selections", () => {
    const ch1 = createModelChannel({ id: "ll2-first", name: "LL2 (DMC)", baseUrl: "https://api.ll2.cn", apiKey: "k1", models: ["deepseek-v4.1-flash"] });
    const ch2 = createModelChannel({ id: "ll2-second", name: "LL2 (DMC) #2", baseUrl: "https://api.ll2.cn", apiKey: "k2", models: ["viduq3-pro"] });
    const latest = {
        ...defaultConfig,
        channels: [ch1, ch2],
        model: "ll2-first::deepseek-v4.1-flash",
        videoModel: "ll2-second::viduq3-pro",
        assistantModel: "ll2-first::deepseek-v4.1-flash",
        mediaReviewModel: "ll2-second::viduq3-pro",
    };

    // Editing ch2 (exact match on id="ll2-second") keeps "ll2-second", collapses "ll2-first",
    // remaps models supported by ch2, and clears selections not offered by ch2
    const editedCh2 = { ...ch2, models: ["deepseek-v4.1-flash", "viduq3-pro"], apiKey: "k2-updated" };
    const mergedFromEdit = mergeSavedServiceChannel(latest, editedCh2);
    expect(mergedFromEdit.channels).toHaveLength(1);
    expect(mergedFromEdit.channels[0].id).toBe("ll2-second");
    expect(mergedFromEdit.channels[0].apiKey).toBe("k2-updated");
    expect(mergedFromEdit.baseConfig.model).toBe("ll2-second::deepseek-v4.1-flash");
    expect(mergedFromEdit.baseConfig.assistantModel).toBe("ll2-second::deepseek-v4.1-flash");
    expect(mergedFromEdit.baseConfig.videoModel).toBe("ll2-second::viduq3-pro");

    // When the surviving channel does NOT offer the removed channel's model, remapModel clears it instead of pointing to a missing model
    const mergedNarrow = mergeSavedServiceChannel(latest, { ...ch2, models: ["viduq3-pro"] });
    expect(mergedNarrow.baseConfig.assistantModel).toBe("");
    expect(mergedNarrow.baseConfig.videoModel).toBe("ll2-second::viduq3-pro");

    // Adding a brand new LL2 channel (no exact id match) collapses into existing "ll2-first"
    const brandNew = createModelChannel({ id: "ll2-brand-new", name: "LL2 (DMC)", baseUrl: "https://api.ll2.cn", apiKey: "k3", models: ["MiniMax-H3"] });
    const mergedFromNew = mergeSavedServiceChannel({ ...latest, channels: [ch1] }, brandNew);
    expect(mergedFromNew.channels).toHaveLength(1);
    expect(mergedFromNew.channels[0].id).toBe("ll2-first");
    expect(mergedFromNew.channels[0].apiKey).toBe("k3");
});

test("legacy LL2 auto-hd profile upgrades expired testVideoUrl and removes unsupported 720p resolution", () => {
    const ll2Protocols = [
        ...protocols,
        { value: "ll2-auto-hd-video", capability: "video", authType: "bearer", enabled: true } as ModelProtocolDefinition,
    ];
    const legacyChannel = createModelChannel({
        id: "ll2",
        baseUrl: "https://api.ll2.cn",
        models: ["auto-hd"],
        modelProfiles: [
            {
                model: "auto-hd",
                capability: "video",
                protocol: "ll2-auto-hd-video",
                defaultOptions: {
                    testVideoUrl: "https://h3-gz-public-1483601991.cos.ap-guangzhou.myqcloud.com/outputs/expired.mp4",
                },
                capabilityConfig: {
                    version: 1,
                    video: {
                        duration: { selection: "enum", values: [5], default: 5 },
                        ratios: [],
                        defaultRatio: "",
                        resolutions: ["720p", "1080p", "2k", "4k"],
                        defaultResolution: "720p",
                        generateAudio: { supported: false, default: false },
                        watermark: { supported: false, default: false },
                        operations: ["reference_to_video"],
                        defaultOperation: "reference_to_video",
                    },
                },
            },
        ],
    });
    const upgraded = serviceModelProfile(legacyChannel, { id: "auto-hd", modelType: "video" }, ll2Protocols);
    expect(upgraded.defaultOptions?.testVideoUrl).toContain("help-static-aliyun-doc.aliyuncs.com");
    expect(upgraded.capabilityConfig?.video?.resolutions).toEqual(["1080p", "2k", "4k"]);
    expect(upgraded.capabilityConfig?.video?.defaultResolution).toBe("1080p");

    // Non-LL2 channel sharing a model name must not have its resolutions rewritten on config hydration
    const nonLL2Channel = createModelChannel({
        id: "ark-custom",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        models: ["doubao-seedance-2-0"],
        modelProfiles: [
            {
                model: "doubao-seedance-2-0",
                capability: "video",
                protocol: "volcengine-ark-video",
                capabilityConfig: {
                    version: 1,
                    video: {
                        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
                        ratios: ["16:9"],
                        defaultRatio: "16:9",
                        resolutions: ["480p", "720p", "1080p"],
                        defaultResolution: "1080p",
                        generateAudio: { supported: true, default: true },
                        watermark: { supported: true, default: false },
                        operations: ["text_to_video"],
                        defaultOperation: "text_to_video",
                    },
                },
            },
        ],
    });
    const hydrated = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [nonLL2Channel] } }).config;
    expect(hydrated.channels[0].modelProfiles?.[0]?.capabilityConfig?.video?.resolutions).toEqual(["480p", "720p", "1080p"]);
});

test("a retired interface is not offered again but still names a saved choice", () => {
    const item = { id: "old-video", version: "1.0.0", name: "旧视频接口", vendor: "Test", categories: ["video"], scopes: ["user.custom-channel"], enabled: true, retired: true, create: "POST /v1/old" };
    const [definition] = toProviderDefinitions(item);
    expect(definition.enabled).toBe(false);
    expect(defaultProtocolForCapability("video", [definition])).not.toBe("old-video");
    expect(modelProtocolDefinition("old-video", [definition])?.label).toBe("旧视频接口");
});

test("upgradeYsduiModelProfile preserves server-versioned capabilities and keeps user defaultResolution valid", async () => {
    const { upgradeYsduiModelProfile } = await import("../../plugin-packages/beeftv-plugin-ysdui/client/presets.js");
    const serverProfile = {
        model: "doubao-seedream-5-0-pro-260628",
        capability: "image",
        protocol: "ysdui-image",
        imageCapabilitiesVersion: "server-v2",
        capabilityConfig: {
            version: 1,
            image: {
                size: { parameter: "size", values: ["1:1"], default: "1:1" },
                sequentialGeneration: { supported: true, default: false },
            },
        },
    };
    expect(upgradeYsduiModelProfile(serverProfile)).toBe(serverProfile);

    const userVideoProfile = {
        model: "wand-vega-video-1.0-lite",
        capability: "video",
        protocol: "ysdui-video",
        capabilitySource: "user",
        capabilityConfig: {
            version: 1,
            video: {
                duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
                ratios: ["16:9"],
                defaultRatio: "16:9",
                resolutions: ["720P", "1080P"],
                defaultResolution: "720P",
                generateAudio: { supported: false, default: false },
                watermark: { supported: false, default: false },
                operations: ["text_to_video"],
                defaultOperation: "text_to_video",
            },
        },
    };
    const migrated = upgradeYsduiModelProfile(userVideoProfile);
    expect(migrated.capabilityConfig.video.resolutions).toEqual(["1080P"]);
    expect(migrated.capabilityConfig.video.defaultResolution).toBe("1080P");

    const ysduiClient = await import("../../plugin-packages/beeftv-plugin-ysdui/client/index.js");
    let contributedComponent: ReactNamespace.ComponentType<Record<string, unknown>> | null = null;
    ysduiClient.activate({
        React: ReactNamespace,
        contribute: (_slot: string, payload: { component: ReactNamespace.ComponentType<Record<string, unknown>> }) => {
            contributedComponent = payload.component;
            return () => undefined;
        },
    });
    expect(contributedComponent).not.toBeNull();
    const panelMarkup = renderToStaticMarkup(createElement(contributedComponent!, {}));
    expect(panelMarkup).toContain('fill="#005CD2"');
    expect(panelMarkup).toContain("银盛通信有限公司成立于2002年，注册资本5亿元，国家高新技术企业。");
});

test("raw # baseUrl passes service and channel validation while real URL fragments stay rejected", () => {
    const baseChannel = createModelChannel({ name: "本地无前缀", apiKey: "fixture-key", models: ["demo-model"], modelProfiles: [{ model: "demo-model", capability: "text", protocol: "chat-completion" }] });
    for (const validUrl of ["http://127.0.0.1#", "http://127.0.0.1:8000/custom/#", "https://relay.example.com#"]) {
        expect(serviceConnectionError({ ...baseChannel, baseUrl: validUrl }, { protocols })).toBe("");
        expect(channelValidationError({ ...baseChannel, baseUrl: validUrl })).toBe("");
    }
    for (const invalidUrl of ["http://127.0.0.1#frag", "http://127.0.0.1##", "http://127.0.0.1/#/", "http://127.0.0.1/#//", "#", "http://127.0.0.1/chat/completions#"]) {
        expect(serviceConnectionError({ ...baseChannel, baseUrl: invalidUrl }, { protocols })).not.toBe("");
        expect(serviceConnectionError({ ...baseChannel, baseUrl: normalizeChannelBaseUrl(invalidUrl) }, { protocols })).not.toBe("");
    }
    expect(channelValidationError({ ...baseChannel, baseUrl: "http://127.0.0.1#frag" })).toBe("Base URL 格式不正确");
});

test("external seedance-2-5 hyphen model id receives 30s Seedance 2.5 video limits", () => {
    const cap = defaultModelCapabilityConfig("newapi", "seedance-2-5");
    expect(cap).toEqual(defaultModelCapabilityConfig("newapi", "seedance-2.5"));
    expect(cap?.video?.duration?.max).toBe(30);
    expect(cap?.video?.references).toMatchObject({ maxImages: 30, maxVideos: 10, maxAudios: 10, maxVideoDurationSeconds: 30 });
});

test("manual model entries can be renamed, retyped, and deleted without losing configured profiles", () => {
    const videoCap = defaultModelCapabilityConfig("newapi", "seedance-2-5");
    const initialChannel = createModelChannel({
        id: "custom",
        baseUrl: "http://127.0.0.1#",
        apiKey: "fixture-key",
        models: ["typo-vid", "keep-text"],
        modelProfiles: [
            { model: "typo-vid", displayName: "typo-vid", capability: "video", protocol: "newapi", capabilityConfig: videoCap },
            { model: "keep-text", capability: "text", protocol: "chat-completion" },
            { model: "unchecked-typo", displayName: "unchecked-typo", capability: "image", protocol: "openai-image" },
        ],
    });
    const initialCatalog = [
        { id: "typo-vid", displayName: "typo-vid", modelType: "video" as const },
        { id: "keep-text", modelType: "text" as const },
        { id: "unchecked-typo", displayName: "unchecked-typo", modelType: "image" as const },
    ];

    const duplicate = updateManualModelEntry({
        channel: initialChannel,
        catalog: initialCatalog,
        previousId: "typo-vid",
        nextId: "keep-text",
        capability: "video",
        protocols,
    });
    expect(duplicate.error).toBe("这个模型已在列表中");

    const renamed = updateManualModelEntry({
        channel: initialChannel,
        catalog: initialCatalog,
        previousId: "typo-vid",
        nextId: "seedance-2-5",
        capability: "video",
        protocols,
    });
    expect(renamed.error).toBeUndefined();
    expect(renamed.channel.models).toEqual(["seedance-2-5", "keep-text"]);
    expect(renamed.catalog.map((item) => item.id)).toEqual(["seedance-2-5", "keep-text", "unchecked-typo"]);
    const renamedProfile = renamed.channel.modelProfiles?.find((p) => p.model === "seedance-2-5");
    expect(renamedProfile).toMatchObject({
        model: "seedance-2-5",
        capability: "video",
        protocol: "newapi",
        capabilityConfig: videoCap,
    });
    expect(renamedProfile?.displayName).toBeUndefined();

    const renamedUnchecked = updateManualModelEntry({
        channel: renamed.channel,
        catalog: renamed.catalog,
        previousId: "unchecked-typo",
        nextId: "gpt-image-1",
        capability: "image",
        protocols,
    });
    expect(renamedUnchecked.error).toBeUndefined();
    expect(renamedUnchecked.channel.models).toEqual(["seedance-2-5", "keep-text"]);
    expect(renamedUnchecked.catalog.map((item) => item.id)).toEqual(["seedance-2-5", "keep-text", "gpt-image-1"]);

    const removed = removeManualModelEntry(renamedUnchecked.channel, renamedUnchecked.catalog, "seedance-2-5");
    expect(removed.channel.models).toEqual(["keep-text"]);
    expect(removed.catalog.map((item) => item.id)).toEqual(["keep-text", "gpt-image-1"]);
    expect(removed.channel.modelProfiles?.map((p) => p.model)).toEqual(["keep-text", "gpt-image-1"]);
});

test("re-reading ComfyUI workflows updates changed capability and multimodal defaults without renaming (#540)", () => {
    const comfyProtocols = [
        ...protocols,
        ...toProviderDefinitions({
            id: "comfyui",
            version: "0.2.0",
            name: "ComfyUI",
            vendor: "ComfyUI",
            categories: ["image", "video", "audio"],
            scopes: ["user.custom-channel"],
            enabled: true,
            module: true,
            authType: "none",
            baseUrl: "http://127.0.0.1:8188",
        }),
    ];
    const channel = createPluginServiceChannel(comfyProtocols.find((p) => p.value === "comfyui")!, "comfy");
    const savedImageChannel = {
        ...channel,
        models: ["workflow.json"],
        modelProfiles: [{
            model: "workflow.json",
            capability: "image" as const,
            protocol: "comfyui" as const,
            capabilityConfig: defaultModelCapabilityConfig("comfyui", "workflow.json", comfyProtocols),
        }],
    };
    const switchedToVideo = serviceModelProfile(savedImageChannel, { id: "workflow.json", displayName: "workflow", modelType: "video" }, comfyProtocols);
    expect(switchedToVideo.capability).toBe("video");
    expect(switchedToVideo.capabilityConfig?.video?.operations).toContain("reference_to_video");
    expect(switchedToVideo.capabilityConfig?.video?.references.maxAudios).toBe(3);

    const refreshedCatalog = applyFetchedChannelModelCatalog(savedImageChannel, {
        models: ["workflow.json"],
        catalog: [{ id: "workflow.json", displayName: "workflow", modelType: "video" }],
    });
    const refreshedProfile = refreshedCatalog.modelProfiles?.find((p) => p.model === "workflow.json");
    expect(refreshedProfile?.capability).toBe("video");
    expect(refreshedProfile?.capabilityConfig?.video?.operations).toContain("reference_to_video");
    expect(refreshedProfile?.capabilityConfig?.video?.references.maxAudios).toBe(3);
});

test("saved pre-2.2.0 AutoDL workflow profiles upgrade media bounds and operations while keeping user overrides", () => {
    const workflows = [
        {
            id: "minimax_h3_b99_001",
            label: "H3 文生视频",
            providerId: "autodl-comfyui",
            capability: "video" as const,
            parameters: [
                { name: "prompt", type: "string", required: true, mapping: "prompt" },
                { name: "resolution", type: "string", mapping: "resolution", values: ["736p竖", "736p横"] },
                { name: "images", type: "array", mapping: "images", min: 0, max: 0 },
            ],
            defaults: { resolution: "736p竖" },
        },
        {
            id: "minimax_h3_image_audio_to_video",
            label: "H3 图生视频音频同步",
            providerId: "autodl-comfyui",
            capability: "video" as const,
            parameters: [
                { name: "resolution", type: "string", mapping: "resolution", values: ["768p竖", "768p横"] },
                { name: "images", type: "array", mapping: "images", max: 1 },
                { name: "audios", type: "array", mapping: "audios", max: 3 },
            ],
            defaults: { resolution: "768p竖" },
        },
        {
            id: "minimax_h3_zm_u24",
            label: "H3 ZM U24",
            providerId: "autodl-comfyui",
            capability: "video" as const,
            parameters: [
                { name: "prompt", type: "string", required: true, mapping: "prompt" },
                { name: "resolution", type: "string", mapping: "resolution", values: ["768p竖", "768p横"] },
                { name: "images", type: "array", mapping: "images", max: 9 },
            ],
            defaults: { resolution: "768p竖" },
        },
    ];
    const autodlProtocol: ModelProtocolDefinition = {
        value: "autodl-comfyui",
        label: "AutoDL",
        capability: "video",
        create: "POST /api/v1/comfyui/comfyui_workflow/{{model}}",
        contentType: "application/json",
        media: "plugin",
        enabled: true,
        authType: "header",
        workflows,
    };
    const allProtocols = [...protocols, autodlProtocol];
    const staleBase = defaultModelCapabilityConfig("autodl-comfyui", "minimax_h3_image_audio_to_video");
    // Pre-2.2.0 saved AutoDL config: resolution-only (`ratios: []`), old default `maxImages: 9`, missing `maxAudios`/`reference_to_video`.
    staleBase.video!.ratios = [];
    staleBase.video!.defaultRatio = "";
    staleBase.video!.operations = ["text_to_video", "image_to_video"];

    const savedChannel = createModelChannel({
        id: "autodl",
        baseUrl: "https://autodl.art",
        models: ["minimax_h3_b99_001", "minimax_h3_image_audio_to_video", "minimax_h3_zm_u24"],
        modelProfiles: [
            { model: "minimax_h3_b99_001", capability: "video", protocol: "autodl-comfyui", capabilityConfig: structuredClone(staleBase) },
            { model: "minimax_h3_image_audio_to_video", capability: "video", protocol: "autodl-comfyui", capabilityConfig: structuredClone(staleBase) },
            { model: "minimax_h3_zm_u24", capability: "video", protocol: "autodl-comfyui", capabilitySource: "user", capabilityConfig: structuredClone(staleBase) },
        ],
    });

    const b99 = serviceModelProfile(savedChannel, { id: "minimax_h3_b99_001" }, allProtocols);
    expect(b99.capabilityConfig?.video?.references.maxImages).toBe(0);
    expect(b99.capabilityConfig?.video?.operations).toEqual(["text_to_video"]);

    const imgAudio = serviceModelProfile(savedChannel, { id: "minimax_h3_image_audio_to_video" }, allProtocols);
    expect(imgAudio.capabilityConfig?.video?.references.maxImages).toBe(1);
    expect(imgAudio.capabilityConfig?.video?.references.maxAudios).toBe(3);
    expect(imgAudio.capabilityConfig?.video?.operations).toEqual(["image_to_video", "reference_to_video"]);

    const userOverride = serviceModelProfile(savedChannel, { id: "minimax_h3_zm_u24" }, allProtocols);
    expect(userOverride.capabilitySource).toBe("user");
    expect(userOverride.capabilityConfig?.video?.operations).toEqual(["text_to_video", "image_to_video"]);

    const serverOwnedBase = defaultModelCapabilityConfig("autodl-comfyui", "minimax_h3_image_audio_to_video");
    serverOwnedBase.video!.ratios = ["16:9", "9:16"];
    serverOwnedBase.video!.defaultRatio = "16:9";
    serverOwnedBase.video!.operations = ["text_to_video", "reference_to_video"];
    const serverOwnedChannel = createModelChannel({
        id: "autodl-server-owned",
        baseUrl: "https://autodl.art",
        models: ["minimax_h3_zm_u24"],
        modelProfiles: [
            {
                model: "minimax_h3_zm_u24",
                capability: "video",
                protocol: "autodl-comfyui",
                videoCapabilitiesVersion: "gw-v1",
                capabilityConfig: structuredClone(serverOwnedBase),
            },
        ],
    });
    const serverOwned = serviceModelProfile(serverOwnedChannel, { id: "minimax_h3_zm_u24" }, allProtocols);
    expect(serverOwned.videoCapabilitiesVersion).toBe("gw-v1");
    expect(serverOwned.capabilityConfig).toEqual(serverOwnedBase);

    const unrelatedVersionsChannel = createModelChannel({
        id: "autodl-unrelated-versions",
        baseUrl: "https://autodl.art",
        models: ["minimax_h3_image_audio_to_video"],
        modelProfiles: [
            {
                model: "minimax_h3_image_audio_to_video",
                capability: "video",
                protocol: "autodl-comfyui",
                imageCapabilitiesVersion: "img-v1",
                mediaCapabilitiesVersion: "aud-v1",
                capabilityConfig: structuredClone(staleBase),
            },
        ],
    });
    const upgradedUnrelated = serviceModelProfile(unrelatedVersionsChannel, { id: "minimax_h3_image_audio_to_video" }, allProtocols);
    expect(upgradedUnrelated.capabilityConfig?.video?.references.maxImages).toBe(1);
    expect(upgradedUnrelated.capabilityConfig?.video?.references.maxAudios).toBe(3);
    expect(upgradedUnrelated.capabilityConfig?.video?.operations).toEqual(["image_to_video", "reference_to_video"]);
});

test("versioned ComfyUI module profiles preserve capabilityConfig across preset sync and catalog refresh", () => {
    const comfyProtocols = [
        ...protocols,
        ...toProviderDefinitions({
            id: "comfyui",
            version: "0.2.0",
            name: "ComfyUI",
            vendor: "ComfyUI",
            categories: ["image", "video", "audio"],
            scopes: ["user.custom-channel"],
            enabled: true,
            module: true,
            authType: "none",
            baseUrl: "http://127.0.0.1:8188",
        }),
    ];
    const channel = createPluginServiceChannel(comfyProtocols.find((p) => p.value === "comfyui")!, "comfy-versioned");
    const customConfig = defaultModelCapabilityConfig("comfyui", "custom.json", comfyProtocols);
    customConfig.video!.ratios = ["21:9", "16:9"];
    customConfig.video!.defaultRatio = "21:9";
    customConfig.video!.references.maxImages = 2;
    customConfig.video!.references.maxAudios = 0;

    const versionedChannel = {
        ...channel,
        models: ["custom.json"],
        modelProfiles: [{
            model: "custom.json",
            capability: "video" as const,
            protocol: "comfyui" as const,
            videoCapabilitiesVersion: "gw-v1",
            capabilityConfig: structuredClone(customConfig),
        }],
    };
    const synced = serviceModelProfile(versionedChannel, { id: "custom.json", displayName: "custom", modelType: "video" }, comfyProtocols);
    expect(synced.videoCapabilitiesVersion).toBe("gw-v1");
    expect(synced.capabilitySource).toBeUndefined();
    expect(synced.capabilityConfig).toEqual(customConfig);

    const refreshed = applyFetchedChannelModelCatalog(versionedChannel, {
        models: ["custom.json"],
        catalog: [{ id: "custom.json", displayName: "custom", modelType: "video" }],
    });
    const refreshedProfile = refreshed.modelProfiles?.find((p) => p.model === "custom.json");
    expect(refreshedProfile?.videoCapabilitiesVersion).toBe("gw-v1");
    expect(refreshedProfile?.capabilityConfig).toEqual(customConfig);
});

test("LL2 wan3.0-video and Super Vega user-edited profiles migrate 2160p/1440p without silent downgrade to 720P", () => {
    const legacyLL2 = createModelChannel({
        id: "ll2",
        baseUrl: "https://api.ll2.cn",
        models: ["wan3.0-video", "Super Vega 1.0-pro"],
        modelProfiles: [
            {
                model: "wan3.0-video",
                capability: "video",
                protocol: "newapi",
                capabilitySource: "user",
                capabilityConfig: {
                    version: 1,
                    video: {
                        ...defaultModelCapabilityConfig("newapi", "wan3.0-video").video!,
                        resolutions: ["480p", "720p", "1080p", "1440p", "2160p"],
                        defaultResolution: "2160p",
                        ratios: ["16:9", "9:16", "21:9"],
                        defaultRatio: "21:9",
                    },
                },
            },
            {
                model: "Super Vega 1.0-pro",
                capability: "video",
                protocol: "ll2-super-vega-video",
                capabilitySource: "user",
                capabilityConfig: {
                    version: 1,
                    video: {
                        ...defaultModelCapabilityConfig("newapi", "fixture").video!,
                        resolutions: ["720p", "1440p", "2160p"],
                        defaultResolution: "2160p",
                    },
                },
            },
        ],
    });
    const hydrated = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [legacyLL2] } }).config.channels[0];
    const wan3 = hydrated.modelProfiles?.find((p) => p.model === "wan3.0-video");
    expect(wan3?.protocol).toBe("ll2-wan3-video");
    expect(wan3?.capabilityConfig?.video?.resolutions).toEqual(["480P", "720P", "1080P"]);
    expect(wan3?.capabilityConfig?.video?.defaultResolution).toBe("1080P");
    expect(wan3?.capabilityConfig?.video?.ratios).toEqual(["16:9", "9:16"]);
    expect(wan3?.capabilityConfig?.video?.defaultRatio).toBe("16:9");

    const vega = hydrated.modelProfiles?.find((p) => p.model === "Super Vega 1.0-pro");
    expect(vega?.capabilityConfig?.video?.resolutions).toEqual(["720P", "2K", "4K"]);
    expect(vega?.capabilityConfig?.video?.defaultResolution).toBe("4K");

    // 当分辨率列表本身已是合法的 480P/720P/1080P 但 defaultResolution 仍是非法 2160p 时，同样修复为 1080P。
    const validListBadDefault = createModelChannel({
        id: "ll2",
        baseUrl: "https://api.ll2.cn",
        models: ["wan3.0-video"],
        modelProfiles: [{
            model: "wan3.0-video",
            capability: "video",
            protocol: "ll2-wan3-video",
            capabilitySource: "user",
            capabilityConfig: {
                version: 1,
                video: {
                    ...defaultModelCapabilityConfig("newapi", "wan3.0-video").video!,
                    resolutions: ["480P", "720P", "1080P"],
                    defaultResolution: "2160p",
                    ratios: ["16:9"],
                    defaultRatio: "16:9",
                },
            },
        }],
    });
    const repairedDefault = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [validListBadDefault] } }).config.channels[0];
    expect(repairedDefault.modelProfiles?.[0]?.capabilityConfig?.video?.defaultResolution).toBe("1080P");
});

test("dynamic partner hot-onboards without desktop rebuild, renders cached icon and affiliate link, and hides on expiry while keeping saved channels working", async () => {
    try {
        // 拒绝伪造或抢占核心预设与已有合作伙伴预设 ID。
        expect(syncBuiltinPresetFromModule("beeftv-plugin-evil", {
            BUILTIN_SERVICE_PRESET: {
                id: "openai",
                baseUrl: "https://evil.example",
                models: [],
                buildChannel: () => ({ models: [], modelProfiles: [] }),
                upgradeProfile: (p: unknown) => p,
            },
        })).toBe(false);
        expect(syncBuiltinPresetFromModule("beeftv-plugin-evil", {
            BUILTIN_SERVICE_PRESET: {
                id: "ll2",
                baseUrl: "https://evil.example",
                models: [],
                buildChannel: () => ({ models: [], modelProfiles: [] }),
                upgradeProfile: (p: unknown) => p,
            },
        })).toBe(false);

        const acmeModule = {
            BUILTIN_SERVICE_PRESET: {
                id: "acme",
                name: "Acme 算力云",
                subtitle: "文本 · 高清视频",
                icon: "OpenAI",
                baseUrl: "https://api.acme-cloud.example",
                partner: true,
                keysUrl: "https://untrusted-self-declared.example/ref",
                protocolPrefixes: ["acme-"],
                hosts: ["api.acme-cloud.example"],
                hostSuffixes: [".acme-cloud.example"],
                models: [{
                    model: "acme-video-1",
                    displayName: "Acme Video 1.0",
                    capability: "video",
                    protocol: "acme-video",
                }],
                presetDescription: "文本与视频",
                buildChannel({ baseUrl }: { baseUrl: string }) {
                    return {
                        models: ["acme-video-1"],
                        modelProfiles: [{
                            model: "acme-video-1",
                            displayName: "Acme Video 1.0",
                            capability: "video",
                            protocol: "acme-video",
                        }],
                        baseUrl,
                    };
                },
                upgradeProfile<T extends { model?: string; protocol?: string }>(profile: T): T {
                    if (profile?.model === "acme-video-1" && profile.protocol === "newapi") {
                        return { ...profile, protocol: "acme-video" };
                    }
                    return profile;
                },
            },
        };

        // 动态新伙伴模块在后端权威 /api/plugins/partners 到达前激活时，仅暂存模块而不提前上线或暴露模块自报 keysUrl。
        const prevConfigSnapshot = structuredClone(useConfigStore.getState().config);
        useConfigStore.getState().replaceConfig({
            ...defaultConfig,
            channels: [createModelChannel({
                id: "acme",
                name: "Acme Legacy",
                baseUrl: "https://api.acme-cloud.example",
                models: ["acme-video-1"],
                modelProfiles: [{ model: "acme-video-1", capability: "video", protocol: "newapi" }],
            })],
        });
        expect(syncBuiltinPresetFromModule("beeftv-plugin-acme", acmeModule)).toBe(false);
        expect(partnerServicePresets().map((item) => item.id)).toEqual(["ll2", "ysdui"]);
        expect(presetKeysUrl("acme")).toBeUndefined();
        expect(useConfigStore.getState().config.channels[0]?.modelProfiles?.[0]?.protocol).toBe("newapi");

        // 后端权威目录到达后立即重放暂存模块、自动触发已存渠道 upgradeProfile 迁移，并只采信服务端 presetId / live / keysUrl / iconUrl。
        const activeSnapshot = [
            { id: "beeftv-plugin-ll2", presetId: "ll2", name: "LL2 (DMC)", live: true, installed: true, enabled: true, keysUrl: "https://hub.ll2.cn?p=rw6t" },
            { id: "beeftv-plugin-ysdui", presetId: "ysdui", name: "银盛云枢壹算", live: true, installed: true, enabled: true, keysUrl: "https://www.ysdui.cn/" },
            {
                id: "beeftv-plugin-acme",
                presetId: "acme",
                name: "Acme 算力云",
                live: true,
                installed: true,
                enabled: true,
                keysUrl: "https://acme-cloud.example/register?invite=beeftv",
                iconUrl: "/api/plugins/partners/beeftv-plugin-acme/icon?v=1234567890ab",
                promoText: "注册即送体验算力",
            },
        ];
        applyPartnerCatalogMetadata(activeSnapshot);
        expect(useConfigStore.getState().config.channels[0]?.modelProfiles?.[0]?.protocol).toBe("acme-video");
        useConfigStore.getState().replaceConfig(prevConfigSnapshot);

        // 重复接收完全相同的 75 秒定时目录快照时严格幂等：不递增 builtinPresetsVersion，也不重置已打开编辑器的用户配置。
        const versionAfterOnboarding = getBuiltinPresetsVersion();
        applyPartnerCatalogMetadata(activeSnapshot);
        applyPartnerCatalogMetadata(activeSnapshot);
        expect(getBuiltinPresetsVersion()).toBe(versionAfterOnboarding);

        // 当用户在新建服务编辑器中已修改预置模型参数或添加手动模型时，即使预设版本刷新也不会覆盖用户编辑。
        const acmeProtocols = [...protocols, { value: "acme-video", capability: "video", authType: "bearer", enabled: true } as ModelProtocolDefinition];
        const editedNewDraft = {
            ...createServicePresetChannel("acme", "acme-open-editor", acmeProtocols),
            models: ["acme-video-1", "acme-custom-2"],
            modelProfiles: [
                {
                    model: "acme-video-1",
                    capability: "video" as const,
                    protocol: "acme-video",
                    capabilitySource: "user" as const,
                    defaultOptions: { duration: "10" },
                },
                {
                    model: "acme-custom-2",
                    capability: "text" as const,
                    protocol: "chat-completion",
                },
            ],
        };
        const afterRefreshDraft = refreshNewBuiltinDraftProfiles(editedNewDraft, acmeProtocols);
        expect(afterRefreshDraft.modelProfiles?.find((p) => p.model === "acme-video-1")?.defaultOptions).toEqual({ duration: "10" });
        expect(afterRefreshDraft.modelProfiles?.some((p) => p.model === "acme-custom-2")).toBe(true);

        expect(partnerServicePresets().map((item) => item.id)).toEqual(["ll2", "ysdui", "acme"]);
        expect(standardServicePresets().map((item) => item.id)).toEqual(["compatible", "openai", "gemini", "ark"]);
        expect(presetKeysUrl("acme")).toBe("https://acme-cloud.example/register?invite=beeftv");
        expect(presetPluginId("acme")).toBe("beeftv-plugin-acme");
        expect(presetPromoText("acme")).toBe("注册即送体验算力");

        const acmePreset = partnerServicePresets().find((item) => item.id === "acme");
        const renderedImgLogo = renderToStaticMarkup(createElement(ModelLogo, { icon: acmePreset?.icon, size: 24 }));
        expect(renderedImgLogo).toContain('src="/api/plugins/partners/beeftv-plugin-acme/icon?v=1234567890ab"');

        const acmeChannel = createServicePresetChannel("acme", "acme-user", acmeProtocols);
        expect(acmeChannel.name).toBe("Acme 算力云");
        expect(acmeChannel.baseUrl).toBe("https://api.acme-cloud.example");
        expect(acmeChannel.models).toEqual(["acme-video-1"]);
        expect(servicePresetFor(acmeChannel)).toBe("acme");

        // 新合作伙伴红点：未保存且未浏览时提示，浏览后仅递增红点版本而不递增预设版本（避免重复拉取协议目录）。
        expect(unnoticedLivePartners([acmeChannel]).map((item) => item.id)).not.toContain("acme");
        expect(unnoticedLivePartners([]).map((item) => item.id)).toContain("acme");
        const presetsVerBeforeNotice = getBuiltinPresetsVersion();
        const indicatorVerBeforeNotice = getPartnerIndicatorVersion();
        markPartnersNoticed(["ll2", "ysdui", "acme"]);
        expect(getBuiltinPresetsVersion()).toBe(presetsVerBeforeNotice);
        expect(getPartnerIndicatorVersion()).toBeGreaterThan(indicatorVerBeforeNotice);
        expect(unnoticedLivePartners([])).toEqual([]);

        // 模块自报 id 若与后端 registry presetId 不一致，拒绝注册绕过，防止脱离 until 下架管控。
        expect(syncBuiltinPresetFromModule("beeftv-plugin-acme", {
            BUILTIN_SERVICE_PRESET: {
                ...acmeModule.BUILTIN_SERVICE_PRESET,
                id: "acme-spoofed",
            },
        })).toBe(false);

        // 离线或本地回退的不完整目录（complete=false，即使含 retired 合成项）不会误删或隐藏已加载的动态伙伴预设与返佣链接。
        applyPartnerCatalogMetadata([], { complete: false });
        applyPartnerCatalogMetadata([
            { id: "beeftv-plugin-ll2", presetId: "ll2", name: "LL2 (DMC)", live: true, installed: true, enabled: true, keysUrl: "https://hub.ll2.cn?p=rw6t" },
            { id: "beeftv-plugin-acme", presetId: "acme", name: "Acme 算力云", live: false, retired: true, installed: true, enabled: true },
        ], { complete: false });
        expect(partnerServicePresets().map((item) => item.id)).toContain("acme");
        expect(presetKeysUrl("acme")).toBe("https://acme-cloud.example/register?invite=beeftv");

        // 应用保持打开期间跨越 from / until 起止时间点（含东八区 YYYY-MM-DD 自然日）即时切换上下架，并给出最近切换时刻定时延迟。
        applyPartnerCatalogMetadata([
            { id: "beeftv-plugin-ll2", presetId: "ll2", name: "LL2 (DMC)", live: true, installed: true, enabled: true },
            { id: "beeftv-plugin-ysdui", presetId: "ysdui", name: "银盛云枢壹算", live: true, installed: true, enabled: true },
            {
                id: "beeftv-plugin-acme",
                presetId: "acme",
                name: "Acme 算力云",
                live: true,
                installed: true,
                enabled: true,
                from: "2026-12-01",
                until: "2026-12-02",
                keysUrl: "https://acme-cloud.example/register?invite=beeftv",
            },
        ]);
        const beforeFromMs = Date.parse("2026-11-30T23:59:59+08:00");
        const duringWindowMs = Date.parse("2026-12-02T23:59:59+08:00");
        const afterUntilMs = Date.parse("2026-12-03T00:00:00+08:00");
        expect(nextActivePartnerWindowDelayMs(beforeFromMs)).toBe(1250);
        expect(partnerServicePresets(undefined, beforeFromMs).map((item) => item.id)).toEqual(["ll2", "ysdui"]);
        expect(partnerServicePresets(undefined, duringWindowMs).map((item) => item.id)).toEqual(["ll2", "ysdui", "acme"]);
        expect(partnerServicePresets(undefined, afterUntilMs).map((item) => item.id)).toEqual(["ll2", "ysdui"]);
        expect(partnerServicePresets("acme", afterUntilMs).map((item) => item.id)).toEqual(["ll2", "ysdui", "acme"]);
        expect(servicePresetFor(acmeChannel)).toBe("acme");

        // 当在期合作伙伴预装冲突或下载失败时，向前端暴露带类型的 installError 告警，重复快照保持版本幂等。
        const conflictSnapshot = [
            { id: "beeftv-plugin-ll2", presetId: "ll2", name: "LL2 (DMC)", live: true, installed: true, enabled: true, keysUrl: "https://hub.ll2.cn?p=rw6t" },
            { id: "beeftv-plugin-ysdui", presetId: "ysdui", name: "银盛云枢壹算", live: true, installed: true, enabled: true, keysUrl: "https://www.ysdui.cn/" },
            { id: "beeftv-plugin-beta", presetId: "beta", name: "Beta 算力", live: true, installed: false, enabled: false, installError: "本地已安装同名非官方插件 beeftv-plugin-beta", installErrorKind: "conflict" },
        ];
        applyPartnerCatalogMetadata(conflictSnapshot);
        expect(livePartnerSyncIssues()).toEqual([{
            id: "beeftv-plugin-beta",
            presetId: "beta",
            name: "Beta 算力",
            error: "本地已安装同名非官方插件 beeftv-plugin-beta",
            kind: "conflict",
        }]);
        const verWithIssue = getBuiltinPresetsVersion();
        applyPartnerCatalogMetadata(conflictSnapshot);
        expect(getBuiltinPresetsVersion()).toBe(verWithIssue);

        // 部分离线降级快照（complete=false）不会抹掉未出现在子集中的伙伴冲突告警。
        applyPartnerCatalogMetadata([
            { id: "beeftv-plugin-ll2", presetId: "ll2", name: "LL2 (DMC)", live: true, installed: true, enabled: true, keysUrl: "https://hub.ll2.cn?p=rw6t" },
        ], { complete: false });
        expect(livePartnerSyncIssues().map((item) => item.id)).toEqual(["beeftv-plugin-beta"]);

        // 瞬时安装失败安排真实的定时重试，不被动等待 15 分钟轮询。
        let retryFired = false;
        recordTransientPartnerRetryForTest("beeftv-plugin-beta", 60, () => { retryFired = true; });
        expect(nextTransientPartnerRetryDelayMs()).not.toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 90));
        expect(retryFired).toBe(true);
        clearTransientPartnerRetryForTest();

        // 从完整权威目录（complete=true）移除条目时，从活跃 BUILTIN_PRESETS 清理并清空返佣链接，但已安装伙伴在同会话与刷新后均保留名称/地址供老渠道编辑。
        applyPartnerCatalogMetadata([
            { id: "beeftv-plugin-ll2", presetId: "ll2", name: "LL2 (DMC)", live: true, installed: true, enabled: true, keysUrl: "https://hub.ll2.cn?p=rw6t" },
            { id: "beeftv-plugin-ysdui", presetId: "ysdui", name: "银盛云枢壹算", live: true, installed: true, enabled: true, keysUrl: "https://www.ysdui.cn/" },
            { id: "beeftv-plugin-acme", presetId: "acme", name: "Acme 算力云", live: true, installed: true, enabled: true, keysUrl: "https://acme-cloud.example/register?invite=beeftv" },
        ], { complete: true });
        applyPartnerCatalogMetadata([
            { id: "beeftv-plugin-ll2", presetId: "ll2", name: "LL2 (DMC)", live: true, installed: true, enabled: true, keysUrl: "https://hub.ll2.cn?p=rw6t" },
            { id: "beeftv-plugin-ysdui", presetId: "ysdui", name: "银盛云枢壹算", live: true, installed: true, enabled: true, keysUrl: "https://www.ysdui.cn/" },
        ], { complete: true });
        expect(BUILTIN_PRESETS.acme).toBeUndefined();
        expect(presetKeysUrl("acme")).toBeUndefined();
        expect(partnerServicePresets().map((item) => item.id)).toEqual(["ll2", "ysdui"]);
        expect(servicePresetFor(acmeChannel)).toBe("acme");
        const sameSessionRetired = partnerServicePresets("acme").find((item) => item.id === "acme");
        expect(sameSessionRetired?.name).toBe("Acme 算力云");
        expect(sameSessionRetired?.baseUrl).toBe("https://api.acme-cloud.example");
        expect(MODEL_SERVICE_PRESETS.find((item) => item.id === "acme")?.name).toBe("Acme 算力云");
        expect(livePartnerSyncIssues()).toEqual([]);

        // 模拟页面重新加载：即便远端目录已完全移除 acme，凭已安装伙伴持久化记录仍以 live=false 恢复给老渠道，且不暴露任何返佣链接。
        resetDynamicPartnersInMemoryForReloadTest();
        expect(syncBuiltinPresetFromModule("beeftv-plugin-acme", acmeModule)).toBe(true);
        applyPartnerCatalogMetadata([
            { id: "beeftv-plugin-ll2", presetId: "ll2", name: "LL2 (DMC)", live: true, installed: true, enabled: true, keysUrl: "https://hub.ll2.cn?p=rw6t" },
            { id: "beeftv-plugin-ysdui", presetId: "ysdui", name: "银盛云枢壹算", live: true, installed: true, enabled: true, keysUrl: "https://www.ysdui.cn/" },
        ], { complete: true });
        expect(partnerServicePresets().map((item) => item.id)).toEqual(["ll2", "ysdui"]);
        expect(presetKeysUrl("acme")).toBeUndefined();
        expect(servicePresetFor(acmeChannel)).toBe("acme");
        const reloadedRetired = partnerServicePresets("acme").find((item) => item.id === "acme");
        expect(reloadedRetired?.name).toBe("Acme 算力云");
        expect(reloadedRetired?.baseUrl).toBe("https://api.acme-cloud.example");

        // 测试插件包名后缀与显式 presetId 不一致（beeftv-plugin-acme-cloud -> presetId: "acme"）时的移除、冷重载与 complete=false 保持。
        clearDynamicPartnerModulesForTest();
        delete BUILTIN_PRESETS.acme;
        applyPartnerCatalogMetadata([
            { id: "beeftv-plugin-ll2", presetId: "ll2", name: "LL2 (DMC)", live: true, installed: true, enabled: true, keysUrl: "https://hub.ll2.cn?p=rw6t" },
            { id: "beeftv-plugin-ysdui", presetId: "ysdui", name: "银盛云枢壹算", live: true, installed: true, enabled: true, keysUrl: "https://www.ysdui.cn/" },
            { id: "beeftv-plugin-acme-cloud", presetId: "acme", name: "Acme 算力云", live: true, installed: true, enabled: true, keysUrl: "https://acme-cloud.example/register?invite=beeftv" },
        ], { complete: true });
        expect(syncBuiltinPresetFromModule("beeftv-plugin-acme-cloud", acmeModule)).toBe(true);
        expect(partnerServicePresets().map((item) => item.id)).toEqual(["ll2", "ysdui", "acme"]);

        // 冷重载后收到后端返回的 retired 描述符（即便某处退化给出了派生 presetId acme-cloud，前端记忆值仍优先还原为 acme）。
        resetDynamicPartnersInMemoryForReloadTest();
        applyPartnerCatalogMetadata([
            { id: "beeftv-plugin-ll2", presetId: "ll2", name: "LL2 (DMC)", live: true, installed: true, enabled: true, keysUrl: "https://hub.ll2.cn?p=rw6t" },
            { id: "beeftv-plugin-ysdui", presetId: "ysdui", name: "银盛云枢壹算", live: true, installed: true, enabled: true, keysUrl: "https://www.ysdui.cn/" },
            { id: "beeftv-plugin-acme-cloud", presetId: "acme-cloud", name: "Acme 算力云", live: false, retired: true, installed: true, enabled: true },
        ], { complete: true });
        expect(syncBuiltinPresetFromModule("beeftv-plugin-acme-cloud", acmeModule)).toBe(true);
        expect(partnerServicePresets().map((item) => item.id)).toEqual(["ll2", "ysdui"]);
        expect(presetKeysUrl("acme")).toBeUndefined();
        expect(servicePresetFor(acmeChannel)).toBe("acme");
        const mismatchReloadRetired = partnerServicePresets("acme").find((item) => item.id === "acme");
        expect(mismatchReloadRetired?.name).toBe("Acme 算力云");
        expect(mismatchReloadRetired?.baseUrl).toBe("https://api.acme-cloud.example");

        // 当仅存在已过期但需修复包目录的伙伴（live=false, repairNeeded=true -> installed=true）且无其他在期伙伴时，修复后必须刷新插件中心以加载修复后的客户端模块。
        let syncBuiltinsCalls = 0;
        let syncPluginsCalls = 0;
        await syncPartnerCatalogFromBackend({
            deps: {
                fetchCatalog: async () => ({
                    complete: true,
                    partners: [
                        {
                            id: "beeftv-plugin-acme-cloud",
                            presetId: "acme",
                            name: "Acme 算力云",
                            live: false,
                            installed: false,
                            repairNeeded: true,
                            enabled: false,
                        },
                    ],
                }),
                syncBuiltins: async () => {
                    syncBuiltinsCalls += 1;
                    return {
                        complete: true,
                        partners: [
                            {
                                id: "beeftv-plugin-acme-cloud",
                                presetId: "acme",
                                name: "Acme 算力云",
                                live: false,
                                installed: true,
                                repairNeeded: false,
                                enabled: true,
                            },
                        ],
                    };
                },
                syncPlugins: async () => {
                    syncPluginsCalls += 1;
                },
            },
        });
        expect(syncBuiltinsCalls).toBe(1);
        expect(syncPluginsCalls).toBe(1);
    } finally {
        clearTransientPartnerRetryForTest();
        clearDynamicPartnerModulesForTest();
        delete BUILTIN_PRESETS.acme;
        applyPartnerCatalogMetadata([
            { id: "beeftv-plugin-ll2", presetId: "ll2", name: "LL2 (DMC)", live: true, installed: true, enabled: true, keysUrl: "https://hub.ll2.cn?p=rw6t" },
            { id: "beeftv-plugin-ysdui", presetId: "ysdui", name: "银盛云枢壹算", live: true, installed: true, enabled: true, keysUrl: "https://www.ysdui.cn/" },
        ]);
    }
});
