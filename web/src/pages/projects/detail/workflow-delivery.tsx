import { useMemo } from "react";
import { Button } from "antd";
import { Clock3, Download, Film, Layers3, PackageCheck, Sparkles } from "lucide-react";

import type { ProjectDetail } from "@/services/api/projects";
import { resourceFileUrl } from "@/services/api/resources";
import type { TimelineRenderResult } from "@/services/api/timeline-tasks";

import { MetricCard, StageHeading, formatDuration } from "./workflow-shared";
import { useDeliveryRender } from "./use-delivery-render";

type Props = {
    detail: ProjectDetail;
    projectId: string;
    unitId: string;
    onRefresh: () => Promise<void>;
};

/**
 * 交付阶段：把本章逐镜视频按 `position` 拼成整集成片，并导出 SRT 字幕。
 *
 * 这是短剧工作流的末段。缺镜头时不出片——补黑场会让成片时长与分镜对不上，
 * 且缺片容易被忽略，因此这里只列出缺片并禁用入口。
 */
export function WorkflowDeliveryPanel({ detail, projectId, unitId, onRefresh }: Props) {
    const unit = detail.units.find((item) => item.id === unitId);
    const unitTitle = unit?.title?.trim() || "episode";

    const deliveryStep = useMemo(
        () => (detail.workflows || [])
            .filter((item) => item.instance?.unitId === unitId)
            .flatMap((item) => item.steps || [])
            .find((step) => step.stepKey === "delivery"),
        [detail.workflows, unitId],
    );

    // 成片资源由后端渲染任务写入交付阶段的 outputJson（任务列表不下发 resultJson）。
    const result = useMemo<TimelineRenderResult | undefined>(() => {
        const raw = deliveryStep?.outputJson?.trim();
        if (!raw) return undefined;
        try {
            const parsed = JSON.parse(raw) as TimelineRenderResult;
            return parsed?.resourceId ? parsed : undefined;
        } catch {
            return undefined;
        }
    }, [deliveryStep?.outputJson]);

    const { durationMs, error, issues, phase, progress, readyCount, render, shotCount, statusText } = useDeliveryRender({
        detail,
        projectId,
        unitId,
        deliveryStep,
        onRefresh,
    });

    const staleCount = (detail.shotArtifacts || []).filter((item) => item.unitId === unitId && item.status === "stale").length;

    return (
        <section className="mx-auto max-w-5xl">
            <StageHeading
                eyebrow="06 / 交付与打包"
                title="一键成片"
                description="按镜头顺序拼接本章视频，生成整集 MP4 与 SRT 字幕。所有镜头就绪后才能出片。"
            />

            <div className="mt-6 grid gap-4 sm:grid-cols-3">
                <MetricCard icon={<Film className="size-5" />} label="视频已就绪" value={`${readyCount} / ${shotCount}`} />
                <MetricCard icon={<Clock3 className="size-5" />} label="成片时长" value={formatDuration(durationMs)} />
                <MetricCard icon={<Layers3 className="size-5" />} label="过期产物" value={String(staleCount)} />
            </div>

            <MissingShotsNotice titles={issues.map((issue) => issue.title)} />

            <div className="mt-5 border-y border-border/70 py-5">
                <DeliveryActions
                    result={result}
                    unitTitle={unitTitle}
                    running={phase === "running"}
                    blocked={issues.length > 0 || shotCount === 0}
                    onRender={render}
                />
                <DeliveryRenderProgress running={phase === "running"} progress={progress} statusText={statusText} />
                <FailureNotice error={error} />
            </div>

            <DeliveryResultPreview result={result} />

            <div className="mt-5 border-t border-border/70 pt-5">
                <div className="flex items-start gap-3">
                    <PackageCheck className="mt-0.5 size-5 text-[var(--workspace-accent)]" />
                    <div>
                        <h3 className="text-sm font-semibold">交付包尚未开放</h3>
                        <p className="mt-1 text-xs leading-5 text-foreground/48">
                            成片 MP4 与字幕 SRT 已可导出；分镜 JSON/CSV、资产清单与生成参数 ZIP 需要后端打包任务，待具备后开放。
                        </p>
                    </div>
                </div>
            </div>
        </section>
    );
}

