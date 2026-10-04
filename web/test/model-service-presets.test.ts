import { expect, test } from "bun:test";
import { serviceConnectionError, serviceModelProfile, modelCatalogRequestURL } from "../src/lib/model-service-presets";
import { modelConnectionResultDetail, testChannelModelConnection } from "../src/lib/model-connection-test";
import { applyFetchedChannelModelCatalog, modelConfigChannelStatusLabel } from "../src/pages/settings/channel-settings-pane";
import { backendProviderConfig } from "../src/services/api/generation-task";
import { configWithoutCachedSecrets, createModelChannel, defaultConfig } from "../src/stores/use-config-store";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import type { ModelProtocolDefinition } from "../src/lib/model-protocols";
import { currentModelConnectionReceipt, useModelConnectionTests } from "../src/stores/use-model-connection-tests";

const protocols = [
    ["chat-completion", "text"], ["gemini-generate-content", "text"], ["gemini-image", "image"],
    ["volcengine-ark-video", "video"], ["newapi", "video"],
].map(([value, capability]) => ({ value, capability, enabled: true } as ModelProtocolDefinition));

test("persisted boolean video options are normalized without turning false back on", () => {
    const channel = createModelChannel({ id: "custom", models: ["seedance-2.0-mini"], modelProfiles: [{ model: "seedance-2.0-mini", capability: "video", protocol: "newapi" }] });
    for (const enabled of [true, false]) {
        const persisted = JSON.parse(JSON.stringify({ ...defaultConfig, channels: [channel], model: "custom::seedance-2.0-mini", videoGenerateAudio: enabled, videoWatermark: false, videoArkPrivateAssetUpload: true }));
        expect(backendProviderConfig(persisted, "video")).toMatchObject({ videoGenerateAudio: String(enabled), videoWatermark: "false", videoArkPrivateAssetUpload: "true" });
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
    expect(serviceModelProfile(unrelated, { id: "endpoint-abc" }, protocols, "video").protocol).toBe("newapi");
});

test("refresh keeps selected/manual models and user capability limits", () => {
    const config = defaultModelCapabilityConfig("newapi", "video-manual")!;
    const channel = createModelChannel({ id: "custom", models: ["video-manual"], modelProfiles: [{ model: "video-manual", capability: "video", protocol: "newapi", capabilityConfig: config }] });
    const next = applyFetchedChannelModelCatalog(channel, { models: ["video-manual", "new-model"], catalog: [{ id: "video-manual", modelType: "text" }, { id: "new-model" }] });
    expect(next.models).toEqual(["video-manual"]);
    expect(next.modelProfiles?.find((p) => p.model === "video-manual")).toEqual(channel.modelProfiles![0]);
});

test("connection validation rejects full endpoints and embedded credentials", () => {
    const channel = createModelChannel({ baseUrl: "https://api.example.com/v1", apiKey: "synthetic-key" });
    expect(serviceConnectionError(channel)).toBe("");
    expect(modelCatalogRequestURL(channel)).toBe("https://api.example.com/v1/models");
    expect(serviceConnectionError({ ...channel, baseUrl: "https://api.example.com/v1/chat/completions" })).not.toBe("");
    expect(serviceConnectionError({ ...channel, baseUrl: "https://secret@api.example.com" })).not.toBe("");
    expect(serviceConnectionError({ ...channel, referenceAssetOrigin: "https://assets.example.com" })).toBe("");
    for (const referenceAssetOrigin of ["http://assets.example.com", "https://assets.example.com/path", "https://user@assets.example.com", "https://assets.example.com?key=value"]) {
        expect(serviceConnectionError({ ...channel, referenceAssetOrigin })).not.toBe("");
    }
});

test("explicit asset origin survives channel creation and generation request assembly", () => {
    const channel = createModelChannel({ id: "custom", baseUrl: "https://api.example.com/v1", referenceAssetOrigin: " https://assets.example.com ", models: ["sd-native-full-2.5"], modelProfiles: [{ model: "sd-native-full-2.5", capability: "video", protocol: "full-video" }] });
    const config = { ...defaultConfig, channels: [channel], model: "custom::sd-native-full-2.5" };
    expect(channel.referenceAssetOrigin).toBe("https://assets.example.com");
    expect(backendProviderConfig(config, "video")).toMatchObject({ referenceAssetOrigin: channel.referenceAssetOrigin, interfaceType: "full-video" });
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
        const request = backendProviderConfig(options.config, "video");
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
