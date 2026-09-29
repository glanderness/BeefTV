import { useQuery } from "@tanstack/react-query";
import { App, Button, Popconfirm } from "antd";
import { Plug, Terminal, Unplug } from "lucide-react";
import { useState } from "react";

import { PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { EmptyState } from "@/components/ui/product/empty-state";
import { useCopyText } from "@/hooks/use-copy-text";
import { ApiError } from "@/services/api/request";
import { listAgentClients, revokeAgentClient, type AgentClientKind } from "@/services/api/agent-clients";

import { agentClientDisplayLabel, agentClientKindLabel, agentClientKindSummary, agentClientKinds, agentClientLastUsedLabel, agentClientModeLabel } from "./agent-client-presentation";
import { AgentConnectModal } from "./agent-connect-modal";

const AGENT_CLIENTS_QUERY_KEY = ["agent-clients"] as const;

export default function AgentsPage() {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const [connecting, setConnecting] = useState<AgentClientKind | null>(null);
    const [revoking, setRevoking] = useState("");

    const clientsQuery = useQuery({
        queryKey: AGENT_CLIENTS_QUERY_KEY,
        queryFn: ({ signal }) => listAgentClients(signal),
        retry: false,
    });

    // 后端还没带上这个能力时（404）不报错，也不留一个坏掉的页面。
    const unsupported = clientsQuery.error instanceof ApiError && clientsQuery.error.status === 404;
    const clients = clientsQuery.data?.clients || [];
    const cli = clientsQuery.data?.cli;

    const disconnect = async (id: string) => {
        setRevoking(id);
        try {
            await revokeAgentClient(id);
            message.success("已断开");
            await clientsQuery.refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "断开失败，请稍后重试");
        } finally {
            setRevoking("");
        }
    };

    return (
        <WorkspacePage>
            <PageHeader title="外部 Agent" description="让 Codex、Claude Code、Cursor 直接读取和修改你的 BeefTV 画布。" />

            {unsupported ? (
                <EmptyState icon={Plug} title="当前版本还不支持" description="更新到新版本后就能在这里连接 Codex、Claude Code 和 Cursor。" />
            ) : (
                <div className="mt-4 flex flex-col gap-7 pb-6">
                    <section aria-labelledby="agent-connect-title">
                        <h2 id="agent-connect-title" className="text-sm font-semibold">选择要连接的工具</h2>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            {agentClientKinds.map((kind) => (
                                <div key={kind} data-agent-client-kind={kind} className="flex min-w-0 flex-col gap-3 rounded-[var(--r-md)] border border-border bg-surface px-4 py-4">
                                    <div className="min-w-0">
                                        <p className="truncate text-[13px] leading-5 font-semibold">{agentClientKindLabel(kind)}</p>
                                        <p className="mt-1.5 text-xs leading-5 text-foreground/55">{agentClientKindSummary(kind)}</p>
                                    </div>
                                    <Button className="mt-auto self-start" size="small" icon={<Plug className="size-3.5" />} onClick={() => setConnecting(kind)}>连接</Button>
                                </div>
                            ))}
                        </div>
                    </section>

                    <section aria-labelledby="agent-connected-title">
                        <h2 id="agent-connected-title" className="text-sm font-semibold">已连接</h2>
                        {clientsQuery.isPending ? (
                            <p className="mt-3 px-1 text-xs leading-5 text-foreground/45">正在读取…</p>
                        ) : clientsQuery.error ? (
                            <div className="mt-3 px-1 text-xs leading-5 text-foreground/55">
                                <p>没能读到已连接的工具。</p>
                                <Button type="link" size="small" className="mt-1 h-auto p-0 text-xs" onClick={() => void clientsQuery.refetch()}>重试</Button>
                            </div>
                        ) : clients.length ? (
                            <ul className="mt-3 flex flex-col gap-2">
                                {clients.map((client) => (
                                    <li key={client.id} data-agent-client-id={client.id} className="flex min-w-0 flex-col gap-3 rounded-[var(--r-md)] border border-border bg-surface px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="min-w-0">
                                            <p className="truncate text-[13px] leading-5 font-medium">{agentClientDisplayLabel(client)}</p>
                                            <p className="mt-1 text-xs leading-5 text-foreground/50">
                                                {[agentClientDisplayLabel(client) === agentClientKindLabel(client.kind) ? "" : agentClientKindLabel(client.kind), agentClientModeLabel(client.mode), `最近使用 ${agentClientLastUsedLabel(client.lastUsedAt)}`].filter(Boolean).join(" · ")}
                                            </p>
                                        </div>
                                        <Popconfirm
                                            title="断开这个工具？"
                                            description="断开后它不能再读取或修改画布，需要重新连接。"
                                            okText="断开"
                                            cancelText="取消"
                                            okButtonProps={{ danger: true }}
                                            onConfirm={() => void disconnect(client.id)}
                                        >
                                            <Button className="shrink-0 self-start sm:self-auto" size="small" icon={<Unplug className="size-3.5" />} loading={revoking === client.id}>断开</Button>
                                        </Popconfirm>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <EmptyState size="compact" icon={Plug} title="还没有连接任何工具" description="从上面选一个工具，连接后会出现在这里。" />
                        )}
                    </section>

                    {cli?.available ? (
                        <section aria-labelledby="agent-cli-title">
                            <h2 id="agent-cli-title" className="text-sm font-semibold">命令行工具</h2>
                            <div className="mt-3 flex min-w-0 flex-col gap-3 rounded-[var(--r-md)] border border-border bg-surface px-4 py-4">
                                <p className="text-xs leading-5 text-foreground/55">安装后可以在终端直接用 beeftv 命令。</p>
                                <p className="min-w-0 break-all rounded-md bg-surface-active px-3.5 py-2.5 text-[12px] leading-5 font-mono text-foreground/80">{cli.path}</p>
                                <Button className="self-start" size="small" icon={<Terminal className="size-3.5" />} onClick={() => copyText(cli.installCommand)}>复制安装命令</Button>
                            </div>
                        </section>
                    ) : null}
                </div>
            )}

            <AgentConnectModal kind={connecting} onClose={() => setConnecting(null)} onConnected={() => void clientsQuery.refetch()} />
        </WorkspacePage>
    );
}
