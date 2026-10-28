import { describe, expect, test } from "bun:test";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { serviceConnectionError, serviceModelProfile } from "../src/lib/model-service-presets";
import type { ModelProtocolDefinition } from "../src/lib/model-protocols";
import { createModelChannel } from "../src/stores/use-config-store";
import { canShareChannel, channelShareFileName, parseSharedChannel, prepareImportedChannel, serializeChannel } from "../src/pages/settings/channel-share";

const protocols = [
    { value: "chat-completion", capability: "text", enabled: true, authType: "bearer" },
    { value: "newapi", capability: "video", enabled: true, authType: "bearer" },
    { value: "openai-image", capability: "image", enabled: true, authType: "bearer" },
] as ModelProtocolDefinition[];
const channel = createModelChannel({
    id: "my-new-api", name: "My New API", baseUrl: "https://models.example.com/v1", apiKey: "private-key", secretKey: "private-secret",
    hasApiKey: true, hasSecretKey: true, credentialRef: "private-ref", headers: [{ name: "Authorization", value: "private-header" }],
    models: ["chat-model"], modelProfiles: [{ model: "chat-model", capability: "text", protocol: "chat-completion", displayName: "Chat", authType: "bearer" }],
});
const envelope = (patch: Record<string, unknown> = {}) => JSON.stringify({ type: "beeftv.channel", version: 1, channel: { ...channel, ...patch } });

