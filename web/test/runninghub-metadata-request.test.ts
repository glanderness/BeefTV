import { afterEach, beforeEach, expect, test } from "bun:test";
import { observeRunningHubMetadataRequest } from "@/pages/settings/runninghub-metadata-request";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { useConfigStore, type RunningHubConfig } from "@/stores/use-config-store";
import { apiClient } from "@/services/api/request";
import { fetchRunningHubApp, fetchRunningHubWorkflow } from "@/services/api/runninghub";

const originalConfig = useConfigStore.getState().config;
const originalScope = getActiveUserScope();
const originalAdapter = apiClient.defaults.adapter;
const ownedRequests: Array<ReturnType<typeof observeRunningHubMetadataRequest>> = [];

function update(patch: Partial<RunningHubConfig>) {
    useConfigStore.getState().updateConfig("runningHub", { ...useConfigStore.getState().config.runningHub, ...patch });
}
function observe(controller = new AbortController()) {
    const request = observeRunningHubMetadataRequest(controller);
    ownedRequests.push(request);
    return { request, controller };
}
beforeEach(() => update({ enabled: true, baseUrl: "https://site-a.example", apiKey: "test-key-a", workflows: [] }));
afterEach(() => {
    for (const request of ownedRequests.splice(0)) request.dispose();
    apiClient.defaults.adapter = originalAdapter;
    useConfigStore.setState({ config: originalConfig });
    setActiveUserScope(originalScope);
});

test("request accepts unrelated workflow edits and releases its config subscriptions after completion", () => {
    const { request, controller } = observe();
    update({ workflowId: "same-site-workflow", workflows: [{ workflowId: "saved", kind: "workflow", fields: [] }] });
    expect(request.isCurrent()).toBe(true);
    request.dispose();
    update({ baseUrl: "https://site-b.example" });
    expect(controller.signal.aborted).toBe(false);
    expect(request.isCurrent()).toBe(false);
});

test("disabling RunningHub abandons the active request immediately", () => {
    const { request, controller } = observe();
    update({ enabled: false });
    update({ enabled: true });
    expect(controller.signal.aborted).toBe(true);
    expect(request.isCurrent()).toBe(false);
});

test("account A to B to A cannot reuse a pending metadata request", () => {
    const { request, controller } = observe();
    setActiveUserScope("other-runninghub-owner");
    setActiveUserScope(originalScope);
    expect(controller.signal.aborted).toBe(true);
    expect(request.isCurrent()).toBe(false);
});

for (const kind of ["workflow", "app"] as const) {
    for (const field of ["baseUrl", "apiKey"] as const) {
        for (const restore of [false, true]) {
            test(`${kind}: changing ${field}${restore ? " A to B to A" : ""} rejects a delayed response and allows a fresh request`, async () => {
                const { request, controller } = observe();
                let release!: () => void;
                let dispatched!: () => void;
                const held = new Promise<void>((resolve) => { release = resolve; });
                const started = new Promise<void>((resolve) => { dispatched = resolve; });
                let calls = 0;
                apiClient.defaults.adapter = async (config) => {
                    expect(config.url).toBe(kind === "app" ? "/runninghub/app-info" : "/runninghub/workflow-info");
                    if (calls++ === 0) {
                        expect(config.signal).toBe(controller.signal);
                        dispatched();
                        // 模拟不主动响应取消的传输，旧响应到达后仍须被丢弃。
                        await held;
                    }
                    return { data: { code: 0, data: { workflowId: "same-id", kind, fields: [] } }, status: 200, statusText: "OK", headers: {}, config };
                };
                const fetch = kind === "app" ? fetchRunningHubApp : fetchRunningHubWorkflow;
                const params = { ...request.connection, walletApiKey: "", useWallet: false, capability: "video" as const, workflowId: "same-id", webappId: "same-id" };
                const pending = fetch(params, controller.signal, request.expectedScope);
                await started;
                update({ [field]: field === "baseUrl" ? "https://site-b.example" : "test-key-b" });
                if (restore) update({ [field]: request.connection[field] });
                expect(controller.signal.aborted).toBe(true);
                expect(request.isCurrent()).toBe(false);
                release();
                await expect(pending).rejects.toMatchObject({ name: "AbortError" });
                expect(useConfigStore.getState().config.runningHub.workflows).toHaveLength(0);

                const fresh = observe();
                const result = await fetch({ ...params, ...fresh.request.connection }, fresh.controller.signal, fresh.request.expectedScope);
                expect(result.workflowId).toBe("same-id");
                expect(fresh.request.isCurrent()).toBe(true);
            });
        }
    }
}
