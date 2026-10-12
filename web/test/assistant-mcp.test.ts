import { describe, expect, test } from "bun:test";

import { resetAgentUiSession } from "@/services/api/agent-assistant";
import { mcpProbeFailureText, probeMcpServer } from "@/services/api/assistant-mcp";
import { ApiError, apiClient } from "@/services/api/request";

type Recorded = { method?: string; url?: string; data?: unknown; headers?: Record<string, string> };

function withStubbedApi(probeEnvelope: unknown, status: number, run: (recorded: Recorded[]) => Promise<void>) {
    const original = apiClient.request;
    const recorded: Recorded[] = [];
    apiClient.request = (async (config: Recorded) => {
        recorded.push({ method: config.method, url: config.url, data: config.data, headers: config.headers });
        if (config.url === "/assistant/ui-session") {
            return { data: { code: 0, data: { token: "ui-token", expiresAt: new Date(Date.now() + 60_000).toISOString() }, msg: "ok" }, status: 200, headers: {} };
        }
        if (status >= 400) {
            throw { isAxiosError: true, message: `Request failed with status code ${status}`, response: { status, data: probeEnvelope, headers: {} } };
        }
        return { data: probeEnvelope, status, headers: {} };
    }) as typeof apiClient.request;
    return run(recorded).finally(() => { apiClient.request = original; });
}

describe("检测 MCP 服务器", () => {
    test("只提交 serverId，带上界面会话凭据，并解包工具列表", async () => {
        resetAgentUiSession();
        await withStubbedApi({ code: 0, data: { tools: [
            { name: "ping", title: "Ping", description: "检查连通", readOnly: true },
            { name: "", title: "无名字", description: "", readOnly: false },
        ] }, msg: "ok" }, 200, async (recorded) => {
            await expect(probeMcpServer("srv-1")).resolves.toEqual({ tools: [{ name: "ping", title: "Ping", description: "检查连通", readOnly: true }] });
            const probe = recorded.find((call) => call.url === "/assistant/mcp/probe");
            expect(probe).toMatchObject({ method: "post", data: { serverId: "srv-1" } });
            expect(probe?.headers?.["X-Beeftv-Ui-Session"]).toBe("ui-token");
        });
    });

    test("后端返回失败原因时向上抛出，页面据此显示行内错误", async () => {
        resetAgentUiSession();
        await withStubbedApi({ code: 400, reason: "mcp_probe_failed", msg: "无法连接" }, 400, async () => {
            const thrown = await probeMcpServer("srv-2").catch((error) => error);
            expect(thrown).toMatchObject({ reason: "mcp_probe_failed" });
        });
    });
});

describe("检测失败的用户语", () => {
    test("按机器可读原因给出具体提示，未知原因走兜底", () => {
        const cases: Array<[string, string]> = [
            ["mcp_connect_timeout", "连接超时，请确认服务正在运行"],
            ["mcp_connect_failed", "连接不上，请检查命令或地址"],
            ["mcp_list_failed", "已连接，但读不到工具列表"],
            ["mcp_server_invalid", "配置不完整，请编辑后再试"],
            ["mcp_server_not_found", "没找到这个服务器，请保存后再试"],
            ["host_unreachable", "内置助手还没启动，请稍后再试"],
        ];
        for (const [reason, text] of cases) {
            expect(mcpProbeFailureText(new ApiError("x", { reason }))).toBe(text);
        }
        expect(mcpProbeFailureText(new ApiError("x", { reason: "mcp_probe_failed" }))).toBe("检测失败，请稍后再试");
        expect(mcpProbeFailureText(new Error("boom"))).toBe("检测失败，请稍后再试");
        expect(mcpProbeFailureText(undefined)).toBe("检测失败，请稍后再试");
    });
});
