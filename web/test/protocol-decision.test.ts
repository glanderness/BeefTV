import { afterEach, describe, expect, test } from "bun:test";

import cases from "../../backend/internal/providerpreset/testdata/saved_protocol_cases.json";
import { ensureModelProfilesWithUiDefaults, newModelProtocol, recordProtocolCatalog, savedModelProtocol, type ModelProtocolDefinition, type ProtocolCapability } from "@/lib/model-protocols";
import { serviceModelProfile } from "@/lib/model-service-presets";
import { mergeFetchedChannelModelProfiles } from "@/lib/channel-model-catalog";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, resolveModelRequestConfig } from "@/stores/use-config-store";
import { loadProtocolCatalog } from "@/services/api/plugin-catalog";
import { applyFetchedChannelModelCatalog } from "@/pages/settings/channel-settings-pane";
import { apiClient } from "@/services/api/request";

const definition = (value: string, capability: ProtocolCapability, retired = false): ModelProtocolDefinition => ({ value, label: value, capability, create: "POST /x", contentType: "application/json", media: "测试", enabled: true, retired });

afterEach(() => recordProtocolCatalog(undefined));

describe("one protocol decision for saved models", () => {
    // The same cases drive providerpreset.SavedModelProtocol in the backend
    // audit, so what a request runs with is what the audit keeps installed.
    test.each(cases.map((item) => [item.name, item] as const))("%s", (_, item) => {
        const profile = item.profile as { model: string; capability?: ProtocolCapability; protocol?: string; protocolPending?: boolean };
        expect(savedModelProtocol(item.channel, profile, profile.model) || "").toBe(item.want);
    });

    test("request resolution follows the saved decision and ignores the catalog", () => {
        // Even a loaded catalog that retires the protocol does not reroute a saved model.
        recordProtocolCatalog({ status: "loaded", protocols: [definition("openai-audio", "audio", true)] });
        const channel = createModelChannel({ id: "manual", baseUrl: "https://qa.example/v1", apiKey: "fakekey", models: ["custom-voice"], modelProfiles: [{ model: "custom-voice", capability: "audio" }] });
        const config = { ...defaultConfig, channels: [channel] };
        expect(resolveModelRequestConfig(config, "manual::custom-voice").interfaceType).toBe("openai-audio");
    });
});

describe("one protocol decision for new models", () => {
    test("an unavailable catalog never assigns a protocol automatically", () => {
        const fallback = { status: "unavailable" as const, protocols: [definition("openai-image", "image")] };
        expect(newModelProtocol("image", fallback)).toEqual({ protocol: undefined, pending: true });
        const profiles = ensureModelProfilesWithUiDefaults(["gpt-image-3"], undefined, fallback);
        expect(profiles[0]).toMatchObject({ protocol: undefined, protocolPending: true });
    });

    test("a loaded catalog with no selectable protocol leaves the model pending", () => {
        expect(newModelProtocol("image", { status: "loaded", protocols: [definition("openai-image", "image", true)] })).toEqual({ protocol: undefined, pending: true });
    });

    test("callers without a catalog use the one recorded this session", () => {
        recordProtocolCatalog({ status: "loaded", protocols: [definition("openai-image", "image", true), definition("gemini-image", "image")] });
        expect(ensureModelProfilesWithUiDefaults(["gpt-image-3"], undefined, [])[0]).toMatchObject({ protocol: "gemini-image" });
    });

    test("a retired protocol stays out of a later fallback list", () => {
        recordProtocolCatalog({ status: "loaded", protocols: [definition("openai-image", "image", true)] });
        recordProtocolCatalog({ status: "unavailable", protocols: [definition("openai-image", "image")] });
        expect(newModelProtocol("image").protocol).toBeUndefined();
    });

    test("with no catalog at all the legacy defaults still let setup proceed", () => {
        expect(newModelProtocol("text")).toEqual({ protocol: "chat-completion" });
        expect(newModelProtocol("audio")).toEqual({ protocol: "openai-audio" });
        expect(newModelProtocol("video").protocol).toBe("newapi-channel-2");
    });

    test("the model-service editor does not assign a retired protocol", () => {
        const channel = createModelChannel({ id: "svc", baseUrl: "https://api.example/v1", apiKey: "fakekey", models: [] });
        const catalog = { status: "loaded" as const, protocols: [definition("openai-image", "image", true)] };
        expect(serviceModelProfile(channel, { id: "gpt-image-3", modelType: "image" }, catalog).protocol).toBeUndefined();
        const shipped = { status: "loaded" as const, protocols: [definition("openai-image", "image")] };
        expect(serviceModelProfile(channel, { id: "gpt-image-3", modelType: "image" }, shipped).protocol).toBe("openai-image");
    });

    test("a fetched catalog model is kept unconfigured instead of given a retired template", () => {
        recordProtocolCatalog({ status: "loaded", protocols: [definition("openai-audio", "audio", true)] });
        const channel = createModelChannel({ id: "relay", baseUrl: "https://relay.example/v1", apiKey: "fakekey", models: [] });
        const profiles = mergeFetchedChannelModelProfiles(channel, [{ id: "speech-x", modelType: "audio" }]);
        expect(profiles).toEqual([expect.objectContaining({ model: "speech-x", capability: "audio", protocol: undefined, protocolPending: true })]);
    });
});

