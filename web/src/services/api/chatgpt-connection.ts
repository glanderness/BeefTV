import { http } from "@/services/api/request";

export type ChatGPTConnectionState = "disconnected" | "pending" | "connected" | "expired" | "revoked" | "error";

export type ChatGPTConnectionSummary = {
    state: ChatGPTConnectionState | string;
    userCode?: string;
    verificationUri?: string;
    expiresAt?: string;
    accountId?: string;
    planType?: string;
    email?: string;
    connectedAt?: string;
    errorReason?: string;
    credentialRef?: string;
    hasCredential?: boolean;
};

export function getChatGPTConnection(signal?: AbortSignal) {
    return http.get<ChatGPTConnectionSummary>("/chatgpt/connection", { signal });
}

export function startChatGPTConnection(signal?: AbortSignal) {
    return http.post<ChatGPTConnectionSummary>("/chatgpt/connection/start", {}, { signal });
}

export function cancelChatGPTConnection(signal?: AbortSignal) {
    return http.post<ChatGPTConnectionSummary>("/chatgpt/connection/cancel", {}, { signal });
}

export function disconnectChatGPTConnection(signal?: AbortSignal) {
    return http.post<ChatGPTConnectionSummary>("/chatgpt/connection/disconnect", {}, { signal });
}

export function chatGPTConnectionLabel(summary: ChatGPTConnectionSummary | null | undefined) {
    const state = summary?.state || "disconnected";
    switch (state) {
        case "pending":
            return summary?.userCode ? `请在浏览器确认 ${summary.userCode}` : "等待浏览器确认授权";
        case "connected":
            return connectedAccountLabel(summary);
        case "expired":
            return "授权已过期，请重新连接";
        case "revoked":
            return "授权已失效，请重新连接";
        case "error":
            return summary?.errorReason || "连接失败，请重试";
        default:
            return "未连接 ChatGPT 订阅";
    }
}

export const CHATGPT_SUBSCRIPTION_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CHATGPT_SUBSCRIPTION_INTERFACE = "chatgpt-subscription";

function connectedAccountLabel(summary: ChatGPTConnectionSummary | null | undefined) {
    const name = summary?.email || summary?.accountId;
    const plan = summary?.planType ? ` · ${summary.planType}` : "";
    if (name) return `已连接 ${name}${plan}`;
    return `已连接${plan}`;
}
