import { useQuery } from "@tanstack/react-query";
import { App, Button, Input, InputNumber, Popconfirm, Radio, Switch } from "antd";
import { Plus, Plug, RefreshCw, Trash2, X } from "lucide-react";
import { useState } from "react";

import { TableSurface } from "@/components/layout/workspace-page";
import { StatusBadge } from "@/components/ui/base/badges";
import { DetailDrawer } from "@/components/ui/product/app-drawer";
import { createClientId } from "@/lib/client-id";
import {
    deleteAssistantMcpServer,
    listAssistantMcpServers,
    reloadAssistantMcpServers,
    saveAssistantMcpServer,
    testAssistantMcpServer,
    toggleAssistantMcpServer,
    type AssistantMcpRuntimeStatus,
    type AssistantMcpServerView,
    type AssistantMcpTestResult,
    type AssistantMcpTransport,
    type AssistantMcpUpsertInput,
} from "@/services/api/assistant-mcp";
import { isAssistantSettingsUnavailableError } from "@/services/api/assistant-settings";
import { ApiError } from "@/services/api/request";

const ASSISTANT_MCP_QUERY_KEY = ["assistant-mcp-servers"] as const;

type KeyValueDraft = { id: string; key: string; value: string };

type FormDraft = {
    isEdit: boolean;
    name: string;
    transport: AssistantMcpTransport;
    enabled: boolean;
    command: string;
    argsText: string;
    cwd: string;
    url: string;
    timeoutSec: number;
    existingEnvKeys: string[];
    removedEnvKeys: string[];
    newEnv: KeyValueDraft[];
    existingHeaderKeys: string[];
    removedHeaderKeys: string[];
    newHeaders: KeyValueDraft[];
};

function makeEmptyDraft(): FormDraft {
    return {
        isEdit: false,
        name: "",
        transport: "http",
        enabled: true,
        command: "",
        argsText: "",
        cwd: "",
        url: "",
        timeoutSec: 30,
        existingEnvKeys: [],
        removedEnvKeys: [],
        newEnv: [],
        existingHeaderKeys: [],
        removedHeaderKeys: [],
        newHeaders: [],
    };
}

function draftFromServer(server: AssistantMcpServerView): FormDraft {
    return {
        isEdit: true,
        name: server.name,
        transport: server.transport,
        enabled: server.enabled,
        command: server.command || "",
        argsText: (server.args || []).join("\n"),
        cwd: server.cwd || "",
        url: server.url || "",
        timeoutSec: server.timeoutSec || 30,
        existingEnvKeys: server.envKeys || [],
        removedEnvKeys: [],
        newEnv: [],
        existingHeaderKeys: server.headerKeys || [],
        removedHeaderKeys: [],
        newHeaders: [],
    };
}

function parseJsonSnippet(raw: string): AssistantMcpUpsertInput[] {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const container =
        parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers !== null && !Array.isArray(parsed.mcpServers)
            ? (parsed.mcpServers as Record<string, unknown>)
            : parsed;
    if (!container || typeof container !== "object" || Array.isArray(container)) {
        throw new Error("请粘贴包含 mcpServers 对象的 JSON");
    }
    const items: AssistantMcpUpsertInput[] = [];
    for (const [name, entry] of Object.entries(container)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const cfg = entry as Record<string, unknown>;
        const hasUrl = typeof cfg.url === "string" && cfg.url.trim().length > 0;
        const hasCmd = typeof cfg.command === "string" && cfg.command.trim().length > 0;
        const transport: AssistantMcpTransport = hasUrl ? "http" : "stdio";
        if (!hasUrl && !hasCmd) {
            throw new Error(`服务 "${name}" 缺少 url 或 command`);
        }
        const env =
            cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env)
                ? Object.fromEntries(Object.entries(cfg.env as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]))
                : undefined;
        const headers =
            cfg.headers && typeof cfg.headers === "object" && !Array.isArray(cfg.headers)
                ? Object.fromEntries(Object.entries(cfg.headers as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]))
                : undefined;
        items.push({
            name: name.trim(),
            transport,
            enabled: cfg.enabled === false ? false : true,
            ...(transport === "http"
                ? { url: String(cfg.url || "").trim(), headers }
                : {
                    command: String(cfg.command || "").trim(),
                    args: Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : [],
                    cwd: typeof cfg.cwd === "string" ? cfg.cwd.trim() : undefined,
                    env,
                }),
            ...(typeof cfg.timeoutSec === "number" ? { timeoutSec: cfg.timeoutSec } : typeof cfg.timeout === "number" ? { timeoutSec: cfg.timeout } : {}),
        });
    }
    if (items.length === 0) {
        throw new Error("未在 JSON 中找到有效的 MCP 服务配置");
    }
    return items;
}