describe("single channel sharing", () => {
    test("export uses a whitelist and import discards untrusted credentials and UI flags", () => {
        const json = serializeChannel(channel);
        const exported = JSON.parse(json);
        expect(exported).toMatchObject({ type: "beeftv.channel", version: 1, channel: { id: channel.id, modelProfiles: [{ model: "chat-model", protocol: "chat-completion", displayName: "Chat" }] } });
        for (const field of ["apiKey", "secretKey", "hasApiKey", "hasSecretKey", "credentialRef", "headers", "authType"]) expect(json).not.toContain(`"${field}"`);
        expect(json).not.toContain("private-");
        const draft = prepareImportedChannel(parseSharedChannel(envelope({ pinned: true, scope: "system", enabled: false }), protocols), []);
        expect(draft).toMatchObject({ id: channel.id, apiKey: "", secretKey: "", headers: [], scope: "user", enabled: true, pinned: false });
        expect(draft.hasApiKey).toBeUndefined();
        expect(draft.hasSecretKey).toBeUndefined();
        expect(draft.credentialRef).toBeUndefined();
    });

    test("same ID replaces configuration, keeps credentials and local UI state, and does not mutate the source", () => {
        const local = { ...channel, enabled: false, pinned: true, sortOrder: 5, concurrencyLimit: 3 };
        const next = prepareImportedChannel(parseSharedChannel(envelope({ baseUrl: "https://updated.example.com/v1", models: ["updated"], modelProfiles: [{ model: "updated", capability: "text", protocol: "chat-completion" }], apiKey: "injected", headers: [] }), protocols), [local]);
        expect(next).toMatchObject({ id: local.id, models: ["updated"], baseUrl: "https://updated.example.com/v1", apiKey: local.apiKey, secretKey: local.secretKey, hasApiKey: true, hasSecretKey: true, credentialRef: local.credentialRef, headers: local.headers, enabled: false, pinned: true, sortOrder: 5, concurrencyLimit: 3 });
        expect(local.models).toEqual(["chat-model"]);
        expect(serviceConnectionError(next, { protocols })).toBe("");
        expect(serviceModelProfile(next, { id: "updated" }, protocols).protocol).toBe("chat-completion");
    });

    test("redacted stored credentials remain valid without entering keys again", () => {
        const local = { ...channel, apiKey: "", secretKey: "", hasApiKey: true, hasSecretKey: true };
        const next = prepareImportedChannel(parseSharedChannel(serializeChannel(channel), protocols), [local]);
        expect(next).toMatchObject({ apiKey: "", secretKey: "", hasApiKey: true, hasSecretKey: true, headers: local.headers });
        expect(serviceConnectionError(next, { protocols })).toBe("");
    });

    test.each(["text", "image", "video"] as const)("%s capabilities survive a round trip with nested secrets removed", (capability) => {
        const protocol = { text: "chat-completion", image: "openai-image", video: "newapi" }[capability];
        const config = defaultModelCapabilityConfig(protocol, "model");
        const raw = { ...config, apiKey: "nested-secret", headers: [{ value: "nested-header" }], video: config.video ? { ...config.video, headers: ["secret"] } : undefined };
        const configured = createModelChannel({ ...channel, models: ["model"], modelProfiles: [{ model: "model", capability, protocol, capabilityConfig: raw }] });
        const json = serializeChannel(configured);
        expect(json).not.toContain("secret");
        expect(json).not.toContain("headers");
        expect(parseSharedChannel(json, protocols).modelProfiles?.[0].capabilityConfig).toEqual(config);
    });

    test("rejects invalid envelopes, raw field types and URLs before defaults can hide errors", () => {
        for (const json of ["{", "null", "[]", JSON.stringify({ type: "other", version: 1, channel }), JSON.stringify({ type: "beeftv.channel", version: 2, channel })]) expect(() => parseSharedChannel(json, protocols)).toThrow();
        for (const patch of [{ id: "" }, { baseUrl: "" }, { baseUrl: "https://example.com/v1?key=secret" }, { baseUrl: "https://user:pass@example.com" }, { referenceAssetOrigin: "https://assets.example.com/path" }, { apiFormat: "invalid" }, { apiFormat: ["openai"] }, { models: "chat-model" }, { models: [null] }, { models: ["same", "same"] }, { models: ["other::model"] }, { modelProfiles: {} }]) expect(() => parseSharedChannel(envelope(patch), protocols)).toThrow();
    });

    test("rejects unavailable, disabled, mismatched and duplicate model protocols", () => {
        for (const patch of [
            { interfaceType: "unknown" },
            { modelProfiles: [{ model: "chat-model", capability: "text", protocol: "unknown" }] },
            { modelProfiles: [{ model: "chat-model", capability: "video", protocol: "chat-completion" }] },
            { modelProfiles: [{ model: "absent", capability: "text", protocol: "chat-completion" }] },
            { modelProfiles: [channel.modelProfiles![0], channel.modelProfiles![0]] },
            { modelProfiles: [{ ...channel.modelProfiles![0], capabilityConfig: { version: 1, text: { references: [] } } }] },
        ]) expect(() => parseSharedChannel(envelope(patch), protocols)).toThrow();
        expect(() => parseSharedChannel(envelope(), [{ ...protocols[0], enabled: false }])).toThrow("当前环境没有可用的请求协议");
    });

    test("special channels cannot be exported, imported or overwritten by ID", () => {
        for (const special of [{ ...channel, id: "beefapi", pinned: true }, { ...channel, id: "fal-topaz-upscale" }, { ...channel, models: ["topaz/upscale/image"] }, { ...channel, scope: "system" as const }]) {
            expect(canShareChannel(special)).toBe(false);
            expect(() => serializeChannel(special)).toThrow();
            const shared = parseSharedChannel(envelope(), protocols);
            expect(() => prepareImportedChannel({ ...shared, id: special.id }, [special])).toThrow();
        }
        expect(() => parseSharedChannel(envelope({ id: "beefapi" }), protocols)).toThrow();
        expect(() => parseSharedChannel(envelope({ id: "fal-topaz-upscale" }), protocols)).toThrow();
        expect(() => parseSharedChannel(envelope({ models: ["topaz/upscale/image"], modelProfiles: [] }), protocols)).toThrow();
    });

    test("unfinished profiles can be completed in the editor and file names stay portable", () => {
        expect(parseSharedChannel(envelope({ modelProfiles: [{ model: "chat-model", capability: "text" }] }), protocols).modelProfiles?.[0].protocol).toBeUndefined();
        expect(parseSharedChannel(`\uFEFF${envelope({ modelProfiles: undefined })}`, protocols).id).toBe(channel.id);
        expect(channelShareFileName({ name: 'New/API: "Test"' })).toBe("New_API_ _Test_.beeftv-channel.json");
    });
});
