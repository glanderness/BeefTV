import { ApiError, http } from "./request";
import {
    ASSISTANT_MUTATION_TIMEOUT_MS,
    ASSISTANT_READ_TIMEOUT_MS,
    agentAssistantFailureText,
} from "./agent-assistant-types";

// UI 会话凭据只保存在内存里：刷新页面即重新签发，不写入 localStorage。
let uiSession: { token: string; expiresAt: number } | null = null;
let uiSessionPending: { promise: Promise<string> } | null = null;
let uiSessionGeneration = 0;

/** UI 会话头由页面内存里的凭据提供；助手的每条路由都走同一套认证。 */
export async function uiSessionConfig() {
    const token = await ensureAgentUiSession();
    return { headers: { "X-Beeftv-Ui-Session": token } };
}

export async function assistantReadConfig() {
    return { ...(await uiSessionConfig()), timeout: ASSISTANT_READ_TIMEOUT_MS };
}

export async function assistantMutationConfig() {
    return { ...(await uiSessionConfig()), timeout: ASSISTANT_MUTATION_TIMEOUT_MS };
}

export async function ensureAgentUiSession(): Promise<string> {
    if (uiSession && Date.now() + 30_000 < uiSession.expiresAt) return uiSession.token;
    if (uiSessionPending) return uiSessionPending.promise;
    const generation = ++uiSessionGeneration;
    const promise = issueAgentUiSession(generation);
    uiSessionPending = { promise };
    try {
        return await promise;
    } finally {
        if (uiSessionPending?.promise === promise) uiSessionPending = null;
    }
}

async function issueAgentUiSession(generation: number): Promise<string> {
    let data: { token?: string; expiresAt?: string };
    try {
        data = await http.post<{ token: string; expiresAt: string }>("/assistant/ui-session", {}, { timeout: ASSISTANT_READ_TIMEOUT_MS });
    } catch (error) {
        if (error instanceof ApiError) {
            if (error.status === 403) {
                throw new Error(agentAssistantFailureText("forbidden"));
            }
            if (error.reason === "host_unreachable" || error.status === 503) {
                throw new ApiError(
                    agentAssistantFailureText(error.reason, "创作助手暂时不可用，请稍后再试"),
                    {
                        code: error.code,
                        status: error.status,
                        reason: error.reason || "host_unreachable",
                        cause: error,
                    },
                );
            }
        }
        throw new Error(agentAssistantFailureText(undefined, "创作助手暂时不可用，请稍后再试"));
    }
    if (!data?.token) throw new Error("创作助手暂时不可用，请稍后再试");
    if (generation !== uiSessionGeneration) throw new Error("当前页面会话已更新，请重新发送");
    // Invalid/missing expiry is never cached; the server remains the authority on validity.
    const expiresAt = Date.parse(data.expiresAt ?? "");
    uiSession = Number.isFinite(expiresAt) ? { token: data.token, expiresAt } : null;
    return data.token;
}

export function resetAgentUiSession() {
    uiSession = null;
    uiSessionPending = null;
    uiSessionGeneration += 1;
}

export function resetAgentUiSessionIfMatches(token: string) {
    if (uiSession?.token === token) resetAgentUiSession();
}
