import { Button, Input, InputNumber, Progress } from "antd";
import { Captions, Clapperboard, Scissors, Volume2, Wand2 } from "lucide-react";

import type { CanvasTheme } from "@/lib/canvas-theme";
import { MIN_CLIP_DURATION_MS, formatTimelineTime } from "@/lib/timeline/timeline-view";
import type { TimelineClip, TimelineProject } from "@/types/timeline";

export type CanvasTimelineInspectorProps = {
    draft: TimelineProject;
    theme: CanvasTheme;
    durationMs: number;
    exporting: boolean;
    exportPercent: number;
    exportDetail: string;
    finalizingExport: boolean;
    saving: boolean;
    hasRenderableMedia: boolean;
    hasSubtitleTargetNode: boolean;
    selectedSubtitleClip: TimelineClip | null;
    selectedMediaClip: TimelineClip | null;
    onOpenSubtitleDialog?: (nodeId: string) => void;
    onUpdateClip: (clipId: string, patch: Partial<TimelineClip>) => void;
    onUpdateSelectedMediaNumbers: (patch: Partial<TimelineClip>) => void;
    onPreviewSelectedMediaNumbers: (patch: Partial<TimelineClip>) => void;
    onCommitMediaNumberGesture: () => void;
    onSplitClipAtPlayhead: () => void;
    onAbortExport: () => void;
    onExport: () => void;
    onCreateAssembledNode: () => void;
    onClose: () => void;
    onSave: () => void;
};

