import { App, Button, Dropdown, Popover } from "antd";
import { CheckCircle2, CloudCheck, CloudOff, LoaderCircle, RefreshCw } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { readAllCanvasSyncDrafts, readCanvasSyncDrafts, type CanvasSyncDraft } from "@/services/canvas-sync-drafts";
import { getActiveUserScope } from "@/lib/user-scope";
import { acceptExternalCanvasRevision, pendingExternalCanvasRevision } from "@/services/local-workspace-repository";
import { canvasExternalRevisionVersion, subscribeCanvasExternalRevision, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { canvasSyncProgressKey, useSyncProgressStore } from "@/stores/use-sync-progress-store";
import { workspaceCapabilities } from "@/services/workspace-mode";

export function CanvasSyncStatus({ projectId, onLoadLatest, onOpenVersions }: { projectId: string; onLoadLatest: () => Promise<void>; onOpenVersions?: () => void }) {
    const { message } = App.useApp();
    const progress = useSyncProgressStore((state) => state.syncingProjects[canvasSyncProgressKey(projectId)]);
    const localOnly = workspaceCapabilities().local;
    const [busy, setBusy] = useState(false);
    const [statusOpen, setStatusOpen] = useState(false);
    // 外部改动被本地编辑挡住时必须在顶栏一直看得见：它以前藏在侧边面板里，
    // 面板关着的时候用户根本不知道画布已经在别处变了。
    const externalRevision = useSyncExternalStore(subscribeCanvasExternalRevision, canvasExternalRevisionVersion);
    const externalConflict = pendingExternalCanvasRevision(projectId);
    const [adopting, setAdopting] = useState(false);
    const phase = progress?.phase;
    const conflict = phase === "conflict";
    const failed = phase === "error" || conflict || !phase;
    const saving = phase === "pending" || phase === "saving" || phase === "uploading";
    const label = localOnly ? "已保存在本地" : conflict ? "版本冲突 · 未同步" : !phase ? "尚未同步" : failed ? "云端未保存" : saving ? "正在保存" : "已保存";
    const run = async (operation: () => Promise<unknown>) => {
        setBusy(true);
        try {
            await operation();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "操作失败，请重试");
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            {externalConflict ? (
                <Button
                    size="small"
                    type="text"
                    data-canvas-external-revision={externalRevision}
                    className="canvas-sync-external-notice"
                    loading={adopting}
                    aria-label="画布已在别处更新，使用最新版本"
                    icon={<RefreshCw className="size-3.5" />}
                    onClick={() => {
                        setAdopting(true);
                        void acceptExternalCanvasRevision(projectId)
                            .catch(() => message.error("加载最新版本失败，请重试"))
                            .finally(() => setAdopting(false));
                    }}
                >
                    <span className="canvas-sync-status-label text-xs">画布已在别处更新 · 使用最新版本</span>
                </Button>
            ) : null}
            <Popover
                trigger="click"
                placement="bottom"
                open={statusOpen}
                onOpenChange={setStatusOpen}
                content={
                    <div className="max-w-80 space-y-3" data-canvas-no-zoom>
                        <p role="status" className="text-sm">
                            {localOnly ? "画布已保存在本机。" : progress?.message || (phase === "done" ? "画布已同步到云端" : "尚未确认云端保存，请保留本地内容")}
                        </p>
                        {!localOnly && conflict ? <p className="text-xs text-muted-foreground">此画布的自动提交已暂停。加载最新版前会保留本地草稿，可下载后从画布列表导入为副本。</p> : null}
                        <div className="flex flex-wrap gap-2">
                            {!localOnly ? <Button size="small" loading={busy} onClick={() => void run(onLoadLatest)}>加载云端最新版本</Button> : null}
                            <Button
                                size="small"
                                disabled={busy}
                                onClick={() =>
                                    void run(async () => {
                                        const project = useCanvasStore.getState().openProject(projectId);
                                        if (project) {
                                            const result = await exportCanvasProjects([project], `${project.title}-本地草稿`);
                                            if (result === "cancelled") return;
                                        }
                                    })
                                }
                            >
                                下载当前内容
                            </Button>
                            {onOpenVersions ? (
                                <Button
                                    size="small"
                                    onClick={() => {
                                        setStatusOpen(false);
                                        onOpenVersions();
                                    }}
                                >
                                    版本记录{progress?.draftCount ? ` · ${progress.draftCount} 份草稿` : ""}
                                </Button>
                            ) : null}
                        </div>
                    </div>
                }
            >
                <Button
                    type="text"
                    size="small"
                    danger={!localOnly && failed}
                    aria-label={`画布保存状态：${label}`}
                    icon={localOnly ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : saving ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : failed ? <CloudOff className="size-3.5" /> : <CloudCheck className="size-3.5" />}
                >
                    <span className="canvas-sync-status-label text-xs">{label}</span>
                </Button>
            </Popover>
        </>
    );
}

export function CanvasSyncDraftMenu({ projectId }: { projectId?: string }) {
    const { message } = App.useApp();
    const [drafts, setDrafts] = useState<CanvasSyncDraft[]>([]);
    const [draftScope, setDraftScope] = useState("");
    const [loading, setLoading] = useState(false);
    const [exporting, setExporting] = useState(false);
    return (
        <Dropdown
            trigger={["click"]}
            onOpenChange={(open) => {
                if (!open) return;
                const scope = getActiveUserScope();
                setDraftScope(scope);
                setDrafts([]);
                setLoading(true);
                void (projectId ? readCanvasSyncDrafts(projectId, scope) : readAllCanvasSyncDrafts(scope))
                    .then((items) => {
                        if (getActiveUserScope() === scope) setDrafts(items.reverse());
                    })
                    .catch(() => message.error("读取本地草稿失败"))
                    .finally(() => setLoading(false));
            }}
            menu={{
                items: drafts.length
                    ? drafts.map((draft) => ({
                          key: draft.id,
                          label: `${draft.project.title} · ${new Date(draft.savedAt).toLocaleString()}`,
                          onClick: () => {
                              if (getActiveUserScope() !== draftScope) {
                                  setDrafts([]);
                                  message.error("账号已切换，请重新打开本地草稿");
                                  return;
                              }
                              setExporting(true);
                              void exportCanvasProjects([draft.project], `${draft.project.title}-本地草稿`, { includeLocalDrawings: false })
                                  .then((result) => {
                                      if (result === "saved") message.success("草稿已下载，可从画布列表导入为新画布");
                                  })
                                  .catch(() => message.error("草稿下载失败，请重试"))
                                  .finally(() => setExporting(false));
                          },
                      }))
                    : [{ key: "empty", label: loading ? "正在读取草稿…" : "暂无本地草稿", disabled: true }],
            }}
        >
            <Button size={projectId ? "small" : "middle"} loading={exporting}>
                本地草稿
            </Button>
        </Dropdown>
    );
}
