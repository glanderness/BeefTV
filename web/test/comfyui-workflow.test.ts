import { expect, test } from "bun:test";
import { comfyUICapabilityConfig, defaultComfyUIFields, parseComfyUIWorkflow } from "../src/lib/comfyui-workflow";
import { modelCatalogRequestURL, serviceConnectionError, serviceModelProfile, servicePresetFor } from "../src/lib/model-service-presets";
import { backendProviderConfig } from "../src/services/api/generation-task";
import { testChannelModelConnection } from "../src/lib/model-connection-test";
import { channelHasGenerationCredential, configWithoutCachedSecrets, createModelChannel, defaultConfig, normalizeConfigSnapshot, type WorkflowFieldMapping } from "../src/stores/use-config-store";
import type { ModelProtocolDefinition } from "../src/lib/model-protocols";

const workflowJson = {
    "1": { class_type: "CLIPTextEncode", inputs: { text: "positive" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "negative" } },
    "3": { class_type: "KSampler", inputs: { positive: ["1", 0], negative: ["2", 0], seed: 1, steps: 20 } },
};

test("ComfyUI import accepts API JSON and prompt envelopes, rejecting UI JSON and broken links", () => {
    expect(parseComfyUIWorkflow(JSON.stringify(workflowJson))).toEqual(workflowJson);
    expect(parseComfyUIWorkflow(JSON.stringify({ prompt: workflowJson, client_id: "ignored" }))).toEqual(workflowJson);
    for (const text of ["broken", "{}", '{"nodes":[],"links":[]}', '{"1":{"class_type":"SaveImage","inputs":{"images":["missing",0]}}}', '{"1":{"class_type":"SaveImage","inputs":{"images":["1",-1]}}}']) {
        expect(() => parseComfyUIWorkflow(text)).toThrow();
    }
});

test("offline field defaults preserve positive/negative text and exclude graph connections", () => {
    const fields = defaultComfyUIFields(workflowJson);
    expect(fields.filter((field) => field.source === "prompt")).toHaveLength(0);
    expect(fields.some((field) => field.fieldName === "positive" || field.fieldName === "negative")).toBe(false);
    expect(fields.find((field) => field.fieldName === "steps")).toMatchObject({ fieldValue: 20, fieldType: "INT" });
});

test("ComfyUI uses optional credentials and native capability protocols", () => {
    const channel = createModelChannel({ id: "comfy", provider: "comfyui", baseUrl: "http://127.0.0.1:8188" });
    expect(servicePresetFor(channel)).toBe("comfyui");
    expect(serviceConnectionError(channel)).toBe("");
    expect(channelHasGenerationCredential(channel)).toBe(true);
    expect(modelCatalogRequestURL(channel)).toBe("");
    const protocols = ["image", "video", "audio"].map((capability) => ({ value: `comfyui-${capability}`, capability, enabled: true } as ModelProtocolDefinition));
    for (const capability of ["image", "video", "audio"] as const) expect(serviceModelProfile(channel, { id: "workflow" }, protocols, capability).protocol).toBe(`comfyui-${capability}`);
    expect(serviceModelProfile(channel, { id: "workflow" }, protocols, "text").protocol).toBeUndefined();
    expect(serviceConnectionError({ ...channel, provider: undefined })).toContain("API Key");
});

test("keyless ComfyUI and Ollama keep their independent generation credentials", () => {
    const channel = createModelChannel({
        baseUrl: "http://127.0.0.1:11434", models: ["llama3", "gpt"],
        modelProfiles: [
            { model: "llama3", capability: "text", protocol: "ollama-chat", authType: "none" },
            { model: "gpt", capability: "text", protocol: "chat-completion", authType: "bearer" },
        ],
    });
    expect(channelHasGenerationCredential(channel, "llama3")).toBe(true);
    expect(channelHasGenerationCredential(channel, "gpt")).toBe(false);
    expect(serviceConnectionError(channel)).toContain("API Key");
    expect(serviceConnectionError({ ...channel, models: ["llama3"] })).toBe("");
    expect(serviceConnectionError(channel, { requireCredential: false })).toBe("");
    expect(channelHasGenerationCredential(comfyUIChannel(), "workflow")).toBe(true);
});

test("ComfyUI capability limits follow mapped reference slots", () => {
    const fields: WorkflowFieldMapping[] = [
        { nodeId: "8", fieldName: "image", source: "referenceImage", imageOrder: 2, enabled: true },
        { nodeId: "9", fieldName: "audio", source: "referenceAudio", sourceIndex: 0, enabled: true },
        { nodeId: "10", fieldName: "video", source: "referenceVideo", enabled: false },
    ];
    expect(comfyUICapabilityConfig("image", fields)?.image?.references.maxImages).toBe(2);
    expect(comfyUICapabilityConfig("video", fields)?.video?.references).toMatchObject({ maxImages: 2, maxAudios: 1, maxVideos: 0 });
});

function comfyUIChannel() {
    return createModelChannel({ id: "comfy", provider: "comfyui", baseUrl: "http://127.0.0.1:8188", models: ["workflow"], modelProfiles: [{
        model: "workflow", protocol: "comfyui-image", capability: "image", comfyui: { workflowJson, fields: [{ nodeId: "1", fieldName: "text", source: "prompt" }] },
    }] });
}

test("saved ComfyUI workflows survive normalization and become durable generation config", () => {
    const channel = comfyUIChannel();
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], model: "comfy::workflow" } }).config;
    expect(config.channels[0].provider).toBe("comfyui");
    expect(backendProviderConfig(config)).toMatchObject({ channelId: "", interfaceType: "comfyui-image", apiKey: "", workflowJson, workflowFields: channel.modelProfiles![0].comfyui!.fields });
    expect(() => backendProviderConfig(config, "video")).toThrow("用途");
    config.channels[0].modelProfiles![0].comfyui = undefined;
    expect(() => backendProviderConfig(config)).toThrow("导入");
});

test("keyless ComfyUI generation test submits the selected workflow and requires a media result", async () => {
    const channel = comfyUIChannel();
    const detail = await testChannelModelConnection(channel, "workflow", "image", "comfyui-image", async (options) => {
        expect(backendProviderConfig(options.config)).toMatchObject({ interfaceType: "comfyui-image", workflowJson });
        return { images: [{ dataUrl: "data:image/png;base64,AAAA", storageKey: "resource:synthetic-result" }] };
    });
    expect(detail).toContain("图片");
});

test("browser preferences omit large workflow JSON while canonical config keeps it", () => {
    const config = { ...defaultConfig, channels: [comfyUIChannel()] };
    const cached = configWithoutCachedSecrets(config);
    expect(cached.channels[0].modelProfiles![0].comfyui).toBeUndefined();
    expect(config.channels[0].modelProfiles![0].comfyui?.workflowJson).toEqual(workflowJson);
});
