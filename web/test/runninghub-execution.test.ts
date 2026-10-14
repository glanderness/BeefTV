import { afterEach, expect, spyOn, test } from "bun:test";
import { isRunningHubReady, resolveGenerationWorkflowExecution } from "@/lib/generation-workflow-execution";
import { RUNNINGHUB_PLUGIN_ID } from "@/lib/plugins/builtin/workflows";
import { configWithoutCachedSecrets, createModelChannel, defaultConfig, encodeChannelModel, mergeWorkflowFieldMappings, normalizeConfigSnapshot, type RunningHubConfig, type WorkflowFieldMapping } from "@/stores/use-config-store";
import { usePluginStore } from "@/stores/use-plugin-store";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { http } from "@/services/api/request";

const runningHub: RunningHubConfig = {
    ...defaultConfig.runningHub,
    enabled: true,
    apiKey: "test-key",
    workflowId: "shared-id",
    selectedKind: "app",
    workflows: [
        { kind: "workflow", workflowId: "shared-id", title: "Workflow", capability: "video" },
        { kind: "app", workflowId: "shared-id", webappId: "app-id", title: "App", capability: "image" },
    ],
};
const statuses = { [RUNNINGHUB_PLUGIN_ID]: "enabled" };
afterEach(() => usePluginStore.getState().setRuntimeStatuses({}));

test("readiness requires backend activation, credentials and a saved entry of the selected kind", () => {
    expect(isRunningHubReady(runningHub, statuses)).toBe(true);
    expect(isRunningHubReady(runningHub, {})).toBe(false);
    expect(isRunningHubReady({ ...runningHub, apiKey: "" }, statuses)).toBe(false);
    expect(isRunningHubReady({ ...runningHub, workflows: [runningHub.workflows[0]] }, statuses)).toBe(false);
});

test("RunningHub task preserves an empty prompt without inventing placeholder text", async () => {
    usePluginStore.getState().setRuntimeStatuses(statuses);
    const payload = await prepareBackendGenerationTask({ mode: "video", prompt: "", config: {
        ...defaultConfig, taskWorkflowProvider: "runninghub", runningHub: { ...runningHub, selectedKind: "workflow", capability: "video" },
    } });
    expect(payload.prompt).toBe("");
    expect(payload.input.prompt).toBe("");
    expect(payload.provider).toBe("runninghub");
});

test("browser cache preserves the workflow but excludes every RunningHub credential", () => {
    const cached = configWithoutCachedSecrets({ ...defaultConfig, runningHub: { ...runningHub, walletApiKey: "wallet-test", uploadApiKey: "upload-test" } });
    expect(cached.runningHub.apiKey).toBe("");
    expect(cached.runningHub.walletApiKey).toBe("");
    expect(cached.runningHub.uploadApiKey).toBe("");
    expect(cached.runningHub.workflows).toEqual(runningHub.workflows);
});

test("canvas selects App rather than Workflow with the same id, and checks capability", () => {
    usePluginStore.getState().setRuntimeStatuses(statuses);
    const config = { ...defaultConfig, taskWorkflowProvider: "runninghub" as const, runningHub };
    const execution = resolveGenerationWorkflowExecution(config, "image");
    expect(execution?.kind).toBe("app");
    expect(execution?.webappId).toBe("app-id");
    expect(execution?.interfaceType).toBe("runninghub-workflow-image");
    expect(() => resolveGenerationWorkflowExecution(config, "video")).toThrow("用途为图片");
    expect(resolveGenerationWorkflowExecution(config, "text")).toBeNull();
    usePluginStore.getState().setRuntimeStatuses({});
    expect(() => resolveGenerationWorkflowExecution(config, "image")).toThrow("插件未启用");
});

