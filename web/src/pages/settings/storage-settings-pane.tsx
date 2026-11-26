import { useEffect, useState } from "react";
import { App, Button, Input, Switch } from "antd";
import { DetailDrawer } from "@/components/ui/product/app-drawer";
import { StorageRow } from "./storage-layout";
import { ReferenceStoragePane } from "./reference-storage-pane";
import { DepthComponentsPanel } from "@/components/depth-components-panel";
import { Box, FolderOpen, HardDrive } from "lucide-react";
import { getAutoDownloadGeneratedMedia, setAutoDownloadGeneratedMedia } from "@/lib/auto-download-preference";
import { onStorageNamespaceChange } from "@/lib/user-scope";
import { getDesktopAppBinding, type DesktopAutoDownloadSettings, type DesktopStorageUsage } from "@/services/desktop-runtime";
import {
    DEFAULT_CANVAS_DOCUMENT_LIMIT_MB,
    getCanvasDocumentLimitMB,
    readLocalCanvasDocumentLimitMB,
    updateCanvasDocumentLimitMB,
} from "@/services/api/resources";
import { flushModelConfig, getModelConfigPersistenceState } from "@/services/model-config-repository";
import { saveRemoteUserDataNow } from "@/services/local-workspace-sync";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { startOperation } from "@/stores/use-operation-progress";
import { createTransferSampler } from "@/lib/operation-progress";

