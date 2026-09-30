import { beforeEach, expect, mock, test } from "bun:test";

let text = "OK";
let audio = new Blob(["audio"]);
let taskId = "task-1";
let received: Record<string, unknown> = {};
mock.module("@/services/api/image", () => ({
    requestToolResponse: async () => ({ content: text }),
    requestGeneration: async () => [{ dataUrl: "https://example.invalid/image.png" }],
}));
mock.module("@/services/api/audio", () => ({ requestAudioGeneration: async () => audio }));
mock.module("@/services/api/video", () => ({ createVideoGenerationTask: async (config: Record<string, unknown>) => { received = config; return { id: taskId }; } }));

const { testChannelModelConnection } = await import("@/lib/model-connection-test");
const { createModelChannel } = await import("@/stores/use-config-store");
const { defaultModelCapabilityConfig } = await import("@/lib/model-capabilities");
const channel = createModelChannel({ id: "test", apiKey: "fake", baseUrl: "https://example.invalid", models: ["test-model"] });
beforeEach(() => { text = "OK"; audio = new Blob(["audio"]); taskId = "task-1"; });

test("text proves content and rejects empty responses", async () => {
    expect(await testChannelModelConnection(channel, "test-model", "text", "chat-completion")).toMatchObject({ stage: "response", canvasWritebackVerified: false });
    text = " ";
    await expect(testChannelModelConnection(channel, "test-model", "text", "chat-completion")).rejects.toThrow("有效内容");
});
test("image URLs do not prove download or canvas writeback", async () => {
    const result = await testChannelModelConnection(channel, "test-model", "image", "openai-image");
    expect(result.stage).toBe("response");
    expect(result.detail).toContain("未验证图片下载与画布回填");
});
test("audio requires a nonempty downloaded file", async () => {
    expect((await testChannelModelConnection(channel, "test-model", "audio", "openai-audio")).stage).toBe("downloaded");
    audio = new Blob([]);
    await expect(testChannelModelConnection(channel, "test-model", "audio", "openai-audio")).rejects.toThrow("空文件");
});
test("video submission uses profile defaults and does not claim completion", async () => {
    const capabilityConfig = defaultModelCapabilityConfig("openai-videos", "test-model");
    capabilityConfig.video!.duration.default = 8;
    capabilityConfig.video!.defaultRatio = "9:16";
    capabilityConfig.video!.defaultResolution = "1080";
    const configured = { ...channel, modelProfiles: [{ model: "test-model", capability: "video" as const, protocol: "openai-videos", capabilityConfig }] };
    const result = await testChannelModelConnection(configured, "test-model", "video", "openai-videos");
    expect(result.stage).toBe("submitted");
    expect(result.detail).toContain("未验证生成完成、下载与画布回填");
    expect(received).toMatchObject({ videoSeconds: "8", size: "9:16", vquality: "1080" });
    taskId = "";
    await expect(testChannelModelConnection(configured, "test-model", "video", "openai-videos")).rejects.toThrow("任务 ID");
});
