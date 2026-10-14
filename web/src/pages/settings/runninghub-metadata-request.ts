import { captureUserScope, userScopeMatches } from "@/lib/user-scope-guard";
import { subscribeUserScope } from "@/lib/user-scope";
import { useConfigStore } from "@/stores/use-config-store";

// 订阅配置写入，而非仅检查渲染后的值，确保同一轮 A→B→A 也永久作废旧请求。
export function observeRunningHubMetadataRequest(controller: AbortController) {
    const current = useConfigStore.getState().config.runningHub;
    const connection = { baseUrl: current.baseUrl, apiKey: current.apiKey, enabled: current.enabled };
    const expectedScope = captureUserScope();
    const unsubscribeConfig = useConfigStore.subscribe((state, previous) => {
        const next = state.config.runningHub;
        const before = previous.config.runningHub;
        if (next.baseUrl !== before.baseUrl || next.apiKey !== before.apiKey || next.enabled !== before.enabled) controller.abort();
    });
    const unsubscribeScope = subscribeUserScope(() => controller.abort());
    const dispose = () => {
        unsubscribeConfig();
        unsubscribeScope();
        controller.signal.removeEventListener("abort", dispose);
    };
    controller.signal.addEventListener("abort", dispose, { once: true });
    if (controller.signal.aborted) dispose();
    return {
        connection,
        expectedScope,
        dispose,
        isCurrent: () => {
            const live = useConfigStore.getState().config.runningHub;
            return !controller.signal.aborted && userScopeMatches(expectedScope) && connection.enabled && live.enabled
                && live.baseUrl === connection.baseUrl && live.apiKey === connection.apiKey;
        },
    };
}