const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function StorageSettingsPane() {
    const { message, modal } = App.useApp();
    const binding = getDesktopAppBinding();
    const hasNativeStorage = Boolean(binding?.StorageSettings && binding.MigrateStorage);
    const hasNativeAutoDownload = Boolean(
        binding?.AutoDownloadSettings && binding.ChooseAutoDownloadDirectory && binding.SaveAutoDownloadedMedia,
    );
    const [directoryOpen, setDirectoryOpen] = useState(false);
    const [depthOpen, setDepthOpen] = useState(false);
    const [editingLimit, setEditingLimit] = useState(false);
    const [usage, setUsage] = useState<DesktopStorageUsage>();
    const [target, setTarget] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [cleanupInterrupted, setCleanupInterrupted] = useState(false);
    const [savedCanvasLimit, setSavedCanvasLimit] = useState<number>(() => readLocalCanvasDocumentLimitMB());
    const [canvasLimitInput, setCanvasLimitInput] = useState<string>(() => String(readLocalCanvasDocumentLimitMB()));
    const [savingCanvasLimit, setSavingCanvasLimit] = useState(false);
    const [canvasLimitError, setCanvasLimitError] = useState("");
    const [autoDownloadGeneratedMedia, setAutoDownloadGeneratedMediaState] = useState<boolean>(() => getAutoDownloadGeneratedMedia());
    const [autoDownloadSettings, setAutoDownloadSettings] = useState<DesktopAutoDownloadSettings>();
    const [autoDownloadBusy, setAutoDownloadBusy] = useState(false);
    const [autoDownloadError, setAutoDownloadError] = useState("");
    const [errorSummary, ...errorDetails] = error.split("\n\n");
    useEffect(() => onStorageNamespaceChange(() => setAutoDownloadGeneratedMediaState(getAutoDownloadGeneratedMedia())), []);
    useEffect(() => {
        let active = true;
        void getCanvasDocumentLimitMB().then((limitMB) => {
            if (!active) return;
            setSavedCanvasLimit(limitMB);
        });
        if (hasNativeStorage) {
            void binding
                ?.StorageSettings?.()
                .then((value) => {
                    if (active) setUsage(value);
                })
                .catch(() => {
                    if (active) setError("存储信息暂时无法读取，请重试");
                });
        }
        if (hasNativeAutoDownload) {
            void binding
                ?.AutoDownloadSettings?.()
                .then((value) => {
                    if (!active) return;
                    setAutoDownloadSettings(value);
                    setAutoDownloadError("");
                })
                .catch((err) => {
                    if (active) setAutoDownloadError(err instanceof Error ? err.message : "自动下载目录暂时无法读取");
                });
        }
        return () => {
            active = false;
        };
    }, [binding, hasNativeAutoDownload, hasNativeStorage]);

    const applyCanvasLimit = async (rawValue: string) => {
        const trimmed = rawValue.trim();
        const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
        if (!Number.isInteger(parsed) || parsed < 0) {
            const msg = "请输入大于等于 0 的整数（填 0 表示不限制）";
            setCanvasLimitError(msg);
            message.error(msg);
            return;
        }
        setSavingCanvasLimit(true);
        setCanvasLimitError("");
        try {
            const next = await updateCanvasDocumentLimitMB(parsed);
            setSavedCanvasLimit(next);
            setCanvasLimitInput(String(next));
            setEditingLimit(false);
            message.success(next === 0 ? "已设为不限制单画布容量" : `单画布容量上限已设为 ${next} MB`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setCanvasLimitError(msg);
            message.error(msg);
        } finally {
            setSavingCanvasLimit(false);
        }
    };

    const choose = async () => {
        try {
            const path = await binding?.ChooseStorageDirectory?.();
            if (path) setTarget(path);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    };
    const migrate = async () => {
        if (!binding?.MigrateStorage) return;
        setBusy(true);
        setError("");
        let phase = "save_workspace";
        const progress = startOperation("迁移存储目录", { detail: "正在保存工作区" });
        const sample = createTransferSampler();
        let stopped = false;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            try {
                const state = await binding.StorageMigrationStatus?.();
                if (!stopped && state?.phase) progress.update({ ...sample(state.loadedBytes, state.totalBytes), ...state });
            } catch { /* Migration closes the workspace API; Wails polling resumes on the next tick. */ }
            if (!stopped) pollTimer = setTimeout(poll, 500);
        };
        recordDiagnosticEvent({ level: "info", category: "action", code: "storage_migration_started", message: "开始准备存储迁移" });
        try {
            await Promise.all([flushModelConfig(), saveRemoteUserDataNow()]);
            const state = getModelConfigPersistenceState();
            if (state.dirty || state.status === "error") throw new Error("模型配置尚未保存，请先解决保存错误再迁移");
            phase = "migrate_workspace";
            void poll();
            await binding.MigrateStorage(target.trim());
            progress.done("迁移完成，正在重新载入");
            window.location.reload();
        } catch (error) {
            progress.fail("迁移未完成，请查看下方错误详情");
            const details = error instanceof Error ? error.message : String(error);
            recordDiagnosticEvent({ level: "error", category: "action", code: "storage_migration_failed", reason: phase, message: details });
            setError(details);
            setBusy(false);
        } finally {
            stopped = true;
            if (pollTimer) clearTimeout(pollTimer);
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
                if (!binding?.CleanupPreviousStorage) return;
                setBusy(true);
                setError("");
                try {
                    setUsage(await binding.CleanupPreviousStorage());
                    setCleanupInterrupted(false);
                    message.success("原目录已清理");
                } catch (error) {
                    setCleanupInterrupted(true);
                    setError(error instanceof Error ? error.message : String(error));
                    // Cleanup may have removed durable copies while leaving busy scratch.
                    try {
                        if (binding.StorageSettings) setUsage(await binding.StorageSettings());
                    } catch {
                        /* Keep the last known usage. */
                    }
                } finally {
                    setBusy(false);
                }
            },
        });
    const chooseAutoDownloadDir = async () => {
        if (!binding?.ChooseAutoDownloadDirectory || autoDownloadBusy) return;
        setAutoDownloadBusy(true);
        setAutoDownloadError("");
        try {
            const next = await binding.ChooseAutoDownloadDirectory();
            setAutoDownloadSettings(next);
            if (!next.cancelled) message.success("已更新自动下载保存目录");
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setAutoDownloadError(msg);
            message.error(msg);
        } finally {
            setAutoDownloadBusy(false);
        }
    };
    const resetAutoDownloadDir = async () => {
        if (!binding?.ResetAutoDownloadDirectory || autoDownloadBusy) return;
        setAutoDownloadBusy(true);
        setAutoDownloadError("");
        try {
            const next = await binding.ResetAutoDownloadDirectory();
            setAutoDownloadSettings(next);
            message.success("已恢复默认自动下载目录");
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setAutoDownloadError(msg);
            message.error(msg);
        } finally {
            setAutoDownloadBusy(false);
        }
    };
    const openAutoDownloadDir = async () => {
        if (!binding?.OpenAutoDownloadDirectory || autoDownloadBusy) return;
        setAutoDownloadBusy(true);
        try {
            await binding.OpenAutoDownloadDirectory();
        } catch (err) {
            message.error(err instanceof Error ? err.message : String(err));
        } finally {
            setAutoDownloadBusy(false);
        }
    };
    const currentLimit = savedCanvasLimit === 0 ? "不限制" : `${savedCanvasLimit} MB`;
    const errorNotice = error && <div role="alert" className="storage-error">
        <p>{errorSummary}</p>
        {errorDetails.length > 0 && <details><summary>错误详情</summary><p>{errorDetails.join("\n\n")}</p></details>}
    </div>;
    return (
        <div className="storage-settings-sections">
            <section aria-labelledby="storage-local-title">
                <h2 id="storage-local-title">本地存储</h2>
                <div className="storage-list">
                    {hasNativeStorage && <StorageRow name="工作区目录" value={<>
                        <span>{usage?.dataDir || (error ? "无法读取目录" : "正在读取…")}</span>
                        {usage && <small>数据占用 {size(usage.usedBytes)} · 磁盘可用 {size(usage.freeBytes)}</small>}
                        <small>应用内部数据目录；需要取出图片、视频请使用画布批量下载或下方自动下载</small>
                    </>} action={<Button size="small" disabled={busy} onClick={() => setDirectoryOpen(true)}>更改目录</Button>} />}
                    {usage?.previousDir && binding?.CleanupPreviousStorage && <StorageRow name="待清理的原目录"
                        value={<>{usage.previousDir}<small>{cleanupInterrupted ? "原目录可能已部分清理，请保留当前存储目录。" : `可释放约 ${size(usage.previousBytes || 0)}`}</small></>}
                        action={<Button size="small" danger disabled={busy} onClick={cleanup} aria-label="清理原目录，释放磁盘空间">清理</Button>} />}
                    {error && !directoryOpen && errorNotice}
                    <StorageRow name="单画布容量上限" value={editingLimit ? <div className="storage-limit">
                        <Input aria-label="单画布容量上限（MB）" autoFocus inputMode="numeric" suffix="MB" value={canvasLimitInput}
                            onChange={(event) => setCanvasLimitInput(event.target.value)} disabled={savingCanvasLimit}
                            onPressEnter={() => void applyCanvasLimit(canvasLimitInput)} />
                        <Button size="small" disabled={savingCanvasLimit} onClick={() => void applyCanvasLimit("0")}>不限制</Button>
                        <small>当前生效上限：{currentLimit} · 默认 {DEFAULT_CANVAS_DOCUMENT_LIMIT_MB} MB</small>
                        {canvasLimitError && <p role="alert" className="storage-error">{canvasLimitError}</p>}
                    </div> : currentLimit} action={editingLimit ? <>
                        <Button size="small" disabled={savingCanvasLimit} onClick={() => setEditingLimit(false)}>取消</Button>
                        <Button size="small" type="primary" aria-label="保存容量设置" loading={savingCanvasLimit} onClick={() => void applyCanvasLimit(canvasLimitInput)}>保存</Button>
                    </> : <Button size="small" aria-label="编辑单画布容量上限" onClick={() => {
                        setCanvasLimitInput(String(savedCanvasLimit));
                        setCanvasLimitError("");
                        setEditingLimit(true);
                    }}>编辑</Button>} />
                </div>
            </section>
            <section aria-labelledby="storage-files-title">
                <h2 id="storage-files-title">文件与组件</h2>
                <div className="storage-list">
                    <StorageRow name="自动下载生成结果" value={hasNativeAutoDownload ? "生成完成后自动按项目保存图片、视频和音频" : "图片、视频和音频保存到默认下载目录"} action={
                        <Switch checked={autoDownloadGeneratedMedia} aria-label="生成完成后自动下载到本地" onChange={(checked) => {
                            setAutoDownloadGeneratedMedia(checked);
                            setAutoDownloadGeneratedMediaState(checked);
                            message.success(checked ? "已开启生成完成后自动下载" : "已关闭生成完成后自动下载");
                        }} />
                    } />
                    {hasNativeAutoDownload && <StorageRow name="自动下载目录" value={<>
                        <span>{autoDownloadSettings?.directory || (autoDownloadError ? "无法读取目录" : "正在读取…")}</span>
                        {autoDownloadError ? (
                            <small role="alert" className="storage-error">{autoDownloadError}</small>
                        ) : autoDownloadSettings && !autoDownloadSettings.available ? (
                            <small role="alert" className="storage-error">当前目录不可用，请检查磁盘连接或重新选择</small>
                        ) : (
                            <small>{autoDownloadSettings?.customDirectory ? "自定义目录 · 按项目名自动建文件夹" : "默认下载目录 · 按项目名自动建文件夹"}</small>
                        )}
                    </>} action={<>
                        {binding?.OpenAutoDownloadDirectory && <Button size="small" aria-label="打开自动下载目录" disabled={autoDownloadBusy || !autoDownloadSettings?.available} onClick={() => void openAutoDownloadDir()}>打开</Button>}
                        <Button size="small" aria-label="更改自动下载目录" disabled={autoDownloadBusy} onClick={() => void chooseAutoDownloadDir()}>更改</Button>
                        {(autoDownloadSettings?.customDirectory || (!autoDownloadSettings && autoDownloadError)) && binding?.ResetAutoDownloadDirectory && (
                            <Button size="small" aria-label="恢复默认自动下载目录" disabled={autoDownloadBusy} onClick={() => void resetAutoDownloadDir()}>恢复默认</Button>
                        )}
                    </>} />}
                    <ReferenceStoragePane />
                    {binding?.DepthComponentStatus && <DepthComponentsPanel render={(details, status) => <>
                        <StorageRow name="深度捕捉组件" value={status} action={
                            <Button size="small" aria-label="管理深度捕捉组件" onClick={() => setDepthOpen(true)}>管理</Button>
                        } />
                        <DetailDrawer rootClassName="storage-drawer" icon={<Box size={22} />} title="深度捕捉组件" open={depthOpen} onClose={() => setDepthOpen(false)}>{details}</DetailDrawer>
                    </>} />}
                </div>
            </section>
            {hasNativeStorage && <DetailDrawer rootClassName="storage-drawer" icon={<HardDrive size={22} />} title="更改工作区目录"
                open={directoryOpen} busy={busy} onClose={() => { setDirectoryOpen(false); setTarget(""); }}>
                <div className="storage-detail-sections">
                    <section className="storage-detail-card">
                        <h3>当前目录</h3>
                        <p className="storage-detail-path">{usage?.dataDir || "暂时无法读取"}</p>
                    </section>
                    <section className="storage-detail-section">
                        <div className="storage-detail-heading">
                            <label htmlFor="storage-target">新存储目录</label>
                            <Button size="small" icon={<FolderOpen size={15} />} onClick={choose} disabled={busy}>选择文件夹</Button>
                        </div>
                        <Input id="storage-target" value={target} onChange={(event) => setTarget(event.target.value)}
                            placeholder="输入路径或选择空文件夹" disabled={busy} />
                        <p className="storage-detail-note">迁移期间请暂停工作区操作。完成后应用将重新载入，原目录会保留，核对项目和素材后可手动清理。</p>
                        {errorNotice}
                        <div className="storage-buttons">
                            <Button type="primary" onClick={migrate} loading={busy} disabled={!usage || !target.trim() || target.trim() === usage.dataDir}>
                                {busy ? "正在迁移并校验文件…" : "迁移旧数据并使用新目录"}
                            </Button>
                        </div>
                    </section>
                </div>
            </DetailDrawer>}
        </div>
    );
}