test("RunningHub task keeps owned references and shares its workflow key without the hidden upload key", async () => {
    usePluginStore.getState().setRuntimeStatuses(statuses);
    const config = { ...defaultConfig, taskWorkflowProvider: "runninghub" as const, runningHub: { ...runningHub, uploadApiKey: "unused-enterprise-key" } };
    const input = await prepareBackendGenerationTask({
        mode: "image", prompt: "test", config,
        referenceImages: [{ id: "image-test", name: "test.png", type: "image/png", dataUrl: "blob:must-not-be-fetched", storageKey: "resource:owned-image" }],
    });
    expect(input.provider).toBe("runninghub");
    expect((input.input.config as Record<string, unknown>).interfaceType).toBe("runninghub-workflow-image");
    expect((input.input.config as Record<string, unknown>).apiKey).toBe("test-key");
    expect((input.input.config as Record<string, unknown>).runningHubUploadApiKey).toBeUndefined();
    expect(input.input.referenceImages).toEqual([{ id: "image-test", name: "test.png", type: "image/png", dataUrl: "", url: undefined, storageKey: "resource:owned-image" }]);
});

test("video task payload preserves picture order even when H3 mentions picture 2 first", async () => {
    usePluginStore.getState().setRuntimeStatuses(statuses);
    const prompt = "subject_definitions:\n<Subject 1> is the person in <Picture 2>.\n<Subject 2> is the person in <Picture 1>.";
    const videoConfig = { ...runningHub, selectedKind: "workflow" as const, capability: "video" as const };
    const input = await prepareBackendGenerationTask({
        mode: "video", prompt, config: { ...defaultConfig, taskWorkflowProvider: "runninghub", runningHub: videoConfig },
        referenceImages: [
            { id: "uploaded-photo", name: "photo.png", type: "image/png", dataUrl: "", storageKey: "resource:photo" },
            { id: "generated-image", name: "generated.png", type: "image/png", dataUrl: "", storageKey: "resource:generated" },
        ],
    });
    expect(input.prompt).toBe(prompt);
    expect(input.input.prompt).toBe(prompt);
    expect(input.input.referenceImages.map(({ id, storageKey }) => [id, storageKey])).toEqual([
        ["uploaded-photo", "resource:photo"], ["generated-image", "resource:generated"],
    ]);
});

test("RunningHub test file is first saved as an owned resource rather than embedded in the task", async () => {
    usePluginStore.getState().setRuntimeStatuses(statuses);
    const post = spyOn(http, "post").mockImplementation(async (path, body) => {
        expect(path).toBe("/resources");
        expect(body).toBeInstanceOf(FormData);
        expect((body as FormData).get("file")).toBeInstanceOf(Blob);
        return { resource: { id: "rh-probe-owned", mimeType: "image/png", status: "ready" } } as never;
    });
    try {
        const task = await prepareBackendGenerationTask({
            mode: "image", prompt: "test", config: { ...defaultConfig, taskWorkflowProvider: "runninghub", runningHub },
            referenceImages: [{ id: "ref-local", name: "local.png", type: "image/png", dataUrl: "data:image/png;base64,YQ==" }],
        });
        expect(post).toHaveBeenCalledTimes(1);
        expect((task.input.referenceImages as Array<{ storageKey: string; dataUrl: string }>)[0]).toMatchObject({ storageKey: "resource:rh-probe-owned", dataUrl: "" });
    } finally {
        post.mockRestore();
    }
});

test("workflow preparation ignores stale portrait and Ark models and their protocol defaults", async () => {
    usePluginStore.getState().setRuntimeStatuses(statuses);
    const channel = createModelChannel({ id: "old-ark", name: "旧方舟", baseUrl: "https://ark.example.com", apiKey: "test", interfaceType: "volcengine-ark-video", models: ["seedance-2.0-portrait"], modelProfiles: [{ model: "seedance-2.0-portrait", capability: "video", protocol: "volcengine-ark-video", billingMode: "fixed_request", unitPriceMicrocredits: 1, defaultOptions: { staleSetting: true } }] });
    const config = { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "seedance-2.0-portrait"), taskWorkflowProvider: "runninghub" as const,
        runningHub: { ...runningHub, selectedKind: "workflow" as const, capability: "video" as const } };
    const task = await prepareBackendGenerationTask({
        mode: "video", prompt: "工作流提示词", config, metadata: { nodeId: "workflow-node" },
        referenceImages: [{ id: "photo", name: "photo.png", type: "image/png", dataUrl: "", storageKey: "resource:owned-photo", arkAssetId: "stale-ark-asset" }],
    });
    expect(task.provider).toBe("runninghub");
    expect(task.input.referenceImages[0].storageKey).toBe("resource:owned-photo");
    expect(task.input.referenceImages[0].url).toBeUndefined();
    expect(task.input.metadata).toMatchObject({ nodeId: "workflow-node" });
    expect(task.input.metadata.providerOptions).toBeUndefined();
});

