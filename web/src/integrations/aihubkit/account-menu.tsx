import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Input, Select, Space, Table, Tabs } from "antd";
import { UserRound } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { appQueryClient } from "@/lib/query-client";
import { protocolGroups } from "@/lib/model-protocols";
import { fetchPluginProviderCatalog } from "@/services/api/plugin-catalog";
import { withGenerationConsumersPaused } from "@/services/generation-consumer-lifecycle";
import { commitModelConfig, flushModelConfig, getModelConfigPersistenceState } from "@/services/model-config-repository";
import { flushCanvasStorePersistence } from "@/stores/canvas/use-canvas-store";
import { flushAssetStorePersistence } from "@/stores/use-asset-store";
import { useConfigStore } from "@/stores/use-config-store";
import { hub, setHubSession, type HubModel } from "./api";
import { hubModelProtocol, importHubModels } from "./catalog";
import { useHubSession } from "./gate";

export function HubAccountMenu({ variant = "default", collapsed = false }: { variant?: "default" | "sidebar"; collapsed?: boolean }) {
    const session = useHubSession();
    const [open, setOpen] = useState(false);
    if (!session.enabled) return null;
    return <>
        {variant === "sidebar" ? <button type="button" className={`app-workspace-nav-link group relative isolate flex min-h-11 w-full items-center gap-2 rounded-[var(--r-md)] px-3 py-2 text-[var(--fs-body)] text-foreground/62 transition-[color,transform] duration-200 hover:bg-surface-hover hover:text-foreground${collapsed ? " is-collapsed justify-center" : ""}`} aria-label="aihubkit 账号与额度" title="aihubkit 账号与额度" onClick={() => setOpen(true)}>
            <UserRound className="size-[18px] shrink-0" strokeWidth={1.8} />
            {!collapsed ? <span className="app-workspace-nav-title truncate">aihubkit 账号</span> : null}
        </button> : <Button block type="text" onClick={() => setOpen(true)}>aihubkit 账号与额度</Button>}
        <AppModal title="aihubkit 账号" open={open} onCancel={() => setOpen(false)} footer={null} width={760}>
            {open && <AccountPanel />}
        </AppModal>
    </>;
}

