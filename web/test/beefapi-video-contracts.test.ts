import { expect, test } from "bun:test";
import { beefAPIVideoContract, isBeefAPIEndpoint } from "../src/lib/beefapi-video-contracts";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, resolveModelRequestConfig } from "../src/stores/use-config-store";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { createVideoGenerationsTask } from "../src/services/api/video-provider-newapi";
import { createVideoTransport } from "../src/services/api/video-transport";
import { videoResponseTools } from "../src/services/api/video-response";

test("Wan uses shared protocol and supported reference limits across reloads", () => {
    const model = "wan3.0-video";
    const channel = createModelChannel({id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{model, capability: "video", protocol: "openai-videos"}]});
    let config = {...defaultConfig, channels: [channel]};
    for (let i = 0; i < 2; i++) {
        config = normalizeConfigSnapshot({config}).config;
        expect(resolveModelRequestConfig(config, `beefapi::${model}`).interfaceType).toBe("newapi-channel-2");
        const refs = modelCapabilityConfigFor(config, `beefapi::${model}`).video!.references;
        expect([refs.maxImages, refs.maxVideos, refs.maxAudios]).toEqual([1, 0, 0]);
    }
});

test("new models preserve their catalog protocol without inheriting unverified inline support", () => {
    const model = "future-video";
    const channel = createModelChannel({id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{model, capability: "video", protocol: "minimax-video"}]});
    const config = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel]}}).config;
    expect(resolveModelRequestConfig(config, `beefapi::${model}`).interfaceType).toBe("minimax-video");
    expect(beefAPIVideoContract(model)).toBeUndefined();
    expect(beefAPIVideoContract("wan3.0-video-prime")).toBeUndefined();
});

test("media contract overrides require the exact enterprise HTTPS endpoint", () => {
    for (const base of ["https://enterprise.beefapi.com.evil.test", "https://evil.test/enterprise.beefapi.com", "http://enterprise.beefapi.com", "https://user@enterprise.beefapi.com", "https://enterprise.beefapi.com:444"]) expect(isBeefAPIEndpoint(base)).toBe(false);
    expect(isBeefAPIEndpoint("https://enterprise.beefapi.com/v1")).toBe(true);
});

test("partial reference contracts preserve the limits of unspecified media kinds", () => {
    const model = "wan3.0-video";
    const contract = beefAPIVideoContract(model)!;
    const original = contract.maxReferences;
    try {
        contract.maxReferences = {image: 1};
        const capabilityConfig = defaultModelCapabilityConfig("newapi-channel-2", model);
        Object.assign(capabilityConfig.video!.references, {maxImages: 4, maxVideos: 2, maxAudios: 1});
        const channel = createModelChannel({id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{model, capability: "video", protocol: "newapi-channel-2", capabilityConfig}]});
        const config = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel]}}).config;
        const refs = modelCapabilityConfigFor(config, `beefapi::${model}`).video!.references;
        expect([refs.maxImages, refs.maxVideos, refs.maxAudios]).toEqual([1, 2, 1]);
    } finally { contract.maxReferences = original; }
});

test("direct video transport sends Wan inline media and rejects unsupported references before sending", async () => {
    const model = "wan3.0-video";
    const channel = createModelChannel({id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model]});
    const snapshot = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel]}}).config;
    const config = resolveModelRequestConfig(snapshot, `beefapi::${model}`);
    const calls: unknown[] = [];
    const deps = {response: videoResponseTools, transport: {...createVideoTransport(config), post: async <T>(url: string, body: unknown) => { calls.push({url, body}); return {id: "test-wan", status: "queued"} as T; }}};
    const image = {id: "image-1", name: "test.png", type: "image/png", dataUrl: "data:image/png;base64,dGVzdA=="};
    const task = await createVideoGenerationsTask(deps, config, model, "test", [image], [], []);
    expect(task.id).toBe("test-wan");
    expect(calls[0]).toMatchObject({body: {image_urls: [image.dataUrl]}});
    await expect(createVideoGenerationsTask(deps, config, model, "test", [image, image], [], [])).rejects.toThrow("最多支持 1");
    expect(calls).toHaveLength(1);
    await expect(createVideoGenerationsTask(deps, {...config, baseUrl: "https://other.example"}, model, "test", [image], [], [])).rejects.toThrow("公网 URL");
    expect(calls).toHaveLength(1);
    await createVideoGenerationsTask(deps, {...config, baseUrl: "https://other.example"}, model, "test", [{...image, url: "https://media.example/image.png"}], [], []);
    expect(calls[1]).toMatchObject({body: {image_urls: ["https://media.example/image.png"]}});
});
