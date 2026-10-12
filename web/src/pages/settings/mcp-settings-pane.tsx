import { App, Button, Form, Input, Popconfirm, Segmented, Switch, Tag } from "antd";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";
import { useState } from "react";

import { PageHeader } from "@/components/layout/workspace-page";
import { AppModal } from "@/components/ui/product/app-modal";
import { EmptyState } from "@/components/ui/product/empty-state";
import { probeMcpServer, mcpProbeFailureText, type McpProbeTool } from "@/services/api/assistant-mcp";
import { flushModelConfig, getModelConfigPersistenceState } from "@/services/model-config-repository";
import { useConfigStore, type McpKeyValue, type McpServerConfig, type McpTransport } from "@/stores/use-config-store";

export type EditorDraft = {
    id: string;
    name: string;
    transport: McpTransport;
    command: string;
    args: string;
    url: string;
    env: McpKeyValue[];
    headers: McpKeyValue[];
};

const TRANSPORT_LABELS: Record<McpTransport, string> = { stdio: "本地命令", http: "远程地址" };
const INTRO = "添加后，内置助手可以调用这些工具。助手处于「只读」时只使用只读工具。";

function newKeyValue(): McpKeyValue {
    return { id: nanoid(), name: "", value: "" };
}

function draftFromServer(server: McpServerConfig): EditorDraft {
    return {
        id: server.id,
        name: server.name,
        transport: server.transport,
        command: server.command || "",
        args: (server.args || []).join("\n"),
        url: server.url || "",
        env: (server.env || []).map((item) => ({ ...item })),
        headers: (server.headers || []).map((item) => ({ ...item })),
    };
}

function emptyDraft(): EditorDraft {
    return { id: "", name: "", transport: "stdio", command: "", args: "", url: "", env: [], headers: [] };
}

function draftToServer(draft: EditorDraft): McpServerConfig {
    const base = { id: draft.id || nanoid(), name: draft.name.trim(), enabled: true, transport: draft.transport };
    if (draft.transport === "stdio") {
        return {
            ...base,
            command: draft.command.trim(),
            args: draft.args.split("\n").map((line) => line.trim()).filter(Boolean),
            env: draft.env.filter((item) => item.name.trim()),
        };
    }
    return { ...base, url: draft.url.trim(), headers: draft.headers.filter((item) => item.name.trim()) };
}

function validateDraft(draft: EditorDraft): string {
    if (!draft.name.trim()) return "请填写名称";
    if (draft.transport === "stdio") return draft.command.trim() ? "" : "请填写本地命令";
    const url = draft.url.trim();
    if (!url) return "请填写远程地址";
    if (!/^https?:\/\//i.test(url)) return "远程地址需要以 http:// 或 https:// 开头";
    return "";
}

async function persistConfig() {
    await flushModelConfig();
    const saved = getModelConfigPersistenceState();
    if (saved.status === "error" || saved.dirty) throw new Error(saved.error || "MCP 服务器尚未保存，请重试");
}

function KeyValueEditor({ label, addLabel, rows, onChange }: { label: string; addLabel: string; rows: McpKeyValue[]; onChange: (rows: McpKeyValue[]) => void }) {
    const update = (id: string, patch: Partial<McpKeyValue>) => onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    return (
        <div className="space-y-2 rounded-md border border-border/70 bg-muted/[.1] p-3">
            <div className="text-sm font-medium text-foreground">{label}</div>
            {rows.map((row, index) => (
                <div key={row.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_32px] gap-2">
                    <Input aria-label={`${label} ${index + 1} 名称`} value={row.name} placeholder="名称" onChange={(event) => update(row.id, { name: event.target.value })} />
                    <Input.Password aria-label={`${label} ${index + 1} 值`} value={row.value} placeholder="值" onChange={(event) => update(row.id, { value: event.target.value })} />
                    <Button aria-label={`删除${label} ${index + 1}`} className="size-8 p-0" icon={<Trash2 className="size-3.5" />} onClick={() => onChange(rows.filter((item) => item.id !== row.id))} />
                </div>
            ))}
            <Button size="small" type="dashed" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, newKeyValue()])}>{addLabel}</Button>
        </div>
    );
}

