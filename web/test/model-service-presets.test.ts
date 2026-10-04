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

test("test receipts apply only to the exact tested connection and model profile", () => {
    const channel = createModelChannel({ id: "receipt-channel", apiKey: "synthetic-key", modelProfiles: [{ model: "test", capability: "text", protocol: "chat-completion" }] });
    useModelConnectionTests.getState().record(channel, "test", { success: true, detail: "OK" });
    const receipts = useModelConnectionTests.getState().receipts;
    expect(currentModelConnectionReceipt(receipts, channel, "test")?.success).toBe(true);
    expect(currentModelConnectionReceipt(receipts, { ...channel, apiKey: "changed" }, "test")).toBeUndefined();
    expect(currentModelConnectionReceipt(receipts, { ...channel, baseUrl: "https://other.example" }, "test")).toBeUndefined();
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
