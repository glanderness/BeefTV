import { useReducedMotion } from "motion/react";
import { Download, LoaderCircle, RotateCcw } from "lucide-react";

import { AppChangelogButton, APP_VERSION } from "@/components/layout/app-changelog-modal";
import { cn } from "@/lib/utils";
import {
    desktopUpdateActionLabel,
    desktopUpdateDetailLabel,
    desktopUpdateProgressLabel,
    desktopUpdateProgressPercent,
    formatDesktopVersionLabel,
    hasResumableDesktopUpdate,
    shouldShowDesktopUpdaterControls,
    userFacingDesktopUpdateError,
    type DesktopUpdateState,
} from "@/services/desktop-update";
import { useDesktopUpdate } from "@/hooks/use-desktop-update";

import "./workspace-sidebar-update.css";

type UpdateStatusLine = { title: string; detail: string; percent: number | null; tone: "active" | "paused" };

function statusLine(state: DesktopUpdateState, persistBusy: boolean, latest: string, percent: number | null): UpdateStatusLine | null {
    if (persistBusy) return { title: "正在保存工作区", detail: "保存完成后开始安装", percent: null, tone: "active" };
    switch (state.status) {
        case "downloading":
            return { title: latest ? `正在下载 ${latest}` : "正在下载更新", detail: desktopUpdateDetailLabel(state), percent: state.downloadedBytes > 0 ? percent : null, tone: "active" };
        case "installing":
            return { title: latest ? `正在安装 ${latest}` : "正在安装更新", detail: "完成后应用会自动重启", percent: null, tone: "active" };
        case "error":
            return hasResumableDesktopUpdate(state)
                ? { title: latest ? `继续下载 ${latest}` : "继续下载", detail: desktopUpdateDetailLabel(state), percent, tone: "paused" }
                : { title: latest ? `重试更新 ${latest}` : "重试更新", detail: desktopUpdateDetailLabel(state), percent: null, tone: "paused" };
        default:
            return null;
    }
}

export function WorkspaceSidebarUpdate({ collapsed }: { collapsed: boolean }) {
    const reducedMotion = useReducedMotion();
    const updater = useDesktopUpdate();
    const { state, persistBusy, actionBusy, runtime } = updater;
    const installed = formatDesktopVersionLabel(state.currentVersion || APP_VERSION);
    const latest = formatDesktopVersionLabel(state.latestVersion);
    const showControls = shouldShowDesktopUpdaterControls(updater.snapshot);
    const busy = persistBusy || actionBusy || state.status === "downloading" || state.status === "installing";
    const percent = desktopUpdateProgressPercent(state);
    const resumable = hasResumableDesktopUpdate(state);
    const actionLabel = persistBusy ? "正在保存" : state.status === "available" ? "下载并安装更新" : desktopUpdateActionLabel(state.status);
    const errorText = state.status === "error" ? userFacingDesktopUpdateError(state.error) : "";
    const updateLabel = state.status === "error" ? `${errorText}，${resumable ? "点击继续下载" : "点击重试"}` : latest ? `${actionLabel} ${latest}` : actionLabel;
    const line = showControls && !collapsed ? statusLine(state, persistBusy, latest, percent) : null;
    const amount = state.totalBytes > 0 ? desktopUpdateProgressLabel(state) : "";
    const tooltip = line ? [line.title, amount, line.detail].filter(Boolean).join("\n") : updateLabel;
    const showBar = state.status === "downloading" || (line?.tone === "paused" && line.percent !== null);
    const lineContent = line ? (
        <>
            <span className="app-workspace-update-status-title">
                {line.tone === "paused" ? <RotateCcw className="app-workspace-update-status-icon" strokeWidth={2} aria-hidden="true" /> : null}
                <span className="app-workspace-update-status-name">{line.title}</span>
                {line.percent !== null ? <span className="app-workspace-update-status-percent">{line.percent}%</span> : null}
            </span>
            {line.detail ? <span className="app-workspace-update-status-detail">{line.detail}</span> : null}
            {showBar ? <UpdateProgressBar state={state} percent={percent} reducedMotion={Boolean(reducedMotion)} paused={line.tone === "paused"} /> : null}
        </>
    ) : null;

    return (
        <div className={cn("app-workspace-update", collapsed && "is-collapsed", line && "has-status")} data-desktop-update-status={state.status} data-desktop-update-runtime={runtime}>
            {line && state.status === "error" ? (
                <button type="button" className="app-workspace-update-status is-paused is-action" onClick={() => void updater.downloadAndInstall()} aria-label={updateLabel} title={tooltip}>
                    {lineContent}
                </button>
            ) : line ? (
                <div className="app-workspace-update-status" title={tooltip}>
                    {lineContent}
                </div>
            ) : (
                <AppChangelogButton className="app-workspace-update-version" showIcon={false} showVersion version={installed} versionClassName="tabular-nums" ariaLabel={installed ? `当前版本 ${installed}，查看更新日志` : "查看更新日志"} />
            )}

            {showControls ? (
                <div className="app-workspace-update-progress" role="status" aria-live="polite">
                    <span className="sr-only">{line && state.status !== "error" ? line.title : updateLabel}</span>
                    {collapsed && showBar ? <UpdateProgressBar state={state} percent={percent} reducedMotion={Boolean(reducedMotion)} paused={state.status === "error"} /> : null}
                    {line && (state.status === "downloading" || state.status === "error") ? null : busy ? (
                        <span className="app-workspace-update-action is-busy" aria-label={actionLabel} title={collapsed ? tooltip : actionLabel}>
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

function UpdateProgressBar({ state, percent, reducedMotion, paused }: { state: DesktopUpdateState; percent: number | null; reducedMotion: boolean; paused: boolean }) {
    return (
        <span
            className={cn("app-workspace-update-progress-bar", paused && "is-paused")}
            role="progressbar"
            aria-label="更新下载进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={desktopUpdateProgressLabel(state)}
        >
            <span style={{ width: `${percent ?? (reducedMotion ? 100 : 32)}%` }} />
        </span>
    );
}