export function McpSettingsPane() {
    const { message } = App.useApp();
    const servers = useConfigStore((state) => state.config.mcpServers);
    const addMcpServer = useConfigStore((state) => state.addMcpServer);
    const updateMcpServer = useConfigStore((state) => state.updateMcpServer);
    const deleteMcpServer = useConfigStore((state) => state.deleteMcpServer);
    const setMcpToolDisabled = useConfigStore((state) => state.setMcpToolDisabled);
    const [editor, setEditor] = useState<EditorDraft | null>(null);
    const [saving, setSaving] = useState(false);
    const [editorError, setEditorError] = useState("");
    const [probing, setProbing] = useState<string[]>([]);
    const [probes, setProbes] = useState<Record<string, { tools: McpProbeTool[]; error: string }>>({});

    const patchEditor = (patch: Partial<EditorDraft>) => {
        setEditor((current) => (current ? { ...current, ...patch } : current));
        setEditorError("");
    };

    const persist = async (fallback: string) => {
        try {
            await persistConfig();
        } catch (error) {
            message.error(error instanceof Error ? error.message : fallback);
        }
    };

    const saveEditor = async () => {
        if (!editor) return;
        const problem = validateDraft(editor);
        if (problem) {
            setEditorError(problem);
            return;
        }
        const server = draftToServer(editor);
        const previous = servers.find((item) => item.id === server.id);
        setSaving(true);
        setEditorError("");
        try {
            if (previous) updateMcpServer(server.id, { ...server, enabled: previous.enabled, disabledTools: previous.disabledTools });
            else addMcpServer({ ...server, disabledTools: [] });
            await persistConfig();
            setEditor(null);
            message.success(previous ? "MCP 服务器已更新" : "MCP 服务器已添加");
        } catch (error) {
            setEditorError(error instanceof Error ? error.message : "保存失败，请重试");
        } finally {
            setSaving(false);
        }
    };

    const toggleEnabled = (server: McpServerConfig, enabled: boolean) => {
        updateMcpServer(server.id, { enabled });
        void persist("保存失败，请重试");
    };

    const removeServer = (server: McpServerConfig) => {
        deleteMcpServer(server.id);
        void persist("删除失败，请重试");
    };

    const toggleTool = (serverId: string, toolName: string, disabled: boolean) => {
        setMcpToolDisabled(serverId, toolName, disabled);
        void persist("保存失败，请重试");
    };

    const probeServer = async (server: McpServerConfig) => {
        setProbing((current) => [...current, server.id]);
        setProbes((current) => ({ ...current, [server.id]: { tools: [], error: "" } }));
        try {
            await persistConfig();
            const result = await probeMcpServer(server.id);
            setProbes((current) => ({ ...current, [server.id]: { tools: result.tools, error: "" } }));
        } catch (error) {
            setProbes((current) => ({ ...current, [server.id]: { tools: [], error: mcpProbeFailureText(error) } }));
        } finally {
            setProbing((current) => current.filter((id) => id !== server.id));
        }
    };

    return (
        <>
            <Form layout="vertical" requiredMark={false}>
                <PageHeader
                    title="MCP 工具"
                    actions={(
                        <Button type="primary" className="h-10 flex-1 sm:h-8 sm:flex-none" icon={<Plus className="size-4" />} onClick={() => { setEditorError(""); setEditor(emptyDraft()); }}>
                            添加 MCP 服务器
                        </Button>
                    )}
                />
                <p className="mb-3 text-xs text-foreground/55">{INTRO}</p>
                <McpServerList
                    servers={servers}
                    probing={probing}
                    probes={probes}
                    onToggleEnabled={toggleEnabled}
                    onEdit={(server) => { setEditorError(""); setEditor(draftFromServer(server)); }}
                    onProbe={(server) => void probeServer(server)}
                    onDelete={removeServer}
                    onToggleTool={toggleTool}
                />
            </Form>
            <AppModal
                open={editor !== null}
                title={editor?.id ? "编辑 MCP 服务器" : "添加 MCP 服务器"}
                okText="保存"
                cancelText="取消"
                confirmLoading={saving}
                onOk={() => void saveEditor()}
                onCancel={() => setEditor(null)}
                destroyOnHidden
            >
                {editor ? <McpServerEditorFields draft={editor} error={editorError} onChange={patchEditor} /> : null}
            </AppModal>
        </>
    );
}

