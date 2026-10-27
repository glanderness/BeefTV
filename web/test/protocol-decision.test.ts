import { afterEach, describe, expect, test } from "bun:test";

import cases from "../../backend/internal/providerpreset/testdata/saved_protocol_cases.json";
import { ensureModelProfilesWithUiDefaults, newModelProtocol, recordProtocolCatalog, savedModelProtocol, type ModelProtocolDefinition, type ProtocolCapability } from "@/lib/model-protocols";
import { serviceModelProfile } from "@/lib/model-service-presets";
import { mergeFetchedChannelModelProfiles } from "@/lib/channel-model-catalog";
import { createModelChannel, defaultConfig, resolveModelRequestConfig } from "@/stores/use-config-store";

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
