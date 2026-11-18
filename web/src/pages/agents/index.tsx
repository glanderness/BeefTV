import ClaudeMark from "@lobehub/icons/es/Claude/components/Color";
import CodexMark from "@lobehub/icons/es/Codex/components/Mono";
import CursorMark from "@lobehub/icons/es/Cursor/components/Mono";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Popconfirm } from "antd";
import { Copy, KeyRound, Plus, Plug, Terminal } from "lucide-react";
import { useState } from "react";

import { PageHeader, TableSurface, WorkspacePage } from "@/components/layout/workspace-page";
import { StatusBadge } from "@/components/ui/base/badges";
import { DetailDrawer } from "@/components/ui/product/app-drawer";
import { EmptyState } from "@/components/ui/product/empty-state";
import { useCopyText } from "@/hooks/use-copy-text";
import { isNativeDesktopRuntime } from "@/lib/runtime-mode";
import { connectAgentIntegration, disconnectAgentIntegration, listAgentClients, revokeAgentClient, type AgentClient, type AgentClientKind, type AgentIntegration, type AgentIntegrationKind } from "@/services/api/agent-clients";
import { ApiError } from "@/services/api/request";

import { agentClientDisplayLabel, agentClientKindLabel, agentClientKinds, agentClientLastUsedLabel, agentClientModeLabel, agentIntegrationAction, agentIntegrationHint, agentIntegrationStatusLabel } from "./agent-client-presentation";
import { RecentMCPCalls } from "./recent-mcp-calls";
import { AgentConnectPanel } from "./agent-connect-panel";

const clientMarks = { codex: CodexMark, claude: ClaudeMark, "claude-desktop": ClaudeMark, cursor: CursorMark, other: Plug, cli: Terminal };

const AGENT_CLIENTS_QUERY_KEY = ["agent-clients"] as const;

function clientStatus(clients: AgentClient[], integration?: AgentIntegration) {
    if (integration?.needsRetry) return { label: agentIntegrationStatusLabel(integration), tone: "warning" } as const;
    if (integration?.connected) return { label: agentIntegrationStatusLabel(integration), tone: integration.detected && integration.skillInstalled ? "success" : "warning" } as const;
    if (clients.some((client) => client.lastUsedAt)) return { label: "已验证连接", tone: "success" } as const;
    if (clients.length) return { label: "等待连接", tone: "warning" } as const;
    return { label: integration ? agentIntegrationStatusLabel(integration) : "未连接", tone: "neutral" } as const;
}

