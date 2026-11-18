import { useQuery } from "@tanstack/react-query";
import { Button } from "antd";

import { TableSurface } from "@/components/layout/workspace-page";
import { listRecentMCPCalls, type MCPCall } from "@/services/api/agent-clients";

import { agentClientKindLabel } from "./agent-client-presentation";

const timestamp = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const currency = new Intl.NumberFormat("zh-CN", {
    style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 6,
});

function costLabel(call: MCPCall) {
    if (call.amountCny != null) return currency.format(call.amountCny);
    if (call.billing === "none") return "无费用";
    if (call.billing === "replay") return "未重复计费";
    return "暂无账单";
}

export function RecentMCPCalls() {
    const query = useQuery({
        queryKey: ["agent-clients", "activity"],
        queryFn: ({ signal }) => listRecentMCPCalls(signal),
        refetchInterval: 5000,
        retry: false,
    });
    return (
        <section className="agent-history" aria-labelledby="agent-history-title">
            <h2 id="agent-history-title">近期调用记录</h2>
            <TableSurface>
                {query.data?.length ? (
                    <table aria-labelledby="agent-history-title">
                        <thead><tr><th>调用时间</th><th>客户端 / 工具</th><th>模型</th><th>任务费用</th></tr></thead>
                        <tbody>{query.data.map((call) => {
                            const at = new Date(call.at);
                            return (
                                <tr key={call.id}>
                                    <td><time dateTime={call.at} title={at.toLocaleString("zh-CN")}>{timestamp.format(at)}</time></td>
                                    <td>
                                        <span>{call.client === "local" ? "本机 MCP" : agentClientKindLabel(call.client)}</span>
                                        <small>{call.tool}{call.failed && " · 调用失败"}</small>
                                    </td>
                                    <td data-label="模型">{call.model || (call.billing === "none" || call.billing === "replay" ? "—" : "未提供")}</td>
                                    <td data-label="任务费用">{costLabel(call)}</td>
                                </tr>
                            );
                        })}</tbody>
                    </table>
                ) : !query.error && <p role="status">{query.isPending ? "正在读取调用记录…" : "暂无 MCP 工具调用记录"}</p>}
                {query.error && <p role="alert">调用记录更新失败。<Button size="small" type="link" onClick={() => void query.refetch()}>重试</Button></p>}
            </TableSurface>
        </section>
    );
}
