import { App } from "antd";
import { useEffect, useRef } from "react";

import { listRecentMCPCalls, type MCPCall } from "@/services/api/agent-clients";

const PAID_TOOL_IDS = new Set([
    "canvas.generation.submit",
    "canvas.generation.regenerate",
    "business_post_tasks",
    "business_post_tasks_id_retry",
    "business_post_creation_runs_id_execute",
    "business_post_timeline_transcriptions",
]);

function formatClientName(client: string): string {
    switch (client) {
        case "claude":
            return "Claude Code";
        case "claude-desktop":
            return "Claude Desktop";
        case "codex":
            return "Codex";
        case "cursor":
            return "Cursor";
        case "local":
            return "外部 MCP";
        default:
            return client || "外部 Agent";
    }
}

/**
 * Lightweight non-blocking toast when an external MCP client (Claude Code / Codex / Cursor)
 * submits a new paid generation while the user has BeefTV open. Never blocks the external
 * workflow and never spams historical activity on initial mount.
 */
export function useExternalMcpActivityToast(enabled: boolean) {
    const { message } = App.useApp();
    const seenIdsRef = useRef<Set<number> | null>(null);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        let controller: AbortController | null = null;

        const poll = async () => {
            if (cancelled || document.visibilityState === "hidden") return;
            controller?.abort();
            controller = new AbortController();
            try {
                const calls = await listRecentMCPCalls(controller.signal);
                if (cancelled || !Array.isArray(calls)) return;
                if (seenIdsRef.current === null) {
                    seenIdsRef.current = new Set(calls.map((c) => c.id));
                    return;
                }
                const freshPaid: MCPCall[] = [];
                for (const call of calls) {
                    if (seenIdsRef.current.has(call.id)) continue;
                    seenIdsRef.current.add(call.id);
                    if (!call.failed && PAID_TOOL_IDS.has(call.tool) && call.billing !== "replay") {
                        freshPaid.push(call);
                    }
                }
                for (const call of freshPaid.slice(0, 2)) {
                    const who = formatClientName(call.client);
                    const model = call.model ? `（${call.model}）` : "";
                    const cost = call.amountCny != null ? ` · 约 ¥${call.amountCny.toFixed(2)}` : "";
                    message.info({
                        content: `${who} 已发起画布生成${model}${cost}`,
                        duration: 4,
                    });
                }
            } catch {
                // Best-effort passive notice; never disrupt canvas editing when offline or non-desktop.
            }
        };

        void poll();
        const timer = window.setInterval(() => void poll(), 15_000);
        return () => {
            cancelled = true;
            controller?.abort();
            window.clearInterval(timer);
        };
    }, [enabled, message]);
}
