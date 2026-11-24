import { getAgentHostStatus, type AgentHostStatus } from "@/services/api/agent-assistant";
import { assistantStatusNotice } from "./canvas-assistant-copy";
import { isAssistantTransientReason } from "./canvas-assistant-recovery";

const DEFAULT_WAIT_ATTEMPTS = 65; // 65 * 500ms = 32.5s，覆盖后端 20s 就绪超时 + 5s 停旧进程 + 余量
const DEFAULT_WAIT_INTERVAL_MS = 500;

/** Only wait before dispatch. Never replay a chat whose outcome might already include writes. */
export async function waitForAssistant(
    signal: AbortSignal,
    readStatus: (options?: { signal?: AbortSignal }) => Promise<AgentHostStatus> = getAgentHostStatus,
    attempts = DEFAULT_WAIT_ATTEMPTS,
    intervalMs = DEFAULT_WAIT_INTERVAL_MS,
): Promise<AgentHostStatus> {
    for (let attempt = 0; attempt < attempts; attempt++) {
        signal.throwIfAborted();
        const status = await readStatus({ signal });
        signal.throwIfAborted();
        if (status.available) return status;
        if (!isAssistantTransientReason(status.reason)) throw new Error(assistantStatusNotice(status.reason).text);
        await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new DOMException("Stopped", "AbortError")); };
            const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, intervalMs);
            signal.addEventListener("abort", abort, { once: true });
        });
    }
    throw new Error("连接暂时未就绪，你的消息还在，请稍后重试");
}