function MissingShotsNotice({ titles }: { titles: string[] }) {
    if (!titles.length) return null;
    return (
        <div className="mt-5 rounded-xl border border-[color-mix(in_srgb,var(--status-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--status-warning)_10%,transparent)] p-4">
            <h3 className="text-sm font-semibold">还有 {titles.length} 个镜头没有可用视频</h3>
            <p className="mt-2 text-xs leading-5 text-foreground/60">{titles.join("、")}</p>
            <p className="mt-1 text-xs leading-5 text-foreground/48">请回到「分镜脚本」或「视频生成」补齐后再来出片。</p>
        </div>
    );
}

function DeliveryActions({ result, unitTitle, running, blocked, onRender }: {
    result?: TimelineRenderResult;
    unitTitle: string;
    running: boolean;
    blocked: boolean;
    onRender: () => Promise<void>;
}) {
    return (
        <div className="flex flex-wrap items-center gap-3">
            <Button type="primary" icon={<Sparkles className="size-4" />} loading={running} disabled={blocked} onClick={() => void onRender()}>
                {result ? "重新生成成片" : "一键成片"}
            </Button>
            <DownloadResources result={result} unitTitle={unitTitle} />
        </div>
    );
}

function DownloadResources({ result, unitTitle }: { result?: TimelineRenderResult; unitTitle: string }) {
    if (!result) return null;
    return (
        <>
            <Button icon={<Download className="size-4" />} onClick={() => void downloadFromResource(result.resourceId, `${unitTitle}.mp4`)}>
                下载成片
            </Button>
            <Button icon={<Download className="size-4" />} disabled={!result.subtitleSrt} onClick={() => downloadText(result.subtitleSrt || "", `${unitTitle}.srt`)}>
                {result.subtitleSrt ? "下载字幕 SRT" : "无字幕（本章镜头未填写对白）"}
            </Button>
        </>
    );
}

function DeliveryRenderProgress({ running, progress, statusText }: { running: boolean; progress: number; statusText: string }) {
    if (!running) return null;
    return (
        <div className="mt-4">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                <div className="h-full rounded-full bg-[var(--workspace-accent)] transition-[width] duration-500" style={{ width: `${Math.max(2, progress)}%` }} />
            </div>
            <p className="mt-2 text-xs text-foreground/55">{statusText || "渲染中…"}{progress ? ` · ${progress}%` : ""}</p>
        </div>
    );
}

function FailureNotice({ error }: { error: string }) {
    if (!error) return null;
    return <p className="mt-3 text-xs leading-5 text-[var(--status-danger)]">成片失败：{error}</p>;
}

function DeliveryResultPreview({ result }: { result?: TimelineRenderResult }) {
    if (!result) return null;
    return (
        <div className="mt-5 rounded-xl border border-border/70 bg-surface p-5">
            <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-medium text-foreground/55">成片预览</span>
                <span className="text-[var(--fs-micro)] text-foreground/42">
                    {result.fileName || "episode.mp4"}{result.durationMs ? ` · ${formatDuration(result.durationMs)}` : ""}
                </span>
            </div>
            <video className="w-full rounded-lg bg-black" src={resourceFileUrl(result.resourceId)} controls preload="metadata" />
        </div>
    );
}

/** 字幕带 BOM，避免部分播放器把中文识别成乱码。 */
function downloadText(text: string, fileName: string) {
    const blob = new Blob(["\uFEFF" + text], { type: "application/x-subrip;charset=utf-8" });
    triggerDownload(URL.createObjectURL(blob), fileName);
}

async function downloadFromResource(resourceId: string, fileName: string) {
    const response = await fetch(resourceFileUrl(resourceId), { credentials: "include" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    triggerDownload(URL.createObjectURL(await response.blob()), fileName);
}

function triggerDownload(url: string, fileName: string) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
}