function AccountPanel() {
    const session = useHubSession();
    const { message } = App.useApp();
    const [page, setPage] = useState(1);
    const [tab, setTab] = useState("account");
    const [group, setGroup] = useState(session.user?.group || "");
    const [redemption, setRedemption] = useState("");
    const [models, setModels] = useState<HubModel[]>([]);
    const [selected, setSelected] = useState<React.Key[]>([]);
    const [overrides, setOverrides] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const [error, setError] = useState("");
    const self = useQuery({ queryKey: ["aihubkit", session.scope, "self"], queryFn: hub.self });
    const logs = useQuery({ queryKey: ["aihubkit", session.scope, "logs", page], queryFn: () => hub.logs(page), enabled: tab === "logs" });
    const protocols = useQuery({ queryKey: ["aihubkit", session.scope, "protocols"], queryFn: () => fetchPluginProviderCatalog("user.custom-channel"), enabled: tab === "models" });
    const action = async (operation: () => Promise<void>) => {
        setBusy(true); setError("");
        try { await operation(); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败，请重试"); }
        finally { setBusy(false); }
    };
    const logout = () => action(async () => {
        setLeaving(true);
        try {
            await withGenerationConsumersPaused(async () => {
                await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence(), flushModelConfig()]);
                if (getModelConfigPersistenceState().dirty) throw new Error("模型配置尚未保存，请重试保存后退出");
                await appQueryClient.cancelQueries();
                await hub.logout();
                setHubSession();
                appQueryClient.clear();
                // Reload destroys all old writers before another account can log in.
                window.location.reload();
            });
        } catch (cause) { setLeaving(false); throw cause; }
    });
    return <div className="space-y-4" aria-busy={busy}>
        {(error || self.error || logs.error || protocols.error) && <Alert type="error" showIcon title={error || self.error?.message || logs.error?.message || protocols.error?.message} />}
        <Tabs activeKey={tab} onChange={setTab} items={[
            { key: "account", label: "账号与充值", children: <div className="space-y-4">
                <p>{session.user?.display_name || session.user?.username} · @{session.user?.username}</p>
                <p>可用额度：{self.data ? (self.data.quota / 500000).toFixed(4) : "加载中"}　已用额度：{self.data ? (self.data.used_quota / 500000).toFixed(4) : "—"}</p>
                <Button loading={self.isFetching} disabled={busy} onClick={() => void self.refetch()}>刷新额度</Button>
                <Space.Compact block><Input.Password aria-label="兑换码" placeholder="输入兑换码" value={redemption} onChange={(event) => setRedemption(event.target.value)} disabled={busy} autoComplete="off" />
                    <Button type="primary" disabled={!redemption.trim() || busy} loading={busy} onClick={() => void action(async () => { await hub.topup(redemption.trim()); setRedemption(""); await self.refetch(); void message.success("充值成功"); })}>兑换充值</Button></Space.Compact>
                <Alert type="info" showIcon title="aihubkit 模型所需的本地素材会在生成时自动上传，支持图片、视频和音频，无需配置 S3。" />
                <p className="text-sm text-foreground/60">退出会停止本机任务处理并关闭当前账号工作区。已提交到上游的任务仍可能计费；重新登录同一账号后可继续查看和取回结果。</p>
                <Button danger loading={leaving} disabled={busy} onClick={() => void logout()}>退出登录</Button>
            </div> },
            { key: "models", label: "分组与模型", children: <div className="space-y-4">
                <p className="text-sm text-foreground/60">选择账号允许的分组并导入模型。导入会创建绑定该分组托管凭据的 aihubkit 渠道；缺少接口类型的模型需要手动选择协议。手工配置且已有 API Key 的渠道无需导入，也会自动使用临时文件上传。</p>
                <Space wrap><Select aria-label="模型分组" value={group} className="min-w-48" disabled={busy} onChange={(value) => { setGroup(value); setModels([]); setSelected([]); setOverrides({}); }} options={Object.entries(session.groups || {}).map(([value, entry]) => ({ value, label: `${entry.desc || value} · 倍率 ${entry.ratio}` }))} />
                    <Button loading={busy} disabled={!group} onClick={() => void action(async () => { const catalog = await hub.catalog(group); setModels(catalog); setOverrides({}); setSelected(catalog.filter((model) => hubModelProtocol(model)).map((model) => model.id)); })}>获取模型</Button>
                    <Button type="primary" disabled={busy || selected.length === 0 || !protocols.data} onClick={() => void action(async () => {
                        const config = importHubModels(useConfigStore.getState().config, group, models.filter((model) => selected.includes(model.id)), overrides, protocols.data || []);
                        useConfigStore.getState().replaceConfig(config);
                        await commitModelConfig(config);
                        if (getModelConfigPersistenceState().dirty) throw new Error(getModelConfigPersistenceState().error || "模型配置未保存，请重试");
                        void message.success("模型已导入，可在模型设置中选用");
                    })}>导入所选模型</Button></Space>
                <Table size="small" rowKey="id" dataSource={models} pagination={{ pageSize: 10 }} scroll={{ x: 600 }} rowSelection={{ selectedRowKeys: selected, onChange: setSelected }} columns={[
                    { title: "模型", dataIndex: "id" },
                    { title: "协议", render: (_, model: HubModel) => <Select aria-label={`${model.id} 的协议`} className="min-w-56" disabled={busy} placeholder="请选择接口协议" value={overrides[model.id] || hubModelProtocol(model)} options={protocolGroups(protocols.data || [])} onChange={(value) => setOverrides((current) => ({ ...current, [model.id]: value }))} /> },
                ]} />
            </div> },
            { key: "logs", label: "使用日志", children: <Table size="small" rowKey="id" loading={logs.isFetching} dataSource={logs.data?.items || []} scroll={{ x: 600 }} pagination={{ current: page, pageSize: 10, total: logs.data?.total || 0, showSizeChanger: false, onChange: setPage }} columns={[
                { title: "时间", dataIndex: "created_at", render: (value: number) => new Date(value * 1000).toLocaleString() },
                { title: "模型", dataIndex: "model_name" }, { title: "分组", dataIndex: "group" },
                { title: "费用（额度）", dataIndex: "quota", render: (value: number) => (value / 500000).toFixed(6) },
            ]} /> },
        ]} />
        {leaving && <AppModal open title="正在退出" footer={null} closable={false} maskClosable={false} keyboard={false}><p>正在保存并关闭当前工作区，请等待应用重新加载。</p></AppModal>}
    </div>;
}
