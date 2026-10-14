import type { GenerationOutput } from "@/lib/generation-outputs";
import { assertUserScope, captureUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { parseBackendGenerationResult } from "@/services/api/generation-task";
import { queryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { sleepWithSignal, waitForMaterializedGenerationOutputs, type SleepWithSignal } from "./canvas-generation-output-delivery";
import { publishGenerationDeliveryProgress } from "@/stores/use-generation-delivery-progress";

// 使用任务交付记录中的素材与资源配对，不能沿用源节点的主输出素材 ID。
export function materializedCanvasGenerationOutputs(task: GenerationTask, selected: GenerationOutput[]): GenerationOutput[] {
    if (task.status !== "succeeded") throw new Error("生成任务尚未完成，请稍后重试");
    const outputs = parseBackendGenerationResult(task).outputs || [];
    return selected.filter((item) => item.mediaType !== "file").map((selection) => {
        const output = outputs.find((item) => item.outputIndex === selection.outputIndex);
        const canonical = task.outputs?.find((item) => item.outputIndex === selection.outputIndex);
        if (!output || !canonical?.materializedAssetId || !canonical.resourceId
            || canonical.mediaType !== output.mediaType || selection.mediaType !== output.mediaType
            || output.storageKey !== `resource:${canonical.resourceId}` || selection.storageKey !== output.storageKey) {
            throw new Error("生成输出素材尚未就绪或已发生变化，请刷新结果后重试");
        }
        return { ...output, assetId: canonical.materializedAssetId, resourceId: canonical.resourceId };
    });
}

export async function resolveCanvasGenerationOutputs(taskId: string, selected: GenerationOutput[], expectedScope: CapturedUserScope, signal?: AbortSignal, runtime: { sleep?: SleepWithSignal; now?: () => number } = {}) {
    assertUserScope(expectedScope);
    let task = await queryGenerationTask(taskId, { expectedScope, signal });
    assertUserScope(expectedScope);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (task.id !== taskId) throw new Error("生成任务不匹配，请刷新结果后重试");
    if (task.status !== "succeeded") throw new Error("生成任务尚未完成，请稍后重试");
    const selectedMedia = selected.filter((item) => item.mediaType !== "file");
    const outputs = parseBackendGenerationResult(task).outputs || [];
    for (const selection of selectedMedia) {
        const output = outputs.find((item) => item.outputIndex === selection.outputIndex);
        if (!output || output.mediaType !== selection.mediaType || output.storageKey !== selection.storageKey) throw new Error("生成输出已发生变化，请刷新结果后重试");
    }
    const now = runtime.now ?? Date.now;
    task = await waitForMaterializedGenerationOutputs({
        task, outputIndices: selectedMedia.map((item) => item.outputIndex), signal, expectedScope,
        isCurrent: () => !signal?.aborted, liveScope: captureUserScope,
        refreshTask: queryGenerationTask, sleep: runtime.sleep ?? sleepWithSignal,
        now, startedAt: now(), publishDeliveryProgress: publishGenerationDeliveryProgress,
    });
    return materializedCanvasGenerationOutputs(task, selected);
}