describe("the catalog loader feeds the same decision", () => {
    const originalAdapter = apiClient.defaults.adapter;
    afterEach(() => { apiClient.defaults.adapter = originalAdapter; });

    test("a loaded catalog is recorded with its retired protocols", async () => {
        apiClient.defaults.adapter = async (config) => ({ data: { code: 0, msg: "ok", data: { providers: [
            { id: "openai-image", version: "2.0.0", name: "OpenAI Images", vendor: "OpenAI", categories: ["image"], scopes: ["user.custom-channel"], create: "POST /v1/images/generations", enabled: true, retired: true },
            { id: "gemini-image", version: "1.0.0", name: "Gemini Images", vendor: "Google", categories: ["image"], scopes: ["user.custom-channel"], create: "POST /v1/images", enabled: true },
        ] } }, status: 200, statusText: "OK", headers: {}, config });
        const catalog = await loadProtocolCatalog("user.custom-channel");
        expect(catalog.status).toBe("loaded");
        expect(newModelProtocol("image").protocol).toBe("gemini-image");
    });

    test("a failed request yields an unavailable fallback that never assigns a protocol", async () => {
        recordProtocolCatalog({ status: "loaded", protocols: [definition("openai-image", "image", true)] });
        apiClient.defaults.adapter = async () => { throw new Error("offline"); };
        const catalog = await loadProtocolCatalog("user.custom-channel");
        expect(catalog.status).toBe("unavailable");
        // The hard-coded fallback list keeps manual setup possible, minus what is
        // already known to be retired, but proves nothing for automatic choices.
        expect(catalog.protocols.map((item) => item.value)).not.toContain("openai-image");
        expect(catalog.protocols.map((item) => item.value)).toContain("chat-completion");
        expect(newModelProtocol("text").protocol).toBeUndefined();
        expect(ensureModelProfilesWithUiDefaults(["gpt-4.1-mini"], undefined, [])[0]).toMatchObject({ protocol: undefined, protocolPending: true });
    });
});

