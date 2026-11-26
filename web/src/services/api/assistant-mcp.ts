import { ensureAgentUiSession } from "@/services/api/agent-assistant";
import { http } from "@/services/api/request";

export type AssistantMcpTransport = "stdio" | "http";

export type AssistantMcpServerView = {
    name: string;
    transport: AssistantMcpTransport;
    enabled: boolean;
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    timeoutSec: number;
    envKeys: string[];
    headerKeys: string[];
    createdAt?: string;
    updatedAt?: string;
};

export type AssistantMcpRuntimeTool = {
    name: string;
    toolName: string;
    description?: string;
    readOnly?: boolean;
};

export type AssistantMcpRuntimeStatus = {
    name: string;
    transport: AssistantMcpTransport;
    state: "connected" | "error" | "disabled";
    toolCount: number;
    tools: AssistantMcpRuntimeTool[];
    serverInfo?: { name?: string; version?: string } | null;
    error?: string | null;
};

export type AssistantMcpListResponse = {
    servers: AssistantMcpServerView[];
    runtimeAvailable: boolean;
    runtime: Record<string, AssistantMcpRuntimeStatus>;
};

export type AssistantMcpUpsertInput = {
    name: string;
    transport?: AssistantMcpTransport;
    enabled?: boolean;
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    removeEnv?: string[];
    url?: string;
    headers?: Record<string, string>;
    removeHeaders?: string[];
    timeoutSec?: number;
};

export type AssistantMcpTestResult = {
    ok: boolean;
    name?: string;
    state: "connected" | "error";
    toolCount: number;
    tools: AssistantMcpRuntimeTool[];
    serverInfo?: { name?: string; version?: string } | null;
    error?: string | null;
};

async function headers(signal?: AbortSignal) {
    return {
        headers: { "X-Beeftv-Ui-Session": await ensureAgentUiSession() },
        signal,
    };
}

export async function listAssistantMcpServers(signal?: AbortSignal) {
    return http.get<AssistantMcpListResponse>("/assistant/mcp-servers", await headers(signal));
}

export async function saveAssistantMcpServer(input: AssistantMcpUpsertInput) {
    return http.put<{ server: AssistantMcpServerView }>(
        `/assistant/mcp-servers/${encodeURIComponent(input.name)}`,
        input,
        await headers(),
    );
}

export async function toggleAssistantMcpServer(name: string, enabled: boolean) {
    return http.patch<{ server: AssistantMcpServerView }>(
        `/assistant/mcp-servers/${encodeURIComponent(name)}`,
        { enabled },
        await headers(),
    );
}

export async function deleteAssistantMcpServer(name: string) {
    return http.delete<{ deleted: boolean; name: string }>(
        `/assistant/mcp-servers/${encodeURIComponent(name)}`,
        await headers(),
    );
}

export async function testAssistantMcpServer(name: string) {
    return http.post<AssistantMcpTestResult>(
        `/assistant/mcp-servers/${encodeURIComponent(name)}/test`,
        {},
        await headers(),
    );
}

export async function reloadAssistantMcpServers() {
    return http.post<{ ok: boolean; servers: AssistantMcpRuntimeStatus[] }>(
        "/assistant/mcp-servers/reload",
        {},
        await headers(),
    );
}
