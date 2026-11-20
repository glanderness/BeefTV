import { useState, type CSSProperties } from "react";
import { ArrowLeft, Check, Clapperboard, Film, Layers } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type CanvasStoryboardShotTarget = {
    rowId: string;
    shotNumber: number;
    summary: string;
    boundCount: number;
};

export type CanvasStoryboardMenuTarget = {
    scriptNodeId: string;
    scriptTitle: string;
    shots: CanvasStoryboardShotTarget[];
};

export function collectCanvasStoryboardTargets(nodes: CanvasNodeData[]): CanvasStoryboardMenuTarget[] {
    return nodes
        .filter((node) => node.type === CanvasNodeType.Script || Boolean(node.metadata?.storyboard))
        .map((node) => {
            const rows = node.metadata?.storyboard?.rows || [];
            return {
                scriptNodeId: node.id,
                scriptTitle: (node.title || "").trim() || "分镜脚本",
                shots: rows.map((row) => ({
                    rowId: row.id,
                    shotNumber: row.shotNumber,
                    summary: (row.plotDescription || row.videoMotionPrompt || row.imageGenerationPrompt || row.dialogue || "").trim(),
                    boundCount: (row.assetBindings || []).length,
                })),
            };
        });
}

export function CanvasStoryboardBindSubmenu({
    targets,
    assetCount,
    onBack,
    onBindShots,
}: {
    targets: CanvasStoryboardMenuTarget[];
    assetCount: number;
    onBack: () => void;
    onBindShots: (scriptNodeId: string, rowIds: string[]) => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const [checkedByScript, setCheckedByScript] = useState<Record<string, string[]>>({});

    const toggleRowCheck = (scriptNodeId: string, rowId: string) => {
        setCheckedByScript((current) => {
            const existing = current[scriptNodeId] || [];
            const next = existing.includes(rowId)
                ? existing.filter((id) => id !== rowId)
                : [...existing, rowId];
            return { ...current, [scriptNodeId]: next };
        });
    };

    return (
        <div className="space-y-1">
            <div className="mb-0.5 flex items-start gap-1 px-1.5 py-1.5">
                <button
                    type="button"
                    onClick={onBack}
                    className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md outline-none hover:bg-black/5 focus-visible:ring-2 dark:hover:bg-white/8"
                    aria-label="返回上一级菜单"
                >
                    <ArrowLeft className="size-3.5" />
                </button>
                <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold">关联至分镜镜头</span>
                    <span className="mt-0.5 block truncate text-[var(--fs-caption)]" style={{ color: theme.node.muted }}>
                        已选 {assetCount} 个素材
                    </span>
                </span>
            </div>

            {targets.map((target) => {
                const checkedIds = checkedByScript[target.scriptNodeId] || [];
                const effectiveBatchIds = checkedIds.length > 0 ? checkedIds : target.shots.map((shot) => shot.rowId);
                return (
                    <div key={target.scriptNodeId} className="space-y-0.5">
                        {targets.length > 1 ? (
                            <div className="flex items-center gap-1.5 px-2 pt-1 text-[var(--fs-caption)] font-medium" style={{ color: theme.node.muted }}>
                                <Clapperboard className="size-3.5 shrink-0" />
                                <span className="truncate">{target.scriptTitle}</span>
                            </div>
                        ) : null}

                        {target.shots.length > 0 ? (
                            <>
                                <button
                                    type="button"
                                    className="flex min-h-9 w-full items-center gap-2 rounded-lg border border-transparent px-1.5 py-1 text-left outline-none hover:border-black/10 hover:bg-black/5 focus-visible:ring-2 dark:hover:border-white/10 dark:hover:bg-white/8"
                                    style={{ color: theme.node.text, "--tw-ring-color": theme.node.muted } as CSSProperties}
                                    onClick={() => onBindShots(target.scriptNodeId, effectiveBatchIds)}
                                >
                                    <span
                                        className="grid size-7 shrink-0 place-items-center rounded-md border"
                                        style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }}
                                    >
                                        <Layers className="size-3.5" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-xs font-medium tabular-nums">
                                            全部选中镜头 ({effectiveBatchIds.length})
                                        </span>
                                        <span className="block truncate text-[var(--fs-caption)]" style={{ color: theme.node.muted }}>
                                            {checkedIds.length > 0 ? "关联到已勾选的镜头" : "关联到该分镜全部镜头"}
                                        </span>
                                    </span>
                                </button>

                                {target.shots.map((shot) => {
                                    const isChecked = checkedIds.includes(shot.rowId);
                                    return (
                                        <div key={shot.rowId} className="flex items-center gap-1">
                                            <button
                                                type="button"
                                                aria-label={`勾选镜 ${shot.shotNumber}`}
                                                aria-pressed={isChecked}
                                                className="grid size-6 shrink-0 place-items-center rounded-md border outline-none transition hover:bg-black/5 focus-visible:ring-2 dark:hover:bg-white/8"
                                                style={{
                                                    borderColor: isChecked ? theme.accent.primary : theme.toolbar.border,
                                                    background: isChecked ? theme.toolbar.activeBg : "transparent",
                                                    color: theme.node.text,
                                                    "--tw-ring-color": theme.node.muted,
                                                } as CSSProperties}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    toggleRowCheck(target.scriptNodeId, shot.rowId);
                                                }}
                                            >
                                                {isChecked ? <Check className="size-3.5" /> : null}
                                            </button>
                                            <button
                                                type="button"
                                                className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-transparent px-1.5 py-1 text-left outline-none hover:border-black/10 hover:bg-black/5 focus-visible:ring-2 dark:hover:border-white/10 dark:hover:bg-white/8"
                                                style={{ color: theme.node.text, "--tw-ring-color": theme.node.muted } as CSSProperties}
                                                onClick={() => onBindShots(target.scriptNodeId, [shot.rowId])}
                                            >
                                                <Film className="size-3.5 shrink-0 opacity-65" />
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-xs font-medium tabular-nums">
                                                        镜 {shot.shotNumber}
                                                        {shot.boundCount > 0 ? ` · 已连 ${shot.boundCount}` : ""}
                                                    </span>
                                                    {shot.summary ? (
                                                        <span className="block truncate text-[var(--fs-caption)]" style={{ color: theme.node.muted }}>
                                                            {shot.summary}
                                                        </span>
                                                    ) : null}
                                                </span>
                                            </button>
                                        </div>
                                    );
                                })}
                            </>
                        ) : (
                            <div className="px-2 py-2 text-[var(--fs-caption)]" style={{ color: theme.node.muted }}>
                                该分镜表暂无镜头，请先添加或生成镜头
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