describe("callers that rewrite profiles keep the saved decision", () => {
    test("the model-service wizard keeps a legacy profile's default and a pending mark", () => {
        // An OpenAI text profile without a protocol has always run with chat-completion;
        // the wizard's OpenAI preset would otherwise pick openai-response.
        const catalog = { status: "loaded" as const, protocols: [definition("chat-completion", "text"), definition("openai-response", "text"), definition("openai-audio", "audio")] };
        const legacy = createModelChannel({ id: "svc", baseUrl: "https://api.openai.com/v1", apiKey: "fakekey", models: ["gpt-4.1-mini"], modelProfiles: [{ model: "gpt-4.1-mini", capability: "text" }] });
        expect(serviceModelProfile(legacy, { id: "gpt-4.1-mini" }, catalog).protocol).toBe("chat-completion");
        const pending = createModelChannel({ id: "svc", baseUrl: "https://relay.example/v1", apiKey: "fakekey", models: ["speech-x"], modelProfiles: [{ model: "speech-x", capability: "audio", protocolPending: true }] });
        expect(serviceModelProfile(pending, { id: "speech-x" }, catalog)).toMatchObject({ protocol: undefined, protocolPending: true });
    });

    test("a wizard profile refused by the catalog stays pending all the way to the request", () => {
        const catalog = { status: "loaded" as const, protocols: [definition("openai-image", "image", true)] };
        const draft = createModelChannel({ id: "svc", baseUrl: "https://relay.example/v1", apiKey: "fakekey", models: [] });
        const profile = serviceModelProfile(draft, { id: "gpt-image-3", modelType: "image" }, catalog);
        expect(profile).toMatchObject({ protocol: undefined, protocolPending: true });
        const channel = createModelChannel({ ...draft, models: ["gpt-image-3"], modelProfiles: [profile] });
        expect(resolveModelRequestConfig({ ...defaultConfig, channels: [channel] }, "svc::gpt-image-3").interfaceType).toBeUndefined();
    });

    test("BeefAPI normalization does not fill a pending model back in", () => {
        recordProtocolCatalog({ status: "loaded", protocols: [definition("openai-audio", "audio", true)] });
        const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com", apiKey: "", models: ["minimax-speech-2.8-hd"], modelProfiles: [{ model: "minimax-speech-2.8-hd", capability: "audio", protocolPending: true }] });
        const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel] } }).config;
        expect(config.channels.find((item) => item.id === "beefapi")?.modelProfiles?.[0]).toMatchObject({ protocol: undefined, protocolPending: true });
        expect(resolveModelRequestConfig(config, "beefapi::minimax-speech-2.8-hd").interfaceType).toBeUndefined();
    });

    test("BeefAPI normalization keeps saved models running after their protocol is retired", () => {
        recordProtocolCatalog({ status: "loaded", protocols: [definition("openai-audio", "audio", true), definition("newapi", "video", true)] });
        const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com", apiKey: "", models: ["seedance-2.0", "custom-voice-speech", "minimax-music-v3.0"], modelProfiles: [
            { model: "seedance-2.0", capability: "video", protocol: "newapi" },
            // A legacy profile without the field has always run with openai-audio.
            { model: "custom-voice-speech", capability: "audio" },
        ] });
        const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel] } }).config;
        const beef = config.channels.find((item) => item.id === "beefapi");
        expect(beef?.modelProfiles?.find((item) => item.model === "seedance-2.0")).toMatchObject({ protocol: "newapi" });
        expect(beef?.modelProfiles?.some((item) => item.protocolPending)).toBe(false);
        expect(resolveModelRequestConfig(config, "beefapi::seedance-2.0").interfaceType).toBe("newapi");
        // Listed with or without a profile, both already run with the legacy default.
        expect(resolveModelRequestConfig(config, "beefapi::custom-voice-speech").interfaceType).toBe("openai-audio");
        expect(resolveModelRequestConfig(config, "beefapi::minimax-music-v3.0").interfaceType).toBe("openai-audio");
    });

    test("BeefAPI normalization still repairs saved profiles when nothing is retired", () => {
        const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com", apiKey: "", models: ["minimax-speech-2.8-hd"], modelProfiles: [{ model: "minimax-speech-2.8-hd", capability: "text", protocol: "chat-completion" }] });
        const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel] } }).config;
        expect(resolveModelRequestConfig(config, "beefapi::minimax-speech-2.8-hd").interfaceType).toBe("openai-audio");
    });

    test("the wizard keeps a channel protocol a saved model inherits", () => {
        // The model name says text, the channel says video: the saved decision wins.
        const channel = createModelChannel({ id: "svc", baseUrl: "https://video.example.com/v1", apiKey: "fakekey", interfaceType: "video-generations-json", models: ["model-123"] });
        const loaded = { status: "loaded" as const, protocols: [definition("video-generations-json", "video"), definition("chat-completion", "text")] };
        expect(serviceModelProfile(channel, { id: "model-123" }, loaded)).toMatchObject({ protocol: "video-generations-json", capability: "video" });
        // A failed catalog request proves nothing against the saved protocol.
        const claude = createModelChannel({ id: "svc", baseUrl: "https://api.example.com/v1", apiKey: "fakekey", apiFormat: "claude", interfaceType: "claude-api", models: ["claude-x"], modelProfiles: [{ model: "claude-x", capability: "text" }] });
        expect(serviceModelProfile(claude, { id: "claude-x" }, { status: "unavailable", protocols: [] })).toMatchObject({ protocol: "claude-api" });
    });

    test("a catalog refresh keeps a pending model pending and never refills a retired protocol", () => {
        recordProtocolCatalog({ status: "loaded", protocols: [definition("openai-audio", "audio", true)] });
        const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com", apiKey: "", models: [] });
        const catalogItems = [{ id: "speech-x", modelType: "audio" }];
        // Refresh through the settings pane, normalize, refresh again, normalize again.
        let current = channel;
        for (let round = 0; round < 2; round += 1) {
            current = applyFetchedChannelModelCatalog(current, { models: ["speech-x"], catalog: catalogItems });
            const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [current] } }).config;
            current = config.channels.find((item) => item.id === "beefapi")!;
            expect(current.modelProfiles?.find((item) => item.model === "speech-x")).toMatchObject({ protocol: undefined, protocolPending: true });
            expect(resolveModelRequestConfig(config, "beefapi::speech-x").interfaceType).toBeUndefined();
        }
        // Once the host offers the protocol again, the provider's declared one is adopted.
        recordProtocolCatalog({ status: "loaded", protocols: [definition("openai-audio", "audio")] });
        const adopted = mergeFetchedChannelModelProfiles(current, catalogItems).find((item) => item.model === "speech-x");
        expect(adopted?.protocol).toBe("openai-audio");
        expect(adopted?.protocolPending).toBeUndefined();
    });

    test("a declared protocol is not auto-assigned when the catalog request failed", () => {
        recordProtocolCatalog({ status: "unavailable", protocols: [] });
        const channel = createModelChannel({ id: "relay", baseUrl: "https://relay.example/v1", apiKey: "fakekey", models: [] });
        expect(mergeFetchedChannelModelProfiles(channel, [{ id: "speech-x", modelType: "audio" }])).toEqual([expect.objectContaining({ protocol: undefined, protocolPending: true })]);
    });

    test("a newly fetched model does not inherit a retired channel protocol", () => {
        recordProtocolCatalog({ status: "loaded", protocols: [definition("openai-image", "image", true)] });
        const channel = createModelChannel({ id: "relay", baseUrl: "https://relay.example/v1", apiKey: "fakekey", interfaceType: "openai-image", models: [] });
        expect(mergeFetchedChannelModelProfiles(channel, [{ id: "image-x", modelType: "image" }])).toEqual([expect.objectContaining({ model: "image-x", protocol: undefined, protocolPending: true })]);
        // A channel protocol the host still offers is inherited as before.
        recordProtocolCatalog({ status: "loaded", protocols: [definition("openai-image", "image")] });
        expect(mergeFetchedChannelModelProfiles(channel, [{ id: "image-x", modelType: "image" }])[0]?.protocol).toBe("openai-image");
    });
});
