import { App, Button, Popover } from "antd";
import { CheckCircle2, CircleAlert, LoaderCircle, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { exportCanvasProjects, exportCanvasProjectsByIds } from "@/lib/canvas/canvas-export";
import { resolveWorkspaceExportCanvasIds } from "@/lib/canvas/canvas-workspace-project";
import { ApiError } from "@/services/api/request";
import { fetchExternalCanvasWrites, subscribeExternalCanvasEvent, undoExternalCanvasWrite, type ExternalCanvasWrite } from "@/services/canvas-external-writes";
import { refreshLocalCanvasProjectIfChanged, syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";
import { loadCanvasProjectForEditing } from "@/services/local-workspace-sync";
import { highlightAssistantNodes } from "./canvas-assistant-highlight";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { canvasSyncProgressKey, useSyncProgressStore, type SyncProjectProgress } from "@/stores/use-sync-progress-store";
import { workspaceCapabilities } from "@/services/workspace-mode";

export type CanvasSyncStatusView = {
    label: string;
    detail: string;
    tone: "saved" | "saving" | "failed";
    action?: "retry-save";
};

/** 顶栏保存状态的文案与可用操作：只说这份画布现在是否已保存、失败时支持重试。 */
export function canvasSyncStatusView(progress: Pick<SyncProjectProgress, "phase" | "message"> | undefined): CanvasSyncStatusView {
    const phase = progress?.phase;
    if (phase === "error") return { label: "保存失败", tone: "failed", detail: "保存没有完成，修改仍保留在本机。", action: "retry-save" };
    if (phase === "pending" || phase === "saving" || phase === "uploading") return { label: "正在保存", tone: "saving", detail: "正在保存到本机。" };
    return { label: "已保存在本地", tone: "saved", detail: "画布已保存在本机。" };
}

function syncStatusIcon(tone: CanvasSyncStatusView["tone"]) {
    if (tone === "saving") return <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />;
    return tone === "failed" ? <CircleAlert className="size-3.5" /> : <CheckCircle2 className="size-3.5 text-emerald-500" />;
}

export function CanvasSyncStatus({ projectId, onOpenVersions }: { projectId: string; onOpenVersions?: () => void }) {
    const { message } = App.useApp();
    const progress = useSyncProgressStore((state) => state.syncingProjects[canvasSyncProgressKey(projectId)]);
    const localOnly = workspaceCapabilities().local;
    const [busy, setBusy] = useState(false);
    const [statusOpen, setStatusOpen] = useState(false);
    const [externalWrites, setExternalWrites] = useState<ExternalCanvasWrite[]>([]);
    const [externalWriteOpen, setExternalWriteOpen] = useState(false);
    const [undoingOpId, setUndoingOpId] = useState<string | null>(null);
    const highlightedOpIdsRef = useRef<Set<string>>(new Set());
    const lastProjectIdRef = useRef<string>(projectId);

    useEffect(() => {
        if (lastProjectIdRef.current !== projectId) {
            lastProjectIdRef.current = projectId;
            setExternalWrites([]);
            setExternalWriteOpen(false);
        }
        if (!localOnly || !projectId) {
            setExternalWrites([]);
            return;
        }
        let cancelled = false;
        const loadWrites = () => {
            void fetchExternalCanvasWrites(projectId)
                .then((items) => {
                    if (cancelled) return;
                    setExternalWrites(items);
                    const latest = items.find((item) => !item.undone);
                    if (latest && !highlightedOpIdsRef.current.has(latest.opId)) {
                        highlightedOpIdsRef.current.add(latest.opId);
                        if (latest.changedNodeIds?.length && typeof document !== "undefined") {
                            highlightAssistantNodes(document.body, latest.changedNodeIds);
                        }
                    }
                })
                .catch(() => {});
        };
        loadWrites();
        const unsubscribe = subscribeExternalCanvasEvent((changedCanvasId) => {
            if (changedCanvasId === projectId) loadWrites();
        });
        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [localOnly, projectId]);

    const latestExternalWrite = externalWrites.find((item) => !item.undone);
    const handleUndoExternalWrite = async (write: ExternalCanvasWrite) => {
        setUndoingOpId(write.opId);
        let restoredNodeIds: string[] = write.changedNodeIds ?? [];
        try {
            try {
                const result = await undoExternalCanvasWrite(projectId, write.opId);
                if (result.restoredNodeIds?.length) {
                    restoredNodeIds = result.restoredNodeIds;
                }
            } catch (error) {
                if (!(error instanceof ApiError && error.reason === "already_undone")) {
                    throw error;
                }
            }
            setExternalWrites((current) =>
                current.map((item) => (item.opId === write.opId ? { ...item, undone: true } : item)),
            );
            setExternalWriteOpen(false);
            message.success(`已撤销 ${write.clientLabel} 的改动`);
            if (write.op === "canvas.create") {
                useCanvasStore.getState().deleteProjects([projectId]);
                if (typeof window !== "undefined") {
                    window.location.assign("/canvas");
                }
                return;
            }
            void refreshLocalCanvasProjectIfChanged(projectId)
                .then(() => {
                    if (restoredNodeIds.length && typeof document !== "undefined") {
                        highlightAssistantNodes(document.body, restoredNodeIds);
                    }
                })
                .catch(() => {});
            void fetchExternalCanvasWrites(projectId)
                .then((refreshed) => setExternalWrites(refreshed))
                .catch(() => {});
        } catch (error) {
            message.error(error instanceof Error && error.message ? error.message : "撤销外部改动失败，请重试");
        } finally {
            setUndoingOpId(null);
        }
    };
    const view = canvasSyncStatusView(progress);
    const label = view.label;
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
            {latestExternalWrite ? (
                <Popover
                    trigger="click"
                    placement="bottom"
                    open={externalWriteOpen}
                    onOpenChange={setExternalWriteOpen}
                    content={
                        <div className="max-w-80 space-y-2.5" data-canvas-no-zoom>
                            <div className="space-y-1">
                                <p className="text-xs font-medium">
                                    外部改动来源：{latestExternalWrite.clientLabel}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {latestExternalWrite.summary}（v{latestExternalWrite.revisionBefore} → v{latestExternalWrite.revisionAfter}）
                                </p>
                                {latestExternalWrite.modifiedNodes?.length ? (
                                    <p className="text-xs text-muted-foreground">
                                        涉及节点：{latestExternalWrite.modifiedNodes.map((node) => node.title || node.id).join("、")}
                                    </p>
                                ) : null}
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {latestExternalWrite.changedNodeIds?.length ? (
                                    <Button
                                        size="small"
                                        onClick={() => {
                                            if (typeof document !== "undefined") {
                                                highlightAssistantNodes(document.body, latestExternalWrite.changedNodeIds);
                                            }
                                        }}
                                    >
                                        定位改动节点
                                    </Button>
                                ) : null}
                                <Button
                                    size="small"
                                    danger
                                    icon={<Undo2 className="size-3.5" />}
                                    loading={undoingOpId === latestExternalWrite.opId}
                                    onClick={() => void handleUndoExternalWrite(latestExternalWrite)}
                                >
                                    撤销此次改动
                                </Button>
                            </div>
                        </div>
                    }
                >
                    <Button
                        size="small"
                        type="text"
                        data-canvas-external-write-op={latestExternalWrite.opId}
                        aria-label={`外部改动：${latestExternalWrite.clientLabel} ${latestExternalWrite.summary}`}
                        icon={<Undo2 className="size-3.5" />}
                    >
                        <span className="canvas-sync-status-label text-xs">
                            外部改动 · {latestExternalWrite.clientLabel}：{latestExternalWrite.summary}
                        </span>
                    </Button>
                </Popover>
            ) : null}
            <Popover
                trigger="click"
                placement="bottom"
                open={statusOpen}
                onOpenChange={setStatusOpen}
                content={
                    <div className="max-w-80 space-y-3" data-canvas-no-zoom>
                        <p role="status" className="text-sm">{view.detail}</p>
                        <div className="flex flex-wrap gap-2">
                            {view.action === "retry-save" ? <Button size="small" type="primary" loading={busy} onClick={() => void run(() => syncLocalCanvasProjectToBackend(projectId))}>重试保存</Button> : null}
                            <Button
                                size="small"
                                disabled={busy}
                                onClick={() =>
                                    void run(async () => {
                                        const store = useCanvasStore.getState();
                                        const project = store.openProject(projectId);
                                        if (project) {
                                            let skippedCount = 0;
                                            const result = await exportCanvasProjects([project], `${project.title}-本地草稿`, {
                                                folders: store.folders,
                                                allowMissingMedia: true,
                                                onSkippedFiles: (missing) => { skippedCount = missing.length; },
                                            });
                                            if (result === "cancelled") return;
                                            if (skippedCount > 0) message.warning(`已导出备份，已自动跳过 ${skippedCount} 个缺失或无法读取的素材`);
                                        }
                                    })
                                }
                            >
                                下载当前内容
                            </Button>
                            <Button
                                size="small"
                                disabled={busy}
                                onClick={() =>
                                    void run(async () => {
                                        const store = useCanvasStore.getState();
                                        const ids = resolveWorkspaceExportCanvasIds(store.projects, [projectId]);
                                        await exportCanvasProjectsByIds(
                                            ids,
                                            async (id) => {
                                                const loaded = await loadCanvasProjectForEditing(id).catch(() => undefined);
                                                if (loaded) return loaded;
                                                const cached = store.openProject(id);
                                                return cached && !cached.summaryOnly ? cached : undefined;
                                            },
                                            {
                                                folders: store.folders,
                                                allowMissingMedia: true,
                                                onSkipped: (count) => message.warning(`已导出备份，已自动跳过 ${count} 个缺失或无法读取的素材`),
                                            },
                                        );
                                    })
                                }
                            >
                                导出整个项目
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
                    danger={view.tone === "failed"}
                    aria-label={`画布保存状态：${label}`}
                    icon={syncStatusIcon(view.tone)}
                >
                    <span className="canvas-sync-status-label text-xs">{label}</span>
                </Button>
            </Popover>
        </>
    );
}
