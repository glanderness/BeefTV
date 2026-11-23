import { expect, test } from "bun:test";

import { defaultVideoCapabilityConfig } from "../src/lib/model-capabilities-video";
import { executeCreateSubmit } from "../src/pages/create/create-submit-task";
import type { CreationConversation, CreationMessage } from "../src/pages/create/creation-types";
import type { GenerationTask } from "../src/services/api/task-center";

test("executeCreateSubmit accepts resource-backed video results without dataUrl", async () => {
    let conversation: CreationConversation = {
        id: "conv-video-stream",
        title: "视频创作",
        updatedAt: "2026-11-23T00:00:00.000Z",
        messages: [],
    };
    const errors: string[] = [];
    const consumedTasks: GenerationTask[] = [];

    await executeCreateSubmit({
        promptText: "一段雨夜镜头",
        busy: false,
        activeConversation: conversation,
        selectedModel: "full-video",
        mode: "video",
        config: {
            baseUrl: "https://api.example.com/v1",
            apiKey: "test-key",
            model: "full-video",
            interfaceType: "full-video",
        } as never,
        attachments: [],
        mentionReferences: [],
        ratio: "16:9",
        seconds: "5",
        quality: "auto",
        videoQuality: "720p",
        count: "1",
        textStreaming: false,
        textThinking: false,
        imageProfile: { maxOutputs: 1 } as never,
        videoProfile: defaultVideoCapabilityConfig(),
        retryPreparingSet: new Set(),
        activeGenerationTaskIdsSet: new Set(),
        abortRef: { current: null },
        followLatestMessageRef: { current: false },
        toast: {
            warning: (msg: string) => errors.push(String(msg)),
            error: (msg: string) => errors.push(String(msg)),
        } as never,
        resolveReferenceLinks: (async () => []) as never,
        setBusy: () => undefined,
        setComposerNotice: () => undefined,
        setPrompt: () => undefined,
        setAttachments: () => undefined,
        setDraftReferences: () => undefined,
        setReferenceNotice: () => undefined,
        updateActive: (updater) => {
            conversation = updater(conversation);
        },
        updateConversationMessage: async (_conversationId, id, updater) => {
            conversation = {
                ...conversation,
                messages: conversation.messages.map((item: CreationMessage) => (item.id === id ? updater(item) : item)),
            };
        },
        applyCanonicalConversation: (_conversationId, doc) => {
            conversation = doc;
        },
        loadRuntime: (async () => ({
            skillRuntime: {
                prepare: async ({ prompt }: { prompt: string }) => ({ prompt, metadata: {} }),
            },
            beginGenerationConsumer: (signal: AbortSignal) => ({
                signal,
                release: () => undefined,
            }),
            projectGenerationTaskResult: (task: GenerationTask, result: unknown) => ({
                ...task,
                resultJson: JSON.stringify(result),
            }),
            runGenerationOperationOnce: async (_opId: string | undefined, fn: () => Promise<unknown>) => fn(),
            runBackendGenerationTask: async ({ onTaskUpdate }: { onTaskUpdate?: (task: GenerationTask) => void }) => {
                onTaskUpdate?.({
                    id: "task-streamed-1",
                    type: "video",
                    status: "succeeded",
                    prompt: "一段雨夜镜头",
                    attempts: 1,
                    createdAt: "2026-11-23T00:00:00.000Z",
                    updatedAt: "2026-11-23T00:00:01.000Z",
                });
                return {
                    mode: "video" as const,
                    video: {
                        url: "/api/resources/res-222m/file",
                        storageKey: "resource:res-222m",
                        resourceId: "res-222m",
                        mimeType: "video/mp4",
                        bytes: 232920148,
                        width: 1280,
                        height: 720,
                        durationMs: 10000,
                    },
                };
            },
            consumeGenerationTaskMessage: async (task: GenerationTask) => {
                consumedTasks.push(task);
                return task;
            },
            generationTaskMaterializedUrls: () => ["/api/resources/res-222m/file"],
            isGenerationTaskCancelled: () => false,
        })) as never,
    });

    expect(errors).toEqual([]);
    expect(consumedTasks).toHaveLength(1);
    const assistant = conversation.messages.find((item) => item.role === "assistant");
    expect(assistant?.status).toBe("done");
    expect(assistant?.error).toBeUndefined();
});
