import { expect, test } from "bun:test";
import { assistantModelOptions, resolveAssistantModel } from "@/lib/assistant-model";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";
import { mergeManagedBeefTVCatalog } from "@/pages/settings/channel-settings-pane";

const textModels = ["deepseek-v4.1-flash", "deepseek-v4-pro", "glm-5.3-flash", "gpt-6-astra", "claude-opus-5-5", "gemini-3.8-flash", "qwen3.8-flash"];
const channel = createModelChannel({
    id: "beeftv",
    pinned: true,
    models: [...textModels, "seedream-5", "unsupported-text"],
    modelProfiles: [
        ...textModels.map(model => ({ model, capability: "text" as const, protocol: "chat-completion" as const })),
        { model: "seedream-5", capability: "image", protocol: "openai-image" },
        { model: "unsupported-text", capability: "text", protocol: "unsupported" },
    ],
});
const config = { ...defaultConfig, channels: [channel], textModel: "beeftv::qwen3.8-flash" };

test("assistant follows a custom default text model without modelProfiles", () => {
    const custom = createModelChannel({ id: "newapi-local", apiFormat: "openai", models: ["deepseek-v4-flash:free", "unclassified-model"] });
    for (const textModel of ["deepseek-v4-flash:free", "newapi-local::deepseek-v4-flash:free"]) {
        const c = { ...defaultConfig, channels: [custom], textModel };
        expect(assistantModelOptions(c)).toEqual(["newapi-local::deepseek-v4-flash:free"]);
        expect(resolveAssistantModel(c)).toBe("newapi-local::deepseek-v4-flash:free");
        expect(resolveAssistantModel({ ...c, assistantModel: "newapi-local::unclassified-model" })).toBe("");
    }
});

test("models-only fallback keeps channel and explicit profile restrictions", () => {
    const custom = createModelChannel({ id: "custom", models: ["local-text"] });
    const c = { ...defaultConfig, channels: [custom], textModel: "custom::local-text" };
    for (const update of [
        { enabled: false }, { scope: "system" as const }, { pinned: true }, { credentialRef: "managed" },
        { interfaceType: "openai-image" },
        { modelProfiles: [{ model: "local-text", capability: "image" as const, protocol: "openai-image" }] },
        { modelProfiles: [{ model: "local-text", capability: "text" as const, protocol: "unsupported" }] },
    ]) {
        expect(resolveAssistantModel({ ...c, channels: [{ ...custom, ...update }] })).toBe("");
    }
    for (const update of [
        { apiFormat: "claude" as const },
        { apiFormat: "gemini" as const },
        { interfaceType: "responses" },
        { interfaceType: "gemini-generate-content" },
        { modelProfiles: [{ model: "local-text", capability: "text" as const, protocol: "gemini-generate-content" as const }] },
        { modelProfiles: [{ model: "local-text", capability: "text" as const, protocol: "google-gemini-generate-content" as const }] },
        { modelProfiles: [{ model: "local-text", capability: "text" as const, protocol: "anthropic-messages" as const }] },
        { modelProfiles: [{ model: "local-text", capability: "text" as const, protocol: "claude-messages" as const }] },
        { apiFormat: "gemini" as const, modelProfiles: [{ model: "local-text", capability: "text" as const }] },
    ]) {
        expect(resolveAssistantModel({ ...c, channels: [{ ...custom, ...update }] })).toBe("custom::local-text");
    }
    expect(resolveAssistantModel({
        ...c,
        channels: [{ ...custom, apiFormat: "vertex" as never, modelProfiles: [{ model: "local-text", capability: "text" as const }] }],
    })).toBe("");
});

test("managed assistant list follows all catalog text models with supported protocols", () => {
    expect(assistantModelOptions(config)).toEqual(textModels.map(m => `beeftv::${m}`));
    expect(assistantModelOptions({ ...config, channels: [{ ...channel, models: textModels.filter(m => m !== "glm-5.3-flash") }] })).not.toContain("beeftv::glm-5.3-flash");
    expect(resolveAssistantModel(config)).toBe("beeftv::qwen3.8-flash");
    expect(resolveAssistantModel({ ...config, assistantModel: "beeftv::deepseek-v4-pro" })).toBe("beeftv::deepseek-v4-pro");
    expect(resolveAssistantModel({ ...config, assistantModel: "beeftv::seedream-5" })).toBe("");
    expect(resolveAssistantModel({ ...config, assistantModel: "beeftv::unsupported-text" })).toBe("");
    expect(resolveAssistantModel({ ...config, assistantModel: "beeftv::missing", textModel: "beeftv::gpt-6-astra" })).toBe("");
});

test("custom channels remain unrestricted and explicit missing models do not silently fall back", () => {
    const custom = { ...channel, id: "custom", pinned: false };
    const c = { ...config, channels: [custom], textModel: "custom::qwen3.8-flash" };
    expect(assistantModelOptions(c)).toContain("custom::qwen3.8-flash");
    expect(resolveAssistantModel(c)).toBe("custom::qwen3.8-flash");
    expect(resolveAssistantModel({ ...c, assistantModel: "custom::missing" })).toBe("");
});

test("managed aliases must resolve to an available text profile", () => {
    const alias = { ...channel, models: ["opus-catalog"], modelAliases: { "claude-opus-5-5": "opus-catalog" }, modelProfiles: [{ model: "opus-catalog", capability: "text" as const, protocol: "claude-api" as const }] };
    expect(assistantModelOptions({ ...config, channels: [alias] })).toEqual(["beeftv::opus-catalog"]);
    expect(resolveAssistantModel({ ...config, channels: [alias], assistantModel: "beeftv::claude-opus-5-5" })).toBe("beeftv::opus-catalog");
});

test("managed Gemini can follow the default text model without replacing an explicit assistant choice", () => {
    const gemini = { ...config, textModel: "beeftv::gemini-3.8-flash", assistantModel: "" };
    expect(resolveAssistantModel(gemini)).toBe("beeftv::gemini-3.8-flash");
    expect(resolveAssistantModel({ ...gemini, assistantModel: "beeftv::claude-opus-5-5" })).toBe("beeftv::claude-opus-5-5");
    const removed = { ...channel, models: textModels.filter(model => model !== "gemini-3.8-flash") };
    expect(resolveAssistantModel({ ...gemini, channels: [removed] })).toBe("");
});

test("authorization adopts server default once while ordinary refresh preserves user choice", () => {
    const current = { ...config, assistantModel: "beeftv::claude-opus-5-5" };
    const server = { ...config, assistantModel: "beeftv::gpt-6-astra" };
    expect(mergeManagedBeefTVCatalog(current, server, true).assistantModel).toBe(server.assistantModel);
    expect(mergeManagedBeefTVCatalog(current, server).assistantModel).toBe(current.assistantModel);
});
