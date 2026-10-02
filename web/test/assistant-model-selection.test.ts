import { expect, test } from "bun:test";
import { assistantModelOptions, MANAGED_ASSISTANT_MODELS, resolveAssistantModel } from "@/lib/assistant-model";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";
import { mergeManagedBeefAPICatalog } from "@/pages/settings/channel-settings-pane";

const models = [...MANAGED_ASSISTANT_MODELS, "gpt-6.1-sol", "qwen3.8-flash"];
const channel = createModelChannel({ id: "beefapi", pinned: true, models, modelProfiles: models.map(model => ({ model, capability: "text", protocol: "chat-completion" })) });
const config = { ...defaultConfig, channels: [channel], textModel: "beefapi::qwen3.8-flash" };

test("managed assistant list is curated and requires actual catalog membership", () => {
    expect(assistantModelOptions(config)).toEqual(MANAGED_ASSISTANT_MODELS.map(m => `beefapi::${m}`));
    expect(assistantModelOptions({ ...config, channels: [{ ...channel, models: models.filter(m => m !== "gpt-6.1-sol") }] })).not.toContain("beefapi::gpt-6.1-sol");
    expect(resolveAssistantModel(config)).toBe("");
    expect(resolveAssistantModel({ ...config, assistantModel: "beefapi::qwen3.8-flash", textModel: "beefapi::gpt-6-astra" })).toBe("");
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
    expect(assistantModelOptions({ ...config, channels: [alias] })).toEqual(["beefapi::opus-catalog"]);
});

test("authorization adopts server default once while ordinary refresh preserves user choice", () => {
    const current = { ...config, assistantModel: "beefapi::claude-opus-5-5" };
    const server = { ...config, assistantModel: "beefapi::gpt-6-astra" };
    expect(mergeManagedBeefAPICatalog(current, server, true).assistantModel).toBe(server.assistantModel);
    expect(mergeManagedBeefAPICatalog(current, server).assistantModel).toBe(current.assistantModel);
});
