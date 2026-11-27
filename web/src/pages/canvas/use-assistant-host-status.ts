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

    const consecutiveErrorsRef = useRef(0);
    const rescheduleRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        if (!open) {
            consecutiveErrorsRef.current = 0;
            rescheduleRef.current = null;
            return;
        }
        let cancelled = false;
        let inFlight = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let activeController: AbortController | null = null;
        const clearTimer = () => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
        };
        const scheduleNext = (nextStatus: AgentHostStatus | null) => {
            if (cancelled) return;
            clearTimer();
            const delay = isAssistantTransientReason(nextStatus?.reason) ? 2000 : 15000;
            timer = setTimeout(refresh, delay);
        };
        const refresh = () => {
            if (cancelled || inFlight) return;
            clearTimer();
            inFlight = true;
            const controller = new AbortController();
            activeController = controller;
            let settledStatus: AgentHostStatus | null = statusRef.current;
            getAgentHostStatus({ signal: controller.signal })
                .then((value) => {
                    if (cancelled) return;
                    consecutiveErrorsRef.current = 0;
                    settledStatus = value;
                    statusRef.current = value;
                    setStatus(value);
                })
                .catch((error) => {
                    if (cancelled) return;
                    if (error instanceof DOMException && error.name === "AbortError") return;
                    consecutiveErrorsRef.current += 1;
                    const reason = error instanceof ApiError ? error.reason : undefined;
                    settledStatus = resolveAssistantStatusPollError(statusRef.current, reason, consecutiveErrorsRef.current);
                    statusRef.current = settledStatus;
                    setStatus(settledStatus);
                })
                .finally(() => {
                    inFlight = false;
                    if (activeController === controller) activeController = null;
                    scheduleNext(settledStatus);
                });
        };
        rescheduleRef.current = () => scheduleNext(statusRef.current);
        refresh();
        return () => {
            cancelled = true;
            rescheduleRef.current = null;
            activeController?.abort();
            clearTimer();
        };
    }, [open]);

    const restartHost = useCallback(async () => {
        setStatusBusy(true);
        try {
            await restartAgentHost();
            const nextStatus = await getAgentHostStatus();
            consecutiveErrorsRef.current = 0;
            statusRef.current = nextStatus;
            setStatus(nextStatus);
            rescheduleRef.current?.();
        } catch {
            const failed: AgentHostStatus = { available: false, reason: "host_start_failed" };
            statusRef.current = failed;
            setStatus(failed);
            rescheduleRef.current?.();
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