function serverStatusBadge(server: AssistantMcpServerView, runtimeAvailable: boolean, status?: AssistantMcpRuntimeStatus) {
    if (!server.enabled) return { label: "已停用", tone: "neutral" as const };
    if (!runtimeAvailable) return { label: "打开助手后连接", tone: "neutral" as const };
    if (!status) return { label: "待连接", tone: "neutral" as const };
    if (status.state === "connected") {
        return { label: `已连接 · ${status.toolCount} 个工具`, tone: "success" as const };
    }
    return { label: "连接失败", tone: "error" as const };
}

export function AssistantMcpSection() {
    const { message } = App.useApp();
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [mode, setMode] = useState<"form" | "json">("form");
    const [draft, setDraft] = useState<FormDraft>(makeEmptyDraft);
    const [jsonText, setJsonText] = useState("");
    const [saving, setSaving] = useState(false);
    const [reloading, setReloading] = useState(false);
    const [togglingName, setTogglingName] = useState("");
    const [testingName, setTestingName] = useState("");
    const [deletingName, setDeletingName] = useState("");
    const [testResult, setTestResult] = useState<AssistantMcpTestResult | null>(null);

    const query = useQuery({
        queryKey: ASSISTANT_MCP_QUERY_KEY,
        queryFn: ({ signal }) => listAssistantMcpServers(signal),
        retry: false,
        refetchInterval: 8000,
    });

    if (query.error && (isAssistantSettingsUnavailableError(query.error) || (query.error instanceof ApiError && query.error.status === 404))) {
        return null;
    }

    const servers = query.data?.servers || [];
    const runtimeAvailable = Boolean(query.data?.runtimeAvailable);
    const runtimeMap = query.data?.runtime || {};

    const openCreate = () => {
        setDraft(makeEmptyDraft());
        setMode("form");
        setJsonText("");
        setTestResult(null);
        setDrawerOpen(true);
    };

    const openEdit = (server: AssistantMcpServerView) => {
        setDraft(draftFromServer(server));
        setMode("form");
        setTestResult(null);
        setDrawerOpen(true);
    };

    const handleToggle = async (server: AssistantMcpServerView, enabled: boolean) => {
        setTogglingName(server.name);
        try {
            await toggleAssistantMcpServer(server.name, enabled);
            message.success(enabled ? `已启用 ${server.name}` : `已停用 ${server.name}`);
            await query.refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "切换状态失败");
        } finally {
            setTogglingName("");
        }
    };

    const handleReload = async () => {
        setReloading(true);
        try {
            await reloadAssistantMcpServers();
            message.success("已重新连接外部 MCP");
            await query.refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "重新连接失败");
        } finally {
            setReloading(false);
        }
    };

    const handleTest = async (name: string) => {
        setTestingName(name);
        setTestResult(null);
        try {
            const res = await testAssistantMcpServer(name);
            setTestResult(res);
            if (res.ok) {
                message.success(`${name} 连接成功，发现 ${res.toolCount} 个工具`);
            } else {
                message.error(res.error || `${name} 连接失败`);
            }
            await query.refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "测试连接失败");
        } finally {
            setTestingName("");
        }
    };

    const handleDelete = async (name: string) => {
        setDeletingName(name);
        try {
            await deleteAssistantMcpServer(name);
            message.success(`已删除 ${name}`);
            setDrawerOpen(false);
            await query.refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败");
        } finally {
            setDeletingName("");
        }
    };

    const handleSaveForm = async () => {
        const name = draft.name.trim();
        if (!name) {
            message.error("请填写服务名称");
            return;
        }
        const env: Record<string, string> = {};
        for (const row of draft.newEnv) {
            if (row.key.trim()) env[row.key.trim()] = row.value;
        }
        const headers: Record<string, string> = {};
        for (const row of draft.newHeaders) {
            if (row.key.trim()) headers[row.key.trim()] = row.value;
        }
        const args = draft.argsText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

        const payload: AssistantMcpUpsertInput = {
            name,
            transport: draft.transport,
            enabled: draft.enabled,
            timeoutSec: draft.timeoutSec,
            ...(draft.transport === "http"
                ? {
                    url: draft.url.trim(),
                    ...(Object.keys(headers).length ? { headers } : {}),
                    ...(draft.removedHeaderKeys.length ? { removeHeaders: draft.removedHeaderKeys } : {}),
                }
                : {
                    command: draft.command.trim(),
                    args,
                    cwd: draft.cwd.trim(),
                    ...(Object.keys(env).length ? { env } : {}),
                    ...(draft.removedEnvKeys.length ? { removeEnv: draft.removedEnvKeys } : {}),
                }),
        };

        setSaving(true);
        try {
            await saveAssistantMcpServer(payload);
            message.success(`已保存 ${name}`);
            setDrawerOpen(false);
            await query.refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    };

    const handleImportJson = async () => {
        setSaving(true);
        let importedCount = 0;
        try {
            const items = parseJsonSnippet(jsonText);
            for (const item of items) {
                await saveAssistantMcpServer(item);
                importedCount += 1;
            }
            message.success(`已导入 ${items.length} 个外部 MCP 服务`);
            setDrawerOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "JSON 解析或保存失败");
        } finally {
            setSaving(false);
            if (importedCount > 0) {
                void query.refetch();
            }
        }
    };

    const activeRuntime = draft.isEdit ? runtimeMap[draft.name] : undefined;
    const displayedTools = testResult?.ok ? testResult.tools : activeRuntime?.tools || [];
    const displayedError = testResult && !testResult.ok ? testResult.error : activeRuntime?.error;

    return (
        <section className="agent-external-mcp" aria-labelledby="assistant-external-mcp-heading">
            <div className="agent-external-mcp-header">
                <h2 id="assistant-external-mcp-heading">内置助手外部 MCP</h2>
                <div className="agent-external-mcp-actions">
                    {servers.length > 0 && runtimeAvailable && (
                        <Button size="small" icon={<RefreshCw size={13} />} loading={reloading} onClick={() => void handleReload()}>
                            重新连接
                        </Button>
                    )}
                    <Button size="small" icon={<Plus size={14} />} onClick={openCreate}>
                        添加 MCP
                    </Button>
                </div>
            </div>

            {query.error ? (
                <div role="alert" className="mt-3 text-sm">
                    无法读取外部 MCP 列表。<Button type="link" onClick={() => void query.refetch()}>重试</Button>
                </div>
            ) : (
                <TableSurface>
                    {query.isPending ? (
                        <p className="agent-external-mcp-empty">正在读取外部 MCP 配置…</p>
                    ) : servers.length === 0 ? (
                        <p className="agent-external-mcp-empty">
                            还没有配置外部 MCP。添加后，内置画布助手可按需调用网页搜索、Notion、Figma 等外部工具。
                        </p>
                    ) : (
                    <>
                        <div aria-hidden="true" className="agent-mcp-columns agent-list-head">
                            <span>服务</span>
                            <span>连接状态</span>
                            <span className="agent-action-heading">操作</span>
                        </div>
                        <ul aria-label="内置助手外部 MCP 服务">
                            {servers.map((server) => {
                                const rt = runtimeMap[server.name];
                                const status = serverStatusBadge(server, runtimeAvailable, rt);
                                const subtitle = server.transport === "http"
                                    ? server.url || "HTTP"
                                    : [server.command, ...(server.args || [])].filter(Boolean).join(" ");
                                return (
                                    <li key={server.name} data-assistant-mcp={server.name} className="agent-mcp-columns agent-list-row">
                                        <div className="agent-mcp-name-cell">
                                            <span className="agent-client-name">{server.name}</span>
                                            <span className="agent-mcp-target" title={subtitle}>
                                                {server.transport === "http" ? "HTTP" : "本地命令"} · {subtitle}
                                            </span>
                                            {rt?.state === "error" && rt.error && (
                                                <span className="agent-mcp-error" role="status">{rt.error}</span>
                                            )}
                                        </div>
                                        <StatusBadge {...status} />
                                        <div className="agent-mcp-row-actions">
                                            <Switch
                                                size="small"
                                                checked={server.enabled}
                                                loading={togglingName === server.name}
                                                aria-label={`启用 ${server.name}`}
                                                onChange={(checked) => void handleToggle(server, checked)}
                                            />
                                            <Button
                                                size="small"
                                                autoInsertSpace={false}
                                                onClick={() => openEdit(server)}
                                            >
                                                管理
                                            </Button>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    </>
                )}
                </TableSurface>
            )}

            <DetailDrawer
                open={drawerOpen}
                rootClassName="agent-client-drawer agent-mcp-drawer"
                onClose={() => setDrawerOpen(false)}
                busy={saving || Boolean(testingName) || Boolean(deletingName)}
                title={draft.isEdit ? `管理 ${draft.name}` : "添加外部 MCP"}
                icon={<Plug size={22} />}
            >
                <div className="agent-detail-sections">
                    {!draft.isEdit && (
                        <Radio.Group
                            optionType="button"
                            size="small"
                            value={mode}
                            onChange={(e) => setMode(e.target.value)}
                            options={[
                                { label: "表单填写", value: "form" },
                                { label: "粘贴 JSON 导入", value: "json" },
                            ]}
                        />
                    )}

                    {mode === "json" && !draft.isEdit ? (
                        <div className="agent-mcp-form">
                            <label className="agent-mcp-field">
                                <span>粘贴标准 mcpServers JSON</span>
                                <Input.TextArea
                                    rows={10}
                                    value={jsonText}
                                    onChange={(e) => setJsonText(e.target.value)}
                                    placeholder={'{\n  "mcpServers": {\n    "fetch": {\n      "command": "uvx",\n      "args": ["mcp-server-fetch"]\n    }\n  }\n}'}
                                />
                            </label>
                            <div className="agent-mcp-drawer-footer">
                                <Button type="primary" loading={saving} onClick={() => void handleImportJson()}>
                                    导入并保存
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="agent-mcp-form">
                            <label className="agent-mcp-field">
                                <span>服务名称</span>
                                <Input
                                    value={draft.name}
                                    disabled={draft.isEdit}
                                    placeholder="例如 exa、notion、figma（字母/数字/-/_）"
                                    onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                                />
                            </label>

                            <div className="agent-mcp-field">
                                <span>连接方式</span>
                                <Radio.Group
                                    value={draft.transport}
                                    onChange={(e) => setDraft((prev) => ({ ...prev, transport: e.target.value }))}
                                    options={[
                                        { label: "远程服务 (Streamable HTTP)", value: "http" },
                                        { label: "本地命令 (stdio)", value: "stdio" },
                                    ]}
                                />
                            </div>

                            {draft.transport === "http" ? (
                                <>
                                    <label className="agent-mcp-field">
                                        <span>服务地址</span>
                                        <Input
                                            value={draft.url}
                                            placeholder="https://example.com/mcp"
                                            onChange={(e) => setDraft((prev) => ({ ...prev, url: e.target.value }))}
                                        />
                                    </label>
                                    <div className="agent-mcp-field">
                                        <div className="agent-mcp-field-head">
                                            <span>自定义请求头（加密保存，不回显密文）</span>
                                            <Button
                                                size="small"
                                                type="text"
                                                icon={<Plus size={13} />}
                                                onClick={() => setDraft((prev) => ({
                                                    ...prev,
                                                    newHeaders: [...prev.newHeaders, { id: createClientId(), key: "", value: "" }],
                                                }))}
                                            >
                                                新增
                                            </Button>
                                        </div>
                                        {draft.existingHeaderKeys.filter((k) => !draft.removedHeaderKeys.includes(k)).length > 0 && (
                                            <div className="agent-mcp-secret-tags">
                                                {draft.existingHeaderKeys
                                                    .filter((k) => !draft.removedHeaderKeys.includes(k))
                                                    .map((key) => (
                                                        <span key={key} className="agent-mcp-secret-tag">
                                                            {key}
                                                            <button
                                                                type="button"
                                                                aria-label={`移除请求头 ${key}`}
                                                                onClick={() => setDraft((prev) => ({
                                                                    ...prev,
                                                                    removedHeaderKeys: [...prev.removedHeaderKeys, key],
                                                                }))}
                                                            >
                                                                <X size={12} />
                                                            </button>
                                                        </span>
                                                    ))}
                                            </div>
                                        )}
                                        {draft.newHeaders.map((row) => (
                                            <div key={row.id} className="agent-mcp-kv-row">
                                                <Input
                                                    placeholder="Header 名称，如 Authorization"
                                                    value={row.key}
                                                    onChange={(e) => setDraft((prev) => ({
                                                        ...prev,
                                                        newHeaders: prev.newHeaders.map((item) => item.id === row.id ? { ...item, key: e.target.value } : item),
                                                    }))}
                                                />
                                                <Input.Password
                                                    placeholder="值"
                                                    value={row.value}
                                                    onChange={(e) => setDraft((prev) => ({
                                                        ...prev,
                                                        newHeaders: prev.newHeaders.map((item) => item.id === row.id ? { ...item, value: e.target.value } : item),
                                                    }))}
                                                />
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    aria-label="删除该行"
                                                    icon={<X size={14} />}
                                                    onClick={() => setDraft((prev) => ({
                                                        ...prev,
                                                        newHeaders: prev.newHeaders.filter((item) => item.id !== row.id),
                                                    }))}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </>
                            ) : (
                                <>
                                    <label className="agent-mcp-field">
                                        <span>启动命令</span>
                                        <Input
                                            value={draft.command}
                                            placeholder="例如 npx、uvx、node"
                                            onChange={(e) => setDraft((prev) => ({ ...prev, command: e.target.value }))}
                                        />
                                    </label>
                                    <label className="agent-mcp-field">
                                        <span>命令参数（每行一个参数）</span>
                                        <Input.TextArea
                                            rows={3}
                                            value={draft.argsText}
                                            placeholder={"-y\n@modelcontextprotocol/server-fetch"}
                                            onChange={(e) => setDraft((prev) => ({ ...prev, argsText: e.target.value }))}
                                        />
                                    </label>
                                    <label className="agent-mcp-field">
                                        <span>工作目录（可选）</span>
                                        <Input
                                            value={draft.cwd}
                                            placeholder="留空则使用默认工作区目录"
                                            onChange={(e) => setDraft((prev) => ({ ...prev, cwd: e.target.value }))}
                                        />
                                    </label>
                                    <div className="agent-mcp-field">
                                        <div className="agent-mcp-field-head">
                                            <span>环境变量（加密保存，不回显密文）</span>
                                            <Button
                                                size="small"
                                                type="text"
                                                icon={<Plus size={13} />}
                                                onClick={() => setDraft((prev) => ({
                                                    ...prev,
                                                    newEnv: [...prev.newEnv, { id: createClientId(), key: "", value: "" }],
                                                }))}
                                            >
                                                新增
                                            </Button>
                                        </div>
                                        {draft.existingEnvKeys.filter((k) => !draft.removedEnvKeys.includes(k)).length > 0 && (
                                            <div className="agent-mcp-secret-tags">
                                                {draft.existingEnvKeys
                                                    .filter((k) => !draft.removedEnvKeys.includes(k))
                                                    .map((key) => (
                                                        <span key={key} className="agent-mcp-secret-tag">
                                                            {key}
                                                            <button
                                                                type="button"
                                                                aria-label={`移除环境变量 ${key}`}
                                                                onClick={() => setDraft((prev) => ({
                                                                    ...prev,
                                                                    removedEnvKeys: [...prev.removedEnvKeys, key],
                                                                }))}
                                                            >
                                                                <X size={12} />
                                                            </button>
                                                        </span>
                                                    ))}
                                            </div>
                                        )}
                                        {draft.newEnv.map((row) => (
                                            <div key={row.id} className="agent-mcp-kv-row">
                                                <Input
                                                    placeholder="变量名，如 API_KEY"
                                                    value={row.key}
                                                    onChange={(e) => setDraft((prev) => ({
                                                        ...prev,
                                                        newEnv: prev.newEnv.map((item) => item.id === row.id ? { ...item, key: e.target.value } : item),
                                                    }))}
                                                />
                                                <Input.Password
                                                    placeholder="值"
                                                    value={row.value}
                                                    onChange={(e) => setDraft((prev) => ({
                                                        ...prev,
                                                        newEnv: prev.newEnv.map((item) => item.id === row.id ? { ...item, value: e.target.value } : item),
                                                    }))}
                                                />
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    aria-label="删除该行"
                                                    icon={<X size={14} />}
                                                    onClick={() => setDraft((prev) => ({
                                                        ...prev,
                                                        newEnv: prev.newEnv.filter((item) => item.id !== row.id),
                                                    }))}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </>
                            )}

                            <label className="agent-mcp-field">
                                <span>调用超时（秒）</span>
                                <InputNumber
                                    min={5}
                                    max={300}
                                    value={draft.timeoutSec}
                                    onChange={(val) => setDraft((prev) => ({ ...prev, timeoutSec: Number(val || 30) }))}
                                />
                            </label>

                            {displayedError && (
                                <div role="alert" className="agent-mcp-error-box">
                                    {displayedError}
                                </div>
                            )}

                            {displayedTools.length > 0 && (
                                <section className="agent-detail-card" aria-label="已发现工具">
                                    <div className="agent-section-heading">
                                        <h2>已发现工具（{displayedTools.length}）</h2>
                                    </div>
                                    <ul className="agent-mcp-tool-list">
                                        {displayedTools.map((tool) => (
                                            <li key={tool.toolName}>
                                                <span className="agent-mcp-tool-name">{tool.name}</span>
                                                {tool.description && <span className="agent-mcp-tool-desc">{tool.description}</span>}
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            )}

                            <div className="agent-mcp-drawer-footer">
                                <div className="agent-mcp-drawer-footer-left">
                                    {draft.isEdit && (
                                        <>
                                            <Button
                                                loading={testingName === draft.name}
                                                onClick={() => void handleTest(draft.name)}
                                            >
                                                测试连接
                                            </Button>
                                            <Popconfirm
                                                title={`删除 ${draft.name}？`}
                                                description="删除后，内置助手将不再连接该外部 MCP 服务。"
                                                okText="删除"
                                                cancelText="取消"
                                                okButtonProps={{ danger: true }}
                                                onConfirm={() => handleDelete(draft.name)}
                                            >
                                                <Button danger icon={<Trash2 size={14} />} loading={deletingName === draft.name}>
                                                    删除
                                                </Button>
                                            </Popconfirm>
                                        </>
                                    )}
                                </div>
                                <Button type="primary" loading={saving} onClick={() => void handleSaveForm()}>
                                    保存
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            </DetailDrawer>
        </section>
    );
}
