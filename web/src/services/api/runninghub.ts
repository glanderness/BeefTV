import { http } from "@/services/api/request";
import { captureUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import type { RunningHubConfig, RunningHubWorkflow } from "@/stores/use-config-store";

export type RunningHubWorkflowFetchResult = RunningHubWorkflow & { kind: "workflow" | "app"; webappId?: string; raw?: Record<string, unknown> };

type FetchRequest = Pick<RunningHubConfig, "baseUrl" | "apiKey" | "walletApiKey" | "useWallet"> & { workflowId?: string; webappId?: string; title?: string; capability: RunningHubConfig["capability"] };

export function fetchRunningHubWorkflow(config: FetchRequest, signal?: AbortSignal, expectedScope: CapturedUserScope = captureUserScope()) {
    return http.post<RunningHubWorkflowFetchResult>("/runninghub/workflow-info", runningHubFetchPayload(config), { signal, expectedScope, timeout: 30_000 });
}

export function fetchRunningHubApp(config: FetchRequest, signal?: AbortSignal, expectedScope: CapturedUserScope = captureUserScope()) {
    return http.post<RunningHubWorkflowFetchResult>("/runninghub/app-info", runningHubFetchPayload(config), { signal, expectedScope, timeout: 30_000 });
}

function runningHubFetchPayload(config: FetchRequest) {
    return {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        walletApiKey: config.walletApiKey,
        useWallet: config.useWallet,
        workflowId: config.workflowId,
        webappId: config.webappId,
        title: config.title,
        capability: config.capability,
    };
}
