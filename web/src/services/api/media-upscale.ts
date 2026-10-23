import type { CapturedUserScope } from "@/lib/user-scope-guard";
import { http } from "./request";
import type { GenerationTask } from "./task-center";

export type UpscaleMode = "precision" | "generative" | "transparent";
export type UpscaleParams = { resourceId: string; channelId: string; mode: UpscaleMode; model: string; scale: number; outputFormat?: string; enhancementStrength?: "low" | "medium" | "high" };
export type UpscaleCapability = { mediaType: "image" | "video"; mode: UpscaleMode; models: string[]; scales: number[]; outputFormats: string[]; fixedScale?: number };
export type UpscaleCapabilities = { modes: UpscaleCapability[]; cloudProcessing: boolean; maxVideoDurationMs: number };
export type UpscaleEstimate = { mediaType: "image" | "video"; source: { width: number; height: number; durationMs?: number }; output: { width: number; height: number; durationMs?: number }; reservation: number; currency: "CNY"; generationSubmitted: false; cloudProcessing: boolean };
export const getUpscaleCapabilities = () => http.get<UpscaleCapabilities>("/media-upscale/capabilities");
// Estimation uploads and validates the source before querying the gateway.
// Allow the backend's five-minute outbound deadline plus a response margin.
export const estimateUpscale = (params: UpscaleParams) => http.post<UpscaleEstimate>("/media-upscale/estimate", params, {
    timeout: 330_000,
    timeoutErrorMessage: "超分估价等待超时，尚未提交生成任务。请检查网络后重新获取费用。",
}).then(quote => {
    if (quote.currency !== "CNY" || !Number.isFinite(quote.reservation) || quote.reservation <= 0 || quote.generationSubmitted !== false) throw new Error("超分费用未能确认，请重新获取");
    return quote;
});
export function createUpscaleTask(params: UpscaleParams & { clientOperationId: string; projectId: string; nodeId: string }) {
    return http.post<GenerationTask>("/media-upscale/tasks", params).then(task => {
        window.dispatchEvent(new CustomEvent("canvas:task-created", { detail: { task } }));
        return task;
    });
}
export function recoverUpscaleTask(taskId: string, expectedScope?: CapturedUserScope) {
    return http.post<GenerationTask>(`/media-upscale/tasks/${encodeURIComponent(taskId)}/recover`, {}, { expectedScope }).then(task => {
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("canvas:task-updated", { detail: { task } }));
        return task;
    });
}
export function validUpscaleScale(scale: number, fixedScale?: number) {
    return Number.isInteger(scale) && scale >= 1 && scale <= 4 && (!fixedScale || scale === fixedScale);
}
