import { http } from "@/services/api/request";
import type { ModelChannel, RunningHubCapability, WorkflowFieldMapping } from "@/stores/use-config-store";

export function inspectComfyUIWorkflow(channel: ModelChannel, workflowJson: Record<string, unknown>, capability: RunningHubCapability, signal?: AbortSignal) {
    return http.post<{ workflowJson: Record<string, unknown>; fields: WorkflowFieldMapping[] }>("/comfyui/workflow-info", {
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        headers: channel.headers,
        workflowJson,
        capability,
    }, { signal, timeout: 60_000 });
}
