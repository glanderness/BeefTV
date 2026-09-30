import { useReducedMotion } from "motion/react";
import { Download, LoaderCircle, RotateCcw } from "lucide-react";

import { AppChangelogButton, APP_VERSION } from "@/components/layout/app-changelog-modal";
import { cn } from "@/lib/utils";
import { desktopUpdateActionLabel, desktopUpdateProgressLabel, desktopUpdateProgressPercent, formatDesktopVersionLabel, shouldShowDesktopUpdaterControls, userFacingDesktopUpdateError } from "@/services/desktop-update";
import { useDesktopUpdate } from "@/hooks/use-desktop-update";

import "./workspace-sidebar-update.css";

export function WorkspaceSidebarUpdate({ collapsed }: { collapsed: boolean }) {
    const reducedMotion = useReducedMotion();
    const updater = useDesktopUpdate();
    const { state, persistBusy, actionBusy, runtime } = updater;
    const installed = formatDesktopVersionLabel(state.currentVersion || APP_VERSION);
    const latest = formatDesktopVersionLabel(state.latestVersion);
    const showControls = shouldShowDesktopUpdaterControls(updater.snapshot);
    const busy = persistBusy || actionBusy || state.status === "downloading" || state.status === "installing";
    const percent = desktopUpdateProgressPercent(state);
    const actionLabel = persistBusy ? "正在保存" : state.status === "available" ? "下载并安装更新" : desktopUpdateActionLabel(state.status);
    const errorText = state.status === "error" ? userFacingDesktopUpdateError(state.error) : "";
    const updateLabel = state.status === "error" ? `${errorText}，点击重试` : latest ? `${actionLabel} ${latest}` : actionLabel;

    return (
        <div className={cn("app-workspace-update", collapsed && "is-collapsed")} data-desktop-update-status={state.status} data-desktop-update-runtime={runtime}>
            <AppChangelogButton className="app-workspace-update-version" showIcon={false} showVersion version={installed} versionClassName="tabular-nums" ariaLabel={installed ? `当前版本 ${installed}，查看更新日志` : "查看更新日志"} />

            {showControls ? (
                <div className="app-workspace-update-progress" role="status" aria-live="polite">
                    <span className="sr-only">{state.status === "downloading" ? `${actionLabel}，${desktopUpdateProgressLabel(state)}` : updateLabel}</span>
                    {state.status === "downloading" ? (
                        <span className="app-workspace-update-progress-bar" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={desktopUpdateProgressLabel(state)}>
                            <span style={{ width: `${percent ?? (reducedMotion ? 100 : 32)}%` }} />
                        </span>
                    ) : null}
                    {busy ? (
                        <span className="app-workspace-update-action is-busy" aria-label={actionLabel} title={actionLabel}>
                            <LoaderCircle className="size-4 animate-spin" strokeWidth={1.8} aria-hidden="true" />
                        </span>
                    ) : (
                        <button type="button" className="app-workspace-update-action" onClick={() => void updater.downloadAndInstall()} aria-label={updateLabel} title={updateLabel}>
                            {state.status === "error" ? <RotateCcw className="size-4" strokeWidth={1.8} aria-hidden="true" /> : <Download className="size-4" strokeWidth={1.8} aria-hidden="true" />}
                        </button>
                    )}
                </div>
            ) : null}
        </div>
    );
}
