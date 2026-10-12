// 检测用户添加的 MCP 服务器：浏览器只提交服务器 id，命令、地址和密钥由后端从本机配置读取。
import { ensureAgentUiSession } from "@/services/api/agent-assistant";
import { ApiError, http } from "@/services/api/request";

export type McpProbeTool = { name: string; title: string | null; description: string; readOnly: boolean };
export type McpProbeResult = { tools: McpProbeTool[] };

export async function probeMcpServer(serverId: string): Promise<McpProbeResult> {
    const token = await ensureAgentUiSession();
    const data = await http.post<McpProbeResult>("/assistant/mcp/probe", { serverId }, { headers: { "X-Beeftv-Ui-Session": token } });
    const tools = Array.isArray(data?.tools) ? data.tools : [];
    return {
        tools: tools
            .map((tool) => ({
                name: String(tool?.name ?? "").trim(),
                title: typeof tool?.title === "string" ? tool.title : null,
                description: String(tool?.description ?? ""),
                readOnly: tool?.readOnly === true,
            }))
            .filter((tool) => tool.name),
    };
}

/** 检测失败的机器可读原因只用于分支，展示给用户的永远是一句用户语。 */
export function mcpProbeFailureText(error: unknown): string {
    const reason = error instanceof ApiError ? error.reason : undefined;
    switch (reason) {
        case "mcp_connect_timeout":
            return "连接超时，请确认服务正在运行";
        case "mcp_connect_failed":
            return "连接不上，请检查命令或地址";
        case "mcp_list_failed":
            return "已连接，但读不到工具列表";
        case "mcp_server_invalid":
            return "配置不完整，请编辑后再试";
        case "mcp_server_not_found":
            return "没找到这个服务器，请保存后再试";
        case "host_unreachable":
            return "内置助手还没启动，请稍后再试";
        default:
            return "检测失败，请稍后再试";
    }
}