export function McpServerEditorFields({ draft, error, onChange }: { draft: EditorDraft; error: string; onChange: (patch: Partial<EditorDraft>) => void }) {
    return (
        <Form layout="vertical" requiredMark={false}>
            <Form.Item label="名称"><Input aria-label="名称" placeholder="例如：我的笔记工具" value={draft.name} onChange={(event) => onChange({ name: event.target.value })} /></Form.Item>
            <Form.Item label="类型">
                <Segmented
                    value={draft.transport}
                    onChange={(value) => onChange({ transport: value as McpTransport })}
                    options={[{ label: TRANSPORT_LABELS.stdio, value: "stdio" }, { label: TRANSPORT_LABELS.http, value: "http" }]}
                />
            </Form.Item>
            {draft.transport === "stdio" ? (
                <>
                    <Form.Item label="命令"><Input aria-label="命令" placeholder="例如：npx" value={draft.command} onChange={(event) => onChange({ command: event.target.value })} /></Form.Item>
                    <Form.Item label="参数（每行一个）"><Input.TextArea aria-label="参数" autoSize={{ minRows: 2, maxRows: 6 }} value={draft.args} onChange={(event) => onChange({ args: event.target.value })} /></Form.Item>
                    <Form.Item label="环境变量"><KeyValueEditor label="环境变量" addLabel="添加环境变量" rows={draft.env} onChange={(rows) => onChange({ env: rows })} /></Form.Item>
                    <p className="text-xs text-foreground/55">本地命令会在这台电脑上运行，只添加你信任的工具。</p>
                </>
            ) : (
                <>
                    <Form.Item label="地址"><Input aria-label="地址" inputMode="url" placeholder="https://example.com/mcp" value={draft.url} onChange={(event) => onChange({ url: event.target.value })} /></Form.Item>
                    <Form.Item label="请求头"><KeyValueEditor label="请求头" addLabel="添加请求头" rows={draft.headers} onChange={(rows) => onChange({ headers: rows })} /></Form.Item>
                </>
            )}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </Form>
    );
}

export function McpServerList({ servers, probing, probes, onToggleEnabled, onEdit, onProbe, onDelete, onToggleTool }: {
    servers: McpServerConfig[];
    probing: string[];
    probes: Record<string, { tools: McpProbeTool[]; error: string }>;
    onToggleEnabled: (server: McpServerConfig, enabled: boolean) => void;
    onEdit: (server: McpServerConfig) => void;
    onProbe: (server: McpServerConfig) => void;
    onDelete: (server: McpServerConfig) => void;
    onToggleTool: (serverId: string, toolName: string, disabled: boolean) => void;
}) {
    if (!servers.length) return <EmptyState title="还没有 MCP 服务器" />;
    return (
        <div className="settings-channel-list space-y-2">
            {servers.map((server) => {
                const probe = probes[server.id];
                return (
                    <section key={server.id} aria-labelledby={`mcp-${server.id}-title`} className="settings-channel p-2.5 sm:p-3">
                        <div className="mb-2.5 flex flex-wrap items-start justify-between gap-2.5">
                            <div className="min-w-0 flex-1 basis-52">
                                <h3 id={`mcp-${server.id}-title`} className="text-sm font-semibold">{server.name || "未命名服务器"}</h3>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground/55">
                                    <span>{TRANSPORT_LABELS[server.transport]}</span>
                                    {!server.enabled ? <span>已停用</span> : null}
                                </div>
                            </div>
                            <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:shrink-0">
                                <Switch aria-label={`${server.name || "未命名服务器"}启用`} checked={server.enabled} onChange={(checked) => onToggleEnabled(server, checked)} />
                                <Button icon={<Pencil className="size-4" />} onClick={() => onEdit(server)}>编辑</Button>
                                <Button icon={<RefreshCw className="size-4" />} loading={probing.includes(server.id)} onClick={() => onProbe(server)}>检测工具</Button>
                                <Popconfirm title="删除这个 MCP 服务器？" okText="删除" cancelText="取消" onConfirm={() => onDelete(server)}>
                                    <Button danger icon={<Trash2 className="size-4" />}>删除</Button>
                                </Popconfirm>
                            </div>
                        </div>
                        {probe ? (
                            <div className="rounded-md border border-border/70 bg-muted/[.1] p-2.5">
                                {probe.error ? <p className="text-xs text-destructive">{probe.error}</p> : null}
                                {!probe.error && probe.tools.length === 0 ? <p className="text-xs text-foreground/55">这个服务器没有返回工具。</p> : null}
                                {probe.tools.length ? (
                                    <div className="space-y-2">
                                        {probe.tools.map((tool) => (
                                            <div key={tool.name} className="flex flex-wrap items-center justify-between gap-2">
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2 text-sm">
                                                        <span className="truncate font-medium text-foreground">{tool.title || tool.name}</span>
                                                        {tool.readOnly ? <Tag color="blue">只读</Tag> : null}
                                                    </div>
                                                    {tool.description ? <p className="mt-0.5 text-xs text-foreground/55">{tool.description}</p> : null}
                                                </div>
                                                <Switch
                                                    aria-label={`${tool.title || tool.name}启用`}
                                                    checked={!(server.disabledTools || []).includes(tool.name)}
                                                    onChange={(checked) => onToggleTool(server.id, tool.name, !checked)}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                    </section>
                );
            })}
        </div>
    );
}
