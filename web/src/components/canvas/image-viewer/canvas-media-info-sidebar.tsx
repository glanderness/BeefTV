import { Copy, CornerDownLeft, Tags } from "lucide-react";
import type { ReactNode } from "react";

import { useCopyText } from "@/hooks/use-copy-text";
import type { CanvasTheme } from "@/lib/canvas-theme";

type Props = {
    kind: "图片" | "视频";
    testIdPrefix: "canvas-image" | "canvas-video";
    theme: CanvasTheme;
    prompt: string;
    promptChanged?: boolean;
    rows: Array<{ label: string; value: string; changed?: boolean }>;
    headerAction?: ReactNode;
    onRestore?: () => void;
    onOpenNodeInfo?: () => void;
    nodeInfoLabel?: string;
};

export function formatDateTimeExact(iso?: string): string {
    if (!iso) return "未记录";
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return iso;
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function CanvasMediaInfoSidebar({
    kind, testIdPrefix, theme, prompt, promptChanged, rows, headerAction, onRestore, onOpenNodeInfo, nodeInfoLabel = "节点信息",
}: Props) {
    const copyText = useCopyText();
    const railBg = theme.node.panel;
    const insetBg = theme.timeline.trackFill;
    const secondaryInk = theme.node.label;
    return (
        <aside
            aria-label="生成信息面板"
            data-testid={`${testIdPrefix}-info-sidebar`}
            className="flex w-full shrink-0 flex-col max-h-[45%] border-t lg:max-h-none lg:w-[328px] lg:border-l lg:border-t-0"
            style={{ background: railBg, borderColor: theme.toolbar.border, color: theme.node.text }}
        >
            <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4" style={{ borderColor: theme.toolbar.border }}>
                <span className="viewer-heading">生成信息</span>
                {headerAction}
            </div>

            <div
                data-canvas-wheel-scroll
                className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
            >
                <section className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5" style={{ color: secondaryInk }}>
                            完整提示词
                            {promptChanged ? (
                                <span
                                    data-testid={`${testIdPrefix}-prompt-diff-badge`}
                                    className="rounded px-1.5 py-0.5"
                                    style={{ background: theme.accent.warningSoft, color: theme.accent.warningText }}
                                >
                                    有调整
                                </span>
                            ) : null}
                        </span>
                        {prompt ? (
                            <button
                                type="button"
                                data-testid={`${testIdPrefix}-copy-prompt`}
                                className="inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 transition-colors hover:bg-black/6 focus-visible:outline focus-visible:outline-2 dark:hover:bg-white/8"
                                style={{ color: theme.node.text, outlineColor: theme.accent.primary }}
                                onClick={() => copyText(prompt, "提示词已复制")}
                            >
                                <Copy className="size-3.5" />
                                复制
                            </button>
                        ) : null}
                    </div>
                    <div
                        data-testid={`${testIdPrefix}-prompt-box`}
                        className="max-h-56 overflow-y-auto rounded-[var(--r-md)] border px-3 py-2.5 select-text whitespace-pre-wrap break-words"
                        style={{
                            background: insetBg,
                            borderColor: theme.toolbar.border,
                            color: prompt ? theme.node.text : secondaryInk,
                        }}
                    >
                        {prompt || `该${kind}暂无提示词记录`}
                    </div>
                    {onRestore ? (
                        <button
                            type="button"
                            data-testid={`${testIdPrefix}-restore-params`}
                            className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[var(--r-md)] border px-3 transition-colors hover:opacity-90 focus-visible:outline focus-visible:outline-2"
                            style={{
                                background: insetBg,
                                borderColor: theme.node.stroke,
                                color: theme.node.text,
                                outlineColor: theme.accent.primary,
                            }}
                            onClick={onRestore}
                        >
                            <CornerDownLeft className="size-3.5" />
                            回填此版提示词与参数
                        </button>
                    ) : null}
                </section>

                <section className="space-y-2">
                    <div style={{ color: secondaryInk }}>
                        规格明细
                    </div>
                    <dl
                        className="divide-y"
                        style={{
                            borderColor: theme.toolbar.border,
                        }}
                    >
                        {rows.map((row) => (
                            <div
                                key={row.label}
                                className="flex items-start justify-between gap-3 py-2"
                                style={{ borderColor: theme.toolbar.border }}
                            >
                                <dt className="shrink-0" style={{ color: secondaryInk }}>
                                    {row.label}
                                </dt>
                                <dd
                                    className="min-w-0 text-right"
                                    style={{ color: theme.node.text, overflowWrap: "anywhere" }}
                                >
                                    {row.changed ? (
                                        <span className="mr-1.5 inline-block size-1.5 rounded-full bg-amber-500 align-middle" title="与另一对比图不同" />
                                    ) : null}
                                    {row.value}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </section>

                {onOpenNodeInfo ? (
                    <button
                        type="button"
                        data-testid={`${testIdPrefix}-open-node-info`}
                        className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[var(--r-md)] border px-3 transition-colors hover:opacity-90 focus-visible:outline focus-visible:outline-2"
                        style={{
                            background: insetBg,
                            borderColor: theme.toolbar.border,
                            color: theme.node.text,
                            outlineColor: theme.accent.primary,
                        }}
                        onClick={onOpenNodeInfo}
                    >
                        <Tags className="size-3.5" />
                        {nodeInfoLabel}
                    </button>
                ) : null}
            </div>
        </aside>
    );
}
