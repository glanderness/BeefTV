import { useEffect, useState } from "react";
import { App, Button, Input } from "antd";
import { FolderOpen } from "lucide-react";
import { getDesktopAppBinding, type DesktopStorageUsage } from "@/services/desktop-runtime";
import { flushModelConfig, getModelConfigPersistenceState } from "@/services/model-config-repository";
import { saveRemoteUserDataNow } from "@/services/local-workspace-sync";

const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function StorageSettingsPane() {
    const { message, modal } = App.useApp();
    const binding = getDesktopAppBinding();
    const [usage, setUsage] = useState<DesktopStorageUsage>();
    const [target, setTarget] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        let active = true;
        void binding
            ?.StorageSettings?.()
            .then((value) => {
                if (active) setUsage(value);
            })
            .catch(() => {
                if (active) setError("存储信息暂时无法读取，请重试");
            });
        return () => {
            active = false;
        };
    }, [binding]);
    if (!binding?.StorageSettings || !binding.MigrateStorage) return null;
    const choose = async () => {
        try {
            const path = await binding.ChooseStorageDirectory?.();
            if (path) setTarget(path);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    };
    const migrate = async () => {
        setBusy(true);
        setError("");
        try {
            await Promise.all([flushModelConfig(), saveRemoteUserDataNow()]);
            const state = getModelConfigPersistenceState();
            if (state.dirty || state.status === "error") throw new Error("模型配置尚未保存，请先解决保存错误再迁移");
            await binding.MigrateStorage!(target.trim());
            window.location.reload();
        } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
            setBusy(false);
        }
    };
    const cleanup = () =>
        modal.confirm({
            title: "清理原目录",
            centered: true,
            okText: "确认并清理",
            cancelText: "取消",
            content: (
                <p className="break-words">
                    请先确认当前项目、素材和模型配置可以正常使用。清理 {usage?.previousDir} 可释放约 {size(usage?.previousBytes || 0)}；清理后无法从此目录恢复。
                </p>
            ),
            onOk: async () => {
                setBusy(true);
                setError("");
                try {
                    setUsage(await binding.CleanupPreviousStorage!());
                    message.success("原目录已清理");
                } catch (error) {
                    setError(error instanceof Error ? error.message : String(error));
                    throw error;
                } finally {
                    setBusy(false);
                }
            },
        });
    return (
        <section className="settings-section space-y-4" aria-label="本地存储">
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>本地存储</h2>
                    <p>项目、素材和模型配置存放在此处，可迁移到其他磁盘。</p>
                </div>
            </div>
            <div className="space-y-2 text-sm">
                <div className="break-all">当前目录：{usage?.dataDir || "正在读取…"}</div>
                {usage ? (
                    <p className="text-foreground/60">
                        数据占用 {size(usage.usedBytes)} · 磁盘剩余 {size(usage.freeBytes)}
                    </p>
                ) : null}
            </div>
            <label className="block space-y-2">
                <span className="text-sm">新存储目录</span>
                <div className="flex min-w-0 flex-wrap gap-2">
                    <Input className="min-w-0 flex-1" aria-label="新存储目录" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="例如 D:\BeefTV" disabled={busy} />
                    <Button icon={<FolderOpen className="size-4" />} onClick={choose} disabled={busy}>
                        选择文件夹
                    </Button>
                </div>
            </label>
            <p className="text-sm leading-6 text-foreground/60">请选择空文件夹。迁移期间请暂停操作；完成后会重新载入。原目录会保留，请确认项目和素材完整后再清理。</p>
            {error ? (
                <p role="alert" className="text-sm text-destructive break-words">
                    {error}
                </p>
            ) : null}
            <Button type="primary" onClick={migrate} loading={busy} disabled={!usage || !target.trim() || target.trim() === usage.dataDir}>
                {busy ? "正在迁移并校验文件…" : "迁移旧数据并使用新目录"}
            </Button>
            {usage?.previousDir && binding.CleanupPreviousStorage ? (
                <div className="space-y-2 border-t border-border pt-4">
                    <p className="text-sm break-all">原数据仍保留在：{usage.previousDir}</p>
                    <Button danger disabled={busy} onClick={cleanup}>
                        清理原目录，释放磁盘空间
                    </Button>
                </div>
            ) : null}
        </section>
    );
}