export function CanvasTimelineInspector({
    draft,
    theme,
    durationMs,
    exporting,
    exportPercent,
    exportDetail,
    finalizingExport,
    saving,
    hasRenderableMedia,
    hasSubtitleTargetNode,
    selectedSubtitleClip,
    selectedMediaClip,
    onOpenSubtitleDialog,
    onUpdateClip,
    onUpdateSelectedMediaNumbers,
    onPreviewSelectedMediaNumbers,
    onCommitMediaNumberGesture,
    onSplitClipAtPlayhead,
    onAbortExport,
    onExport,
    onCreateAssembledNode,
    onClose,
    onSave,
}: CanvasTimelineInspectorProps) {
    const trackLabel = (trackId: string) => draft.tracks.find((track) => track.id === trackId)?.label || trackId;
    const isImageClip = selectedMediaClip?.kind === "image";
    const supportsAudioControls = selectedMediaClip?.kind === "video" || selectedMediaClip?.kind === "audio";

    const selectedMediaRightEdgeMs = selectedMediaClip ? selectedMediaClip.startMs + selectedMediaClip.durationMs : 0;
    const selectedMediaMinStartMs = selectedMediaClip
        ? (selectedMediaClip.sourceStartMs ? Math.max(0, selectedMediaClip.startMs - selectedMediaClip.sourceStartMs) : 0)
        : 0;
    const selectedMediaMaxStartMs = selectedMediaClip
        ? (isImageClip ? 3_600_000 : Math.max(selectedMediaMinStartMs, selectedMediaRightEdgeMs - MIN_CLIP_DURATION_MS))
        : 0;
    const selectedMediaSourceDurationMs = isImageClip ? undefined : selectedMediaClip?.sourceDurationMs;
    const selectedMediaMaxDurationMs = selectedMediaSourceDurationMs !== undefined
        ? Math.max(MIN_CLIP_DURATION_MS, selectedMediaSourceDurationMs)
        : 3_600_000;
    const selectedMediaMaxSourceStartMs = selectedMediaSourceDurationMs !== undefined
        ? Math.max(0, selectedMediaSourceDurationMs - (selectedMediaClip?.durationMs || 0))
        : 3_600_000;

    const volumePercent = Math.round((selectedMediaClip?.volume ?? 1) * 100);
    const fadeInMs = Math.max(0, Math.min(3000, Math.round(selectedMediaClip?.fadeInMs ?? 0)));
    const fadeOutMs = Math.max(0, Math.min(3000, Math.round(selectedMediaClip?.fadeOutMs ?? 0)));

    return (
        <>
            {exporting ? (
                <div className="flex items-center gap-3 border-t px-4 py-2" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                    <div className="min-w-0 flex-1">
                        <Progress percent={exportPercent} size="small" format={() => exportDetail} />
                    </div>
                    <Button size="small" disabled={finalizingExport} onClick={onAbortExport}>
                        取消导出
                    </Button>
                </div>
            ) : null}

            {selectedSubtitleClip ? (
                <div className="border-t px-4 py-2" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                    <div className="mb-1.5 flex items-center gap-2 text-xs leading-[18px]">
                        <span className="font-medium" style={{ color: theme.accent.primary }}>
                            字幕编辑
                        </span>
                        <span style={{ color: theme.node.muted }}>保存后更新工程字幕</span>
                        {onOpenSubtitleDialog && selectedSubtitleClip.nodeId && hasSubtitleTargetNode ? (
                            <Button size="small" className="ml-auto" icon={<Captions className="size-3.5" />} onClick={() => onOpenSubtitleDialog(selectedSubtitleClip.nodeId)}>
                                精细编辑（SRT/高亮/样式）
                            </Button>
                        ) : null}
                    </div>
                    <div className="flex items-start gap-3">
                        <Input.TextArea
                            autoSize={{ minRows: 1, maxRows: 3 }}
                            value={selectedSubtitleClip.text || ""}
                            placeholder="字幕文本"
                            className="flex-1"
                            onChange={(event) => onUpdateClip(selectedSubtitleClip.id, { text: event.target.value })}
                        />
                        <div className="flex shrink-0 items-center gap-1.5 text-xs leading-[18px] tabular-nums">
                            <InputNumber
                                size="small"
                                min={0}
                                step={100}
                                aria-label="字幕起点"
                                value={selectedSubtitleClip.startMs}
                                onChange={(startMs) => onUpdateClip(selectedSubtitleClip.id, { startMs: startMs ?? 0 })}
                                className="w-24"
                            />
                            <span style={{ color: theme.node.muted }}>→</span>
                            <InputNumber
                                size="small"
                                min={0}
                                step={100}
                                aria-label="字幕终点"
                                value={selectedSubtitleClip.startMs + selectedSubtitleClip.durationMs}
                                onChange={(endMs) => onUpdateClip(selectedSubtitleClip.id, { durationMs: Math.max(MIN_CLIP_DURATION_MS, (endMs ?? 0) - selectedSubtitleClip.startMs) })}
                                className="w-24"
                            />
                            <span style={{ color: theme.node.muted }}>毫秒</span>
                        </div>
                    </div>
                </div>
            ) : null}

            {selectedMediaClip ? (
                <div className="border-t px-4 py-1.5" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                    <div className="mb-1 flex items-center gap-2 text-xs leading-[18px]">
                        <span className="font-medium" style={{ color: theme.accent.primary }}>
                            {isImageClip ? "图片片段" : selectedMediaClip.kind === "audio" ? "音频片段" : "视频片段"}
                        </span>
                        <span className="min-w-0 flex-1 truncate" style={{ color: theme.node.muted }}>
                            {selectedMediaClip.title || trackLabel(selectedMediaClip.trackId)}
                        </span>
                        <Button size="small" icon={<Scissors className="size-3.5" />} onClick={onSplitClipAtPlayhead}>
                            在播放头分割
                        </Button>
                    </div>
                    <div className="canvas-timeline-inspector-controls thin-scrollbar flex items-center gap-2 overflow-x-auto whitespace-nowrap text-xs leading-[18px]">
                        <span className="font-medium" style={{ color: theme.node.muted }}>起点</span>
                        <InputNumber
                            size="small"
                            min={selectedMediaMinStartMs}
                            max={selectedMediaMaxStartMs}
                            step={100}
                            aria-label="片段起点"
                            className="w-20 shrink-0"
                            value={selectedMediaClip.startMs}
                            onChange={(value) => onUpdateSelectedMediaNumbers({ startMs: Math.max(selectedMediaMinStartMs, Math.min(selectedMediaMaxStartMs, value ?? selectedMediaClip.startMs)) })}
                        />
                        <span className="font-medium" style={{ color: theme.node.muted }}>时长</span>
                        <InputNumber
                            size="small"
                            min={MIN_CLIP_DURATION_MS}
                            max={selectedMediaMaxDurationMs}
                            step={100}
                            aria-label="片段时长"
                            className="w-20 shrink-0"
                            value={selectedMediaClip.durationMs}
                            onChange={(value) => onUpdateSelectedMediaNumbers({ durationMs: Math.max(MIN_CLIP_DURATION_MS, Math.min(selectedMediaMaxDurationMs, value ?? selectedMediaClip.durationMs)) })}
                        />
                        {supportsAudioControls ? (
                            <>
                                <span className="font-medium" style={{ color: theme.node.muted }}>源内起点</span>
                                <InputNumber
                                    size="small"
                                    min={0}
                                    max={selectedMediaMaxSourceStartMs}
                                    step={100}
                                    aria-label="源内起点"
                                    className="w-20 shrink-0"
                                    value={selectedMediaClip.sourceStartMs ?? 0}
                                    onChange={(value) => onUpdateSelectedMediaNumbers({ sourceStartMs: Math.max(0, Math.min(selectedMediaMaxSourceStartMs, value ?? (selectedMediaClip.sourceStartMs || 0))) })}
                                />
                                <span className="font-medium" style={{ color: theme.node.muted }}>源内结束</span>
                                <span className="tabular-nums" style={{ color: theme.accent.primary }}>
                                    {formatTimelineTime((selectedMediaClip.sourceStartMs || 0) + selectedMediaClip.durationMs)}
                                </span>
                                <span className="inline-flex shrink-0 items-center gap-1.5">
                                    <Volume2 className="size-3.5 shrink-0" style={{ color: theme.node.muted }} aria-hidden="true" />
                                    <span className="font-medium" style={{ color: theme.node.muted }}>音量</span>
                                    <input
                                        type="range"
                                        min={0}
                                        max={200}
                                        step={5}
                                        aria-label="片段音量滑块"
                                        className="h-4 w-20 cursor-pointer accent-[var(--color-primary)]"
                                        value={volumePercent}
                                        onChange={(event) => onPreviewSelectedMediaNumbers({ volume: Math.max(0, Math.min(2, Number(event.target.value) / 100)) })}
                                        onPointerUp={() => onCommitMediaNumberGesture()}
                                        onKeyUp={() => onCommitMediaNumberGesture()}
                                        onBlur={() => onCommitMediaNumberGesture()}
                                    />
                                    <InputNumber
                                        size="small"
                                        min={0}
                                        max={200}
                                        step={5}
                                        aria-label="片段音量"
                                        suffix="%"
                                        className="w-20"
                                        value={volumePercent}
                                        onChange={(val) => onUpdateSelectedMediaNumbers({ volume: Math.max(0, Math.min(2, (val ?? 100) / 100)) })}
                                    />
                                </span>
                                <span className="inline-flex shrink-0 items-center gap-1.5">
                                    <span className="font-medium" style={{ color: theme.node.muted }}>淡入</span>
                                    <InputNumber
                                        size="small"
                                        min={0}
                                        max={3000}
                                        step={100}
                                        aria-label="淡入时长"
                                        suffix="ms"
                                        className="w-24"
                                        value={fadeInMs}
                                        onChange={(val) => onUpdateSelectedMediaNumbers({ fadeInMs: Math.max(0, Math.min(3000, Math.round(val ?? 0))) })}
                                    />
                                </span>
                                <span className="inline-flex shrink-0 items-center gap-1.5">
                                    <span className="font-medium" style={{ color: theme.node.muted }}>淡出</span>
                                    <InputNumber
                                        size="small"
                                        min={0}
                                        max={3000}
                                        step={100}
                                        aria-label="淡出时长"
                                        suffix="ms"
                                        className="w-24"
                                        value={fadeOutMs}
                                        onChange={(val) => onUpdateSelectedMediaNumbers({ fadeOutMs: Math.max(0, Math.min(3000, Math.round(val ?? 0))) })}
                                    />
                                </span>
                            </>
                        ) : (
                            <span style={{ color: theme.node.muted }}>
                                可拖动边缘或输入毫秒时长，自由调整静帧展示时间
                            </span>
                        )}
                    </div>
                </div>
            ) : null}

            <div className="media-editor-footer flex flex-wrap items-center gap-3" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                <span className="text-xs leading-[18px] tabular-nums" style={{ color: theme.node.muted }}>
                    总时长 {formatTimelineTime(durationMs)} · {draft.clips.length} 个片段 · {draft.tracks.length} 条轨道
                </span>
                <div className="ml-auto flex items-center gap-2">
                    <Button size="small" type="primary" icon={<Clapperboard className="size-3.5" />} loading={exporting} disabled={!hasRenderableMedia} onClick={onExport}>
                        导出成片
                    </Button>
                    <Button size="small" icon={<Wand2 className="size-3.5" />} loading={exporting} disabled={!hasRenderableMedia} onClick={onCreateAssembledNode}>
                        生成新片段
                    </Button>
                    <Button size="small" disabled={saving || finalizingExport} onClick={onClose}>
                        取消
                    </Button>
                    <Button size="small" type="primary" loading={saving} disabled={saving || exporting || !draft.clips.length} onClick={onSave}>
                        保存
                    </Button>
                </div>
            </div>
        </>
    );
}
