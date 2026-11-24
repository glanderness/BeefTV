import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/services/api/request";
import { getAgentHostStatus, restartAgentHost, type AgentHostStatus } from "@/services/api/agent-assistant";
import { isAssistantTransientReason, resolveAssistantStatusPollError } from "./canvas-assistant-recovery";

/**
 * 助手宿主状态轮询与手动重启。
 * 状态只在面板打开时复查：关着的面板不该一直问后端；正在启动或等待切换时节奏更快。
 */
export function useAssistantHostStatus(open: boolean) {
    const [status, setStatus] = useState<AgentHostStatus | null>(null);
    const [statusBusy, setStatusBusy] = useState(false);
    const statusRef = useRef(status);
    statusRef.current = status;

    const fastPoll = isAssistantTransientReason(status?.reason);
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        let inFlight = false;
        let consecutiveErrors = 0;
        let activeController: AbortController | null = null;
        const refresh = () => {
            if (cancelled || inFlight) return;
            inFlight = true;
            const controller = new AbortController();
            activeController = controller;
            getAgentHostStatus({ signal: controller.signal })
                .then((value) => {
                    if (cancelled) return;
                    consecutiveErrors = 0;
                    setStatus(value);
                })
                .catch((error) => {
                    if (cancelled) return;
                    if (error instanceof DOMException && error.name === "AbortError") return;
                    consecutiveErrors += 1;
                    const reason = error instanceof ApiError ? error.reason : undefined;
                    setStatus((prev) => resolveAssistantStatusPollError(prev, reason, consecutiveErrors));
                })
                .finally(() => {
                    inFlight = false;
                    if (activeController === controller) activeController = null;
                });
        };
        refresh();
        const timer = setInterval(refresh, fastPoll ? 2000 : 15000);
        return () => {
            cancelled = true;
            activeController?.abort();
            clearInterval(timer);
        };
    }, [open, fastPoll]);

    const restartHost = useCallback(async () => {
        setStatusBusy(true);
        try {
            await restartAgentHost();
            const nextStatus = await getAgentHostStatus();
            setStatus(nextStatus);
        } catch {
            setStatus({ available: false, reason: "host_start_failed" });
        } finally {
            setStatusBusy(false);
        }
    }, []);

    return {
        status,
        setStatus,
        statusRef,
        statusBusy,
        restartHost,
    };
}