test("workflow reload preserves media metadata, slot bindings and explicit field switches", () => {
    const fields: WorkflowFieldMapping[] = [
        { nodeId: "6", classType: "LoadImage", fieldName: "image", fieldType: "IMAGE", role: "media", source: "referenceImage", imageOrder: 2, sourceIndex: 1, required: false, enabled: true },
        { nodeId: "10", classType: "CLIPTextEncode", fieldName: "text", fieldType: "TEXT", role: "prompt", source: "prompt", required: true, enabled: true },
        { nodeId: "35", classType: "LoadImage", fieldName: "image", fieldType: "IMAGE", role: "media", source: "referenceImage", imageOrder: 1, sourceIndex: 0, enabled: false },
        { nodeId: "40", classType: "CustomNode", fieldName: "strength", fieldType: "NUMBER", role: "internal", source: "", enabled: true },
    ];
    let config = { ...defaultConfig, runningHub: { ...runningHub, workflows: [{ kind: "workflow" as const, workflowId: "reload-probe", capability: "image" as const, fields, workflowJson: {
        "6": { class_type: "LoadImage", inputs: { image: "example.png" } },
        "10": { class_type: "CLIPTextEncode", inputs: { text: "example" } },
        "35": { class_type: "LoadImage", inputs: { image: "second.png" } },
        "40": { class_type: "CustomNode", inputs: { strength: 0.5 } },
        "50": { class_type: "Sampler", inputs: { steps: 10, internal_value: 1 } },
    } }] } };
    for (let reload = 0; reload < 3; reload += 1) {
        config = normalizeConfigSnapshot(JSON.parse(JSON.stringify({ config }))).config as typeof config;
        const restored = config.runningHub.workflows[0].fields;
        expect(restored.find((field) => field.nodeId === "6")).toMatchObject({ fieldType: "IMAGE", role: "media", source: "referenceImage", imageOrder: 2, sourceIndex: 1, required: false, enabled: true });
        expect(restored.find((field) => field.nodeId === "10")).toMatchObject({ role: "prompt", source: "prompt", enabled: true, required: true });
        expect(restored.find((field) => field.nodeId === "35")).toMatchObject({ fieldType: "IMAGE", role: "media", enabled: false });
        expect(restored.find((field) => field.nodeId === "40")).toMatchObject({ role: "internal", enabled: true });
        expect(restored.find((field) => field.fieldName === "steps")).toMatchObject({ enabled: true });
        expect(restored.find((field) => field.fieldName === "internal_value")).toMatchObject({ enabled: false });
    }
});

test("re-fetch keeps existing switches even when classification changes and defaults only new fields", () => {
    const current = [
        { nodeId: "1", fieldName: "strength", role: "business", enabled: true },
        { nodeId: "2", fieldName: "steps", role: "business", enabled: false },
    ];
    const incoming = [
        { nodeId: "1", classType: "CustomNode", fieldName: "strength", role: "internal", enabled: false },
        { nodeId: "2", classType: "Sampler", fieldName: "steps", role: "business", enabled: true },
        { nodeId: "3", classType: "CustomNode", fieldName: "hidden", role: "internal", enabled: false },
    ];
    expect(mergeWorkflowFieldMappings(current, incoming).map((field) => field.enabled)).toEqual([true, false, false]);
});

test("unsafe numeric fields remain blocked when saved switches or field types request enabling", () => {
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, runningHub: { ...runningHub, workflows: [{ workflowId: "unsafe-probe", capability: "image", fields: [
        { nodeId: "1", classType: "Int", fieldName: "value", fieldType: "NUMBER", role: "business", enabled: true },
        { nodeId: "2", classType: "ImageResize+", fieldName: "width", fieldType: "NUMBER", role: "business", enabled: true },
    ], workflowJson: {
        "1": { class_type: "Int", inputs: { value: 20 } },
        "2": { class_type: "ImageResize+", inputs: { width: 512 } },
    } }] } } }).config;
    expect(config.runningHub.workflows[0].fields?.every((field) => field.enabled === false && field.safeToOverride === false)).toBe(true);
});
