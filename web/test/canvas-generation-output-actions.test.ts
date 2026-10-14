import { afterEach, expect, test } from "bun:test";
import type { GenerationOutput } from "@/lib/generation-outputs";
import { captureUserScope } from "@/lib/user-scope-guard";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { apiClient } from "@/services/api/request";
import type { GenerationTask } from "@/services/api/task-center";
import { materializedCanvasGenerationOutputs, resolveCanvasGenerationOutputs } from "@/services/canvas-generation-outputs";
import { useGenerationDeliveryProgress } from "@/stores/use-generation-delivery-progress";

const adapter = apiClient.defaults.adapter;
const scope = getActiveUserScope();
afterEach(() => {
    apiClient.defaults.adapter = adapter;
    setActiveUserScope(scope);
    useGenerationDeliveryProgress.setState({ byTask: {} });
});
const output: GenerationOutput = { id: "output:1", outputIndex: 1, mediaType: "video", dataUrl: "/api/resources/video/file", storageKey: "resource:video" };
const task: GenerationTask = { id: "owned-task", type: "video", status: "succeeded", prompt: "", attempts: 1, createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z", resultJson: JSON.stringify({ outputs: [output] }), outputs: [{ outputIndex: 1, mediaType: "video", resourceId: "video", materializedAssetId: "owned-video-asset" }] };

test("result actions read canonical delivery through the shared task API and preserve cancellation", async () => {
    const controller = new AbortController();
    const expectedScope = captureUserScope();
    let requests = 0;
    apiClient.defaults.adapter = async (config) => {
        requests++;
        expect(config.url).toBe("/tasks/owned-task");
        expect(config.signal).toBe(controller.signal);
        return { data: { code: 0, data: task }, status: 200, statusText: "OK", headers: {}, config };
    };
    const [resolved] = await resolveCanvasGenerationOutputs(task.id, [{ ...output, assetId: "wrong-parent-asset" }], expectedScope, controller.signal);
    expect(resolved.assetId).toBe("owned-video-asset");
    expect(requests).toBe(1);
    controller.abort();
    await expect(resolveCanvasGenerationOutputs(task.id, [output], expectedScope, controller.signal)).rejects.toBeTruthy();
    expect(requests).toBe(1);
});

test("switching accounts A to B to A abandons the pending result action", async () => {
    const captured = captureUserScope();
    apiClient.defaults.adapter = async (config) => {
        setActiveUserScope("other-output-owner");
        setActiveUserScope(captured.userScope);
        return { data: { code: 0, data: task }, status: 200, statusText: "OK", headers: {}, config };
    };
    await expect(resolveCanvasGenerationOutputs(task.id, [output], captured)).rejects.toMatchObject({ name: "UserScopeAbandonedError" });
});

test("a failed task query or mismatched task cannot produce a canvas output", async () => {
    apiClient.defaults.adapter = async (config) => ({ data: { code: 403, reason: "forbidden", msg: "not owned" }, status: 403, statusText: "Forbidden", headers: {}, config });
    await expect(resolveCanvasGenerationOutputs(task.id, [output], captureUserScope())).rejects.toThrow("not owned");
    apiClient.defaults.adapter = async (config) => ({ data: { code: 0, data: { ...task, id: "other-task" } }, status: 200, statusText: "OK", headers: {}, config });
    await expect(resolveCanvasGenerationOutputs(task.id, [output], captureUserScope())).rejects.toThrow("任务不匹配");
});

test("adding multiple outputs waits for every selected asset while an already delivered primary remains ready", async () => {
    const image: GenerationOutput = { id: "output:0", outputIndex: 0, mediaType: "image", storageKey: "resource:image", dataUrl: "/api/resources/image/file" };
    const audio: GenerationOutput = { id: "output:2", outputIndex: 2, mediaType: "audio", storageKey: "resource:audio", dataUrl: "/api/resources/audio/file" };
    const pending: GenerationTask = { ...task, resultJson: JSON.stringify({ outputs: [image, output, audio] }), outputs: [
        { outputIndex: 0, mediaType: "image", resourceId: "image", materializedAssetId: "image-asset" },
        { outputIndex: 1, mediaType: "video", resourceId: "video" },
        { outputIndex: 2, mediaType: "audio", resourceId: "audio" },
    ] };
    expect(() => materializedCanvasGenerationOutputs(pending, [output, audio])).toThrow("尚未就绪");
    let reads = 0;
    apiClient.defaults.adapter = async (config) => {
        expect(config.method).toBe("get");
        expect(config.url).toBe("/tasks/owned-task");
        reads++;
        const next = { ...pending, outputs: pending.outputs.map((item) => ({ ...item, materializedAssetId: item.outputIndex === 1 && reads >= 2 ? "video-asset" : item.outputIndex === 2 && reads >= 3 ? "audio-asset" : item.materializedAssetId })) };
        return { data: { code: 0, data: next }, status: 200, statusText: "OK", headers: {}, config };
    };
    const resolved = await resolveCanvasGenerationOutputs(task.id, [output, audio], captureUserScope(), undefined, { sleep: async () => undefined });
    expect(reads).toBe(3);
    expect(resolved.map((item) => item.assetId)).toEqual(["video-asset", "audio-asset"]);
    expect(useGenerationDeliveryProgress.getState().byTask[task.id]).toBeUndefined();
});

test("expanded output waiting stops on cancellation or account changes before another task read", async () => {
    for (const interrupt of ["cancel", "account"] as const) {
        const expectedScope = captureUserScope();
        const controller = new AbortController();
        let reads = 0;
        apiClient.defaults.adapter = async (config) => {
            reads++;
            return { data: { code: 0, data: { ...task, outputs: [{ outputIndex: 1, mediaType: "video", resourceId: "video" }] } }, status: 200, statusText: "OK", headers: {}, config };
        };
        const waiting = resolveCanvasGenerationOutputs(task.id, [output], expectedScope, controller.signal, { sleep: async () => {
            if (interrupt === "cancel") controller.abort();
            else { setActiveUserScope("other-output-owner"); setActiveUserScope(expectedScope.userScope); }
        } });
        await expect(waiting).rejects.toMatchObject({ name: interrupt === "cancel" ? "AbortError" : "UserScopeAbandonedError" });
        expect(reads).toBe(1);
        expect(useGenerationDeliveryProgress.getState().byTask[task.id]).toBeUndefined();
    }
});

test("expanded output waiting is bounded and stops paused or permanently failed delivery", async () => {
    for (const reason of ["delivery_paused", "delivery_timed_out", "resource_foreign", "deadline"]) {
        const captured = captureUserScope();
        let reads = 0;
        let time = 0;
        apiClient.defaults.adapter = async (config) => {
            reads++;
            return { data: { code: 0, data: { ...task, outputs: [{ outputIndex: 1, mediaType: "video", resourceId: "video", materializationErrorCode: reason === "deadline" ? "" : reason }] } }, status: 200, statusText: "OK", headers: {}, config };
        };
        await expect(resolveCanvasGenerationOutputs(task.id, [output], captured, undefined, { sleep: async () => { time += 15 * 60 * 1000; }, now: () => time })).rejects.toMatchObject({ name: "CanvasGenerationMaterializationError" });
        expect(reads).toBe(reason === "deadline" ? 2 : 1);
        expect(useGenerationDeliveryProgress.getState().byTask[task.id]).toBeUndefined();
    }
});