export default function AgentsPage() {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const [selected, setSelected] = useState<AgentClientKind | "cli">("cli");
    const [open, setOpen] = useState(false);
    const [configuring, setConfiguring] = useState(false);
    const [setupBusy, setSetupBusy] = useState(false);
    const [revoking, setRevoking] = useState("");
    const [integrationBusy, setIntegrationBusy] = useState<AgentIntegrationKind | null>(null);

    const clientsQuery = useQuery({
        queryKey: AGENT_CLIENTS_QUERY_KEY,
        queryFn: ({ signal }) => listAgentClients(signal),
        retry: false,
        refetchInterval: 5000,
    });

    // 后端还没带上这个能力时（404）不报错，也不留一个坏掉的页面。
    const unsupported = clientsQuery.error instanceof ApiError && clientsQuery.error.status === 404;
    const clients = clientsQuery.data?.clients || [];
    const cli = clientsQuery.data?.cli;
    // 一键接入只在本机桌面版出现；Web/服务端只保留手动配置。
    const integrations = isNativeDesktopRuntime() ? clientsQuery.data?.integrations : undefined;

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

    const connectIntegration = async (integration: AgentIntegration) => {
        setIntegrationBusy(integration.kind);
        try {
            await connectAgentIntegration(integration.kind);
            message.success(`已接入 ${integration.name}`);
            await clientsQuery.refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "接入失败，请稍后重试");
        } finally {
            setIntegrationBusy(null);
        }
    };

    const disconnectIntegration = async (integration: AgentIntegration) => {
        setIntegrationBusy(integration.kind);
        try {
            const result = await disconnectAgentIntegration(integration.kind);
            message.success(`已断开 ${integration.name}`);
            if (result.warning) message.info(result.warning);
            await clientsQuery.refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "断开失败，请稍后重试");
        } finally {
            setIntegrationBusy(null);
        }
    };

    const rows = agentClientKinds.map((kind) => {
        const integration = integrations?.find((item) => item.kind === kind);
        const manual = clients.filter((client) => client.kind === kind && !(integration && client.desktopIntegration));
        return { kind, manual, integration, managed: Boolean(integration?.connected || integration?.needsRetry || manual.length) };
    });
    const current = rows.find((row) => row.kind === selected);
    const integration = current?.integration;
    const busy = setupBusy || Boolean(integrationBusy || revoking);
    const blocked = !cli?.available || Boolean(clientsQuery.error);
    const drawerTitle = selected === "cli" ? "命令行工具" : agentClientKindLabel(selected);

    const ClientMark = clientMarks[selected];
    const desktopStatus = integration && clientStatus([], integration);

    function showDrawer(target: typeof selected, setup = false) {
        setSelected(target);
        setConfiguring(setup);
        setOpen(true);
    }

    return (
        <WorkspacePage className="agents-page">
            <PageHeader title="BeefTV MCP" actions={cli?.available && !unsupported && (
                <Button type="text" icon={<Terminal size={16} />} onClick={() => showDrawer("cli")}>命令行工具</Button>
            )} />
            {unsupported ? (
                <EmptyState icon={Plug} title="当前版本还不支持" description="更新到新版本后就能在这里连接 Codex、Claude Code 和 Cursor。" />
            ) : (
                <>
                    {clientsQuery.error && (
                        <div role="alert" className="mt-4 text-sm">
                            无法读取连接状态。<Button type="link" onClick={() => void clientsQuery.refetch()}>重试</Button>
                        </div>
                    )}
                    <TableSurface>
                        <div aria-hidden="true" className="agent-list-columns agent-list-head">
                            <span>客户端</span><span>连接状态</span><span className="agent-action-heading">操作</span>
                        </div>
                        <ul aria-label="MCP 客户端">
                            {rows.map(({ kind, manual, integration, managed }) => {
                                const status = clientsQuery.isPending || clientsQuery.error
                                    ? { label: clientsQuery.isPending ? "读取中" : "状态未知", tone: "neutral" as const }
                                    : clientStatus(manual, integration);
                                const action = managed ? "管理" : "连接";
                                const name = agentClientKindLabel(kind);
                                return (
                                    <li key={kind} data-agent-client-kind={kind} className="agent-list-columns agent-list-row">
                                        <span className="agent-client-name">{name}</span>
                                        <StatusBadge {...status} />
                                        <Button size="small" type="default" autoInsertSpace={false} aria-label={`${action} ${name}`} aria-haspopup="dialog"
                                            disabled={!clientsQuery.data || Boolean(clientsQuery.error) || (!managed && !cli?.available)}
                                            onClick={() => showDrawer(kind, !integration && !managed)}>{action}</Button>
                                    </li>
                                );
                            })}
                        </ul>
                    </TableSurface>
                    <RecentMCPCalls />
                    {cli && !cli.available && (
                        <p role="alert" className="mt-4 text-sm">安装文件不完整，无法连接外部工具。请重新下载并完整解压 BeefTV。</p>
                    )}
                </>
            )}
            <DetailDrawer
                open={open}
                rootClassName="agent-client-drawer"
                onClose={() => setOpen(false)}
                busy={busy}
                title={drawerTitle}
                icon={<ClientMark size={24} />}
            >
                {selected === "cli" && cli?.available ? (
                    <div className="space-y-4">
                        <p className="text-sm text-muted-foreground">在终端运行以下命令，即可使用 beeftv。</p>
                        <pre className="rounded-md bg-surface-active p-3 font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">{cli.installCommand}</pre>
                        <Button icon={<Copy size={14} />} onClick={() => copyText(cli.installCommand)}>复制安装命令</Button>
                    </div>
                ) : current && (configuring ? (
                    <AgentConnectPanel key={current.kind} kind={current.kind} onClose={() => setOpen(false)}
                        onConfigured={() => void clientsQuery.refetch()} verifiedClientIds={current.manual.filter((client) => client.lastUsedAt).map((client) => client.id)}
                        onBusyChange={setSetupBusy} />
                ) : (
                    <div className="agent-detail-sections">
                        {integration && desktopStatus && (
                            <section aria-label="桌面接入" className="agent-detail-card">
                                <div className="agent-detail-row">
                                    <div className="agent-desktop-summary">
                                        <h2>桌面接入</h2>
                                        <StatusBadge {...desktopStatus} />
                                    </div>
                                    {agentIntegrationAction(integration) === "disconnect" ? (
                                        <Popconfirm title={`断开 ${integration.name}？`}
                                            description="将移除 BeefTV 写入的连接和使用说明。" okText="断开" cancelText="取消"
                                            okButtonProps={{ danger: true }} onConfirm={() => disconnectIntegration(integration)}>
                                            <Button size="small" autoInsertSpace={false} aria-label="断开桌面接入" disabled={busy} loading={integrationBusy === integration.kind}>断开</Button>
                                        </Popconfirm>
                                    ) : (
                                        <Button size="small" autoInsertSpace={false} type="primary" disabled={!integration.detected || blocked || busy}
                                            loading={integrationBusy === integration.kind} onClick={() => void connectIntegration(integration)}>接入</Button>
                                    )}
                                </div>
                                {desktopStatus.tone !== "success" && <p className="agent-desktop-hint">{agentIntegrationHint(integration)}</p>}
                            </section>
                        )}
                        <section className="agent-detail-card" aria-labelledby="agent-manual-heading">
                            <div className="agent-section-heading">
                                <h2 id="agent-manual-heading">手动连接</h2>
                                <Button size="small" icon={<Plus size={14} />} disabled={busy || blocked} onClick={() => setConfiguring(true)}>新增连接</Button>
                            </div>
                            {current.manual.length ? (
                                <table className="agent-registration-table" aria-labelledby="agent-manual-heading">
                                    <thead><tr>
                                        <th scope="col">连接名称</th>
                                        <th scope="col">权限</th>
                                        <th scope="col">最近使用</th>
                                        <th scope="col"><span className="sr-only">操作</span></th>
                                    </tr></thead>
                                    <tbody>
                                        {current.manual.map((client) => (
                                            <tr key={client.id} data-agent-client-id={client.id}>
                                                <th scope="row"><div className="agent-registration-name">
                                                    <KeyRound size={14} aria-hidden /><span>{agentClientDisplayLabel(client)}</span>
                                                </div></th>
                                                <td>{agentClientModeLabel(client.mode)}</td>
                                                <td>{agentClientLastUsedLabel(client.lastUsedAt)}</td>
                                                <td>
                                                    <Popconfirm title="断开这个连接？" description="断开后，这个凭证将无法再访问画布。" okText="断开" cancelText="取消"
                                                        okButtonProps={{ danger: true }} onConfirm={() => disconnect(client.id)}>
                                                        <Button size="small" autoInsertSpace={false} aria-label={`断开手动连接 ${agentClientDisplayLabel(client)}`}
                                                            disabled={busy} loading={revoking === client.id}>断开</Button>
                                                    </Popconfirm>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            ) : <p className="agent-empty-connections">暂无手动连接</p>}
                        </section>
                    </div>
                ))}
            </DetailDrawer>
        </WorkspacePage>
    );
}
