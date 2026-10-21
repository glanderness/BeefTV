import { http } from "./request";
import { createGenerationTask, findGenerationTaskByOperation, waitForGenerationTask, type GenerationTask, type CreateTaskInput } from "./task-center";
import { parseBackendGenerationResult } from "./generation-task";
import { submitGenerationCommand } from "./generation-submission";
import { assertUserScope, captureUserScope, userScopeMatches } from "@/lib/user-scope-guard";

export type UpscaleMode = "image" | "video";
export type UpscaleParams = { variant: "precision" | "generative"; factor: number; outputFormat: "png" | "jpeg" };
export type UpscaleSource = { id?: string; name?: string; storageKey: string; mimeType?: string; type?: string; bytes?: number; width?: number; height?: number; durationMs?: number };
export type UpscaleEstimate = { model: string; currency: "CNY"; reservation: number; generation_submitted: false };
export type UpscaleCapabilities = { supported_models: Array<{ id: string; media_type: UpscaleMode; label: string }> };

export function upscaleModel(mode: UpscaleMode, variant: UpscaleParams["variant"]) {
    return mode === "image" ? (variant === "precision" ? "topaz-standard-v2" : "topaz-wonder-3.5") : variant === "precision" ? "topaz-proteus" : "topaz-starlight-fast-2";
}

export function upscaleInput(mode: UpscaleMode, source: UpscaleSource, params: UpscaleParams) {
    if (!/^resource:[^\s/]+$/.test(source.storageKey)) throw new Error("请先将素材保存到素材库");
    if (!Number.isInteger(params.factor) || params.factor < 1 || params.factor > 4) throw new Error("放大倍数须为 1 至 4 的整数");
    return {
        mode,
        prompt: "AI 超分",
        config: { credentialRef: "beefapi-enterprise", model: upscaleModel(mode, params.variant), interfaceType: "newapi" },
        upscale: { factor: params.factor, ...(mode === "image" ? { outputFormat: params.outputFormat } : {}) },
        ...(mode === "image" ? { referenceImages: [source] } : { referenceVideos: [source] }),
    };
}

export function getUpscaleCapabilities(signal?: AbortSignal) {
    return http.get<UpscaleCapabilities>("/media-upscale/capabilities", { signal }).then((capabilities) => {
        if (!Array.isArray(capabilities.supported_models) || capabilities.supported_models.some((model) => !model || typeof model.id !== "string" || model.media_type !== "image" && model.media_type !== "video")) throw new Error("超分能力读取失败，请稍后重试");
        return capabilities;
    });
}

export function estimateUpscale(mode: UpscaleMode, source: UpscaleSource, params: UpscaleParams, signal?: AbortSignal) {
    return http.post<UpscaleEstimate>("/media-upscale/estimate", upscaleInput(mode, source, params), { signal, timeout: 125_000 });
}

type RunUpscale = {
    projectId: string;
    nodeId: string;
    mode: UpscaleMode;
    source: UpscaleSource;
    params: UpscaleParams;
    clientOperationId: string;
    signal?: AbortSignal;
    onTaskCreated?: (task: GenerationTask) => void;
    expectedScope?: ReturnType<typeof captureUserScope>;
};

export async function runUpscaleTask(options: RunUpscale, dependencies = { createGenerationTask, findGenerationTaskByOperation, waitForGenerationTask }) {
    const expected = options.expectedScope ?? captureUserScope();
    const current = () => !options.signal?.aborted && userScopeMatches(expected);
    assertUserScope(expected);
    const body = upscaleInput(options.mode, options.source, options.params);
    const command: CreateTaskInput = {
        projectId: options.projectId,
        type: `canvas_${options.mode}`,
        operation: options.mode,
        prompt: body.prompt,
        model: body.config.model,
        input: { ...body, metadata: { source: "canvas", nodeId: options.nodeId, edit: "upscale", clientOperationId: options.clientOperationId } },
    };
    const task = await submitGenerationCommand(
        command,
        options.clientOperationId,
        (input) => {
            assertUserScope(expected);
            return dependencies.createGenerationTask(input, { expectedScope: expected });
        },
        () => {
            assertUserScope(expected);
            return dependencies.findGenerationTaskByOperation(options.clientOperationId, options.projectId);
        },
        current,
    );
    assertUserScope(expected);
    options.onTaskCreated?.(task);
    const completed = await dependencies.waitForGenerationTask(task.id, { signal: options.signal, initialTask: task, onTaskUpdate: options.onTaskCreated, expectedScope: expected });
    return parseBackendGenerationResult(completed);
}
