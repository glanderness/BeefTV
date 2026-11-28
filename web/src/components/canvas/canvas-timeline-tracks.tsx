import { Button, Dropdown } from "antd";
import { Tooltip } from "@/components/ui/base/tooltip";
import {
    Eye,
    EyeOff,
    FolderOpen,
    Image as ImageIcon,
    Library,
    Lock,
    LockOpen,
    Maximize2,
    MoreHorizontal,
    Music2,
    Plus,
    Redo2,
    Scissors,
    Trash2,
    Undo2,
    Upload,
    Video,
    Volume2,
    VolumeX,
    ZoomIn,
    ZoomOut,
} from "lucide-react";
import { useState, type DragEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { CanvasTimelineRuler } from "./canvas-timeline-ruler";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { formatTimelineTime } from "@/lib/timeline/timeline-view";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineProject, TimelineTrack } from "@/types/timeline";

export { CanvasTimelineInspector } from "./canvas-timeline-inspector";

export const TRACK_ROW_HEIGHT = 52;
export const TIMELINE_UPLOAD_ACCEPT = ".mp4,.mov,.m4v,.mkv,.webm,.avi,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.png,.jpg,.jpeg,.webp";

function nodeMenuIcon(type: CanvasNodeData["type"]) {
    if (type === "video") return <Video className="size-3.5 shrink-0" />;
    if (type === "image") return <ImageIcon className="size-3.5 shrink-0" />;
    return <Music2 className="size-3.5 shrink-0" />;
}

type CanvasTimelineToolbarProps = {
    theme: CanvasTheme;
    playheadMs: number;
    onResetPlayhead?: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onUndo: () => void;
    onRedo: () => void;
    snapEnabled: boolean;
    onToggleSnap: () => void;
    onZoomOut: () => void;
    onZoomIn: () => void;
    onFitZoom: () => void;
    addGroupCollapsed: boolean;
    addableNodes: CanvasNodeData[];
    onAddNodeToTimeline: (node: CanvasNodeData) => void;
    onOpenAssetLibrary?: () => void;
    onOpenProjectAssets?: () => void;
    onUploadFiles: (files: FileList | null) => void;
    onSplitClipAtPlayhead: () => void;
    selectedClipId: string | null;
    onDeleteSelectedClip: () => void;
    toolbarRef: RefObject<HTMLDivElement | null>;
    moreBtnRef: RefObject<HTMLSpanElement | null>;
    addGroupProbeRef: RefObject<HTMLDivElement | null>;
    uploadInputRef: RefObject<HTMLInputElement | null>;
};

export function CanvasTimelineToolbar({
    theme,
    playheadMs,
    onResetPlayhead,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    snapEnabled,
    onToggleSnap,
    onZoomOut,
    onZoomIn,
    onFitZoom,
    addGroupCollapsed,
    addableNodes,
    onAddNodeToTimeline,
    onOpenAssetLibrary,
    onOpenProjectAssets,
    onUploadFiles,
    onSplitClipAtPlayhead,
    selectedClipId,
    onDeleteSelectedClip,
    toolbarRef,
    moreBtnRef,
    addGroupProbeRef,
    uploadInputRef,
}: CanvasTimelineToolbarProps) {
    return (
        <div ref={toolbarRef} className="canvas-timeline-toolbar media-editor-toolbar flex shrink-0 flex-wrap items-center gap-2" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
            <button
                type="button"
                title="回到时间线起点"
                aria-label={`当前播放头 ${formatTimelineTime(playheadMs)}，点击回到起点`}
                onClick={onResetPlayhead}
                className="min-w-24 rounded-md border px-2 py-1 text-left text-xs font-medium tabular-nums transition hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                style={{ borderColor: theme.toolbar.border, background: theme.node.fill, color: theme.accent.primary }}
            >
                {formatTimelineTime(playheadMs)}
            </button>
            <Tooltip title="撤销（⌘/Ctrl + Z）">
                <Button size="small" aria-label="撤销" disabled={!canUndo} icon={<Undo2 className="size-3.5" />} onClick={onUndo} />
            </Tooltip>
            <Tooltip title="重做（⇧ + ⌘/Ctrl + Z）">
                <Button size="small" aria-label="重做" disabled={!canRedo} icon={<Redo2 className="size-3.5" />} onClick={onRedo} />
            </Tooltip>
            <Tooltip title={snapEnabled ? "关闭吸附" : "开启吸附"}>
                <Button size="small" icon={<Scissors className="size-3.5" />} aria-pressed={snapEnabled} onClick={onToggleSnap}>
                    {snapEnabled ? "吸附开" : "吸附关"}
                </Button>
            </Tooltip>
            <Button size="small" aria-label="缩小时间线" title="缩小时间线" icon={<ZoomOut className="size-3.5" />} onClick={onZoomOut} />
            <Button size="small" aria-label="放大时间线" title="放大时间线" icon={<ZoomIn className="size-3.5" />} onClick={onZoomIn} />
            <Button size="small" icon={<Maximize2 className="size-3.5" />} onClick={onFitZoom}>
                适应
            </Button>
            {addGroupCollapsed ? (
                <Dropdown
                    trigger={["click"]}
                    placement="bottomLeft"
                    menu={{
                        items: [
                            ...(addableNodes.length
                                ? [
                                      {
                                          key: "add",
                                          label: "添加素材",
                                          icon: <Plus className="size-3.5" />,
                                          children: addableNodes.map((item) => ({
                                              key: item.id,
                                              label: (
                                                  <span className="inline-flex max-w-56 items-center gap-2 truncate">
                                                      {nodeMenuIcon(item.type)}
                                                      {item.title || "未命名素材"}
                                                  </span>
                                              ),
                                              onClick: () => onAddNodeToTimeline(item),
                                          })),
                                      },
                                  ]
                                : []),
                            { key: "upload", label: "上传本地", icon: <Upload className="size-3.5" />, onClick: () => uploadInputRef.current?.click() },
                            { key: "library", label: "素材库", icon: <Library className="size-3.5" />, disabled: !onOpenAssetLibrary, onClick: () => onOpenAssetLibrary?.() },
                            { key: "assets", label: "项目资产", icon: <FolderOpen className="size-3.5" />, disabled: !onOpenProjectAssets, onClick: () => onOpenProjectAssets?.() },
                        ],
                    }}
                >
                    <span ref={moreBtnRef}>
                        <Button size="small" icon={<MoreHorizontal className="size-3.5" />}>
                            更多
                        </Button>
                    </span>
                </Dropdown>
            ) : (
                <>
                    <Dropdown
                        trigger={["click"]}
                        placement="bottomLeft"
                        disabled={!addableNodes.length}
                        menu={{
                            items: addableNodes.map((item) => ({
                                key: item.id,
                                label: (
                                    <span className="inline-flex max-w-56 items-center gap-2 truncate">
                                        {nodeMenuIcon(item.type)}
                                        {item.title || "未命名素材"}
                                    </span>
                                ),
                                onClick: () => onAddNodeToTimeline(item),
                            })),
                        }}
                    >
                        <Button size="small" icon={<Plus className="size-3.5" />} disabled={!addableNodes.length}>
                            添加素材
                        </Button>
                    </Dropdown>
                    <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => uploadInputRef.current?.click()}>
                        上传本地
                    </Button>
                    <Button size="small" icon={<Library className="size-3.5" />} disabled={!onOpenAssetLibrary} onClick={() => onOpenAssetLibrary?.()}>
                        素材库
                    </Button>
                    <Button size="small" icon={<FolderOpen className="size-3.5" />} disabled={!onOpenProjectAssets} onClick={() => onOpenProjectAssets?.()}>
                        项目资产
                    </Button>
                </>
            )}
            <div ref={addGroupProbeRef} aria-hidden="true" className="invisible pointer-events-none absolute left-0 top-0 flex items-center gap-2">
                <Dropdown trigger={["click"]} placement="bottomLeft" disabled={!addableNodes.length} menu={{ items: [] }}>
                    <Button size="small" icon={<Plus className="size-3.5" />}>
                        添加素材
                    </Button>
                </Dropdown>
                <Button size="small" icon={<Upload className="size-3.5" />}>
                    上传本地
                </Button>
                <Button size="small" icon={<Library className="size-3.5" />}>
                    素材库
                </Button>
                <Button size="small" icon={<FolderOpen className="size-3.5" />}>
                    项目资产
                </Button>
            </div>
            <input
                ref={uploadInputRef}
                type="file"
                accept={TIMELINE_UPLOAD_ACCEPT}
                multiple
                className="hidden"
                onChange={(event) => {
                    onUploadFiles(event.target.files);
                    event.target.value = "";
                }}
            />
            <Button size="small" icon={<Scissors className="size-3.5" />} onClick={onSplitClipAtPlayhead}>
                分割
            </Button>
            <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedClipId} onClick={onDeleteSelectedClip}>
                删除片段
            </Button>
        </div>
    );
}

type CanvasTimelineTrackAreaProps = {
    draft: TimelineProject;
    theme: CanvasTheme;
    pxPerMs: number;
    durationMs: number;
    playheadMs: number;
    trackWidth: number;
    selectedClipId: string | null;
    trackAreaRef: RefObject<HTMLDivElement | null>;
    scrollRef: RefObject<HTMLDivElement | null>;
    onSeek: (ms: number) => void;
    onClipPointerDown: (event: ReactPointerEvent<HTMLDivElement>, clipId: string, mode: "move" | "trim-start" | "trim-end") => void;
    onClipPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onClipPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onToggleTrackMute: (trackId: string) => void;
    onToggleTrackVisibility: (trackId: string) => void;
    onUploadFiles: (files: FileList | null) => void;
    onTriggerUpload: () => void;
};

export function CanvasTimelineTrackArea({
    draft,
    theme,
    pxPerMs,
    durationMs,
    playheadMs,
    trackWidth,
    selectedClipId,
    trackAreaRef,
    scrollRef,
    onSeek,
    onClipPointerDown,
    onClipPointerMove,
    onClipPointerUp,
    onToggleTrackMute,
    onToggleTrackVisibility,
    onUploadFiles,
    onTriggerUpload,
}: CanvasTimelineTrackAreaProps) {
    const [dragOver, setDragOver] = useState(false);
    const trackLabel = (trackId: string) => draft.tracks.find((track) => track.id === trackId)?.label || trackId;
    const isEmpty = draft.clips.length === 0;

    const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!dragOver) setDragOver(true);
    };

    const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragOver(false);
    };

    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragOver(false);
        if (event.dataTransfer.files?.length) {
            onUploadFiles(event.dataTransfer.files);
        }
    };

    const renderTrackRow = (track: TimelineTrack) => {
        const clips = draft.clips.filter((clip) => clip.trackId === track.id).sort((a, b) => a.startMs - b.startMs);
        const hidden = track.visible === false;
        return (
            <div
                key={track.id}
                data-timeline-track-row={track.id}
                data-track-hidden={hidden ? "true" : "false"}
                data-track-muted={track.muted ? "true" : "false"}
                className={`relative border-b transition-opacity ${hidden ? "opacity-40" : ""}`}
                style={{ height: TRACK_ROW_HEIGHT, borderColor: theme.timeline.trackBorder, background: theme.timeline.trackFill }}
            >
                {clips.map((clip) => {
                    const isSelected = clip.id === selectedClipId;
                    const left = Math.round(clip.startMs * pxPerMs);
                    const width = Math.max(8, Math.round(clip.durationMs * pxPerMs));
                    const isSubtitle = clip.kind === "subtitle";
                    const clipFill = isSubtitle ? theme.timeline.clipSubtitle : clip.kind === "audio" ? theme.timeline.clipAudio : theme.timeline.clipVideo;
                    return (
                        <div
                            key={clip.id}
                            data-timeline-clip-id={clip.id}
                            data-timeline-clip-kind={clip.kind}
                            data-selected={isSelected}
                            data-timeline-clip-node-id={clip.nodeId}
                            className="absolute top-1 flex h-[calc(100%-8px)] cursor-grab touch-none select-none items-center overflow-hidden rounded-md border text-xs leading-none active:cursor-grabbing"
                            style={{
                                left,
                                width,
                                background: isSelected ? theme.accent.primary : clipFill,
                                borderColor: isSelected ? theme.timeline.clipSelectedBorder : theme.timeline.trackBorder,
                                color: isSelected ? theme.accent.onPrimary : theme.node.text,
                            }}
                            onPointerDown={(event) => onClipPointerDown(event, clip.id, "move")}
                            onPointerMove={onClipPointerMove}
                            onPointerUp={onClipPointerUp}
                            onPointerCancel={onClipPointerUp}
                            onClick={(event) => event.stopPropagation()}
                            title={`${clip.title || track.label} · ${formatTimelineTime(clip.startMs)}~${formatTimelineTime(clip.startMs + clip.durationMs)}`}
                        >
                            {!isSubtitle ? (
                                <div
                                    className="absolute bottom-0 left-0 top-0 w-2 cursor-ew-resize touch-none opacity-0 hover:opacity-100"
                                    style={{ background: theme.timeline.handle }}
                                    onPointerDown={(event) => onClipPointerDown(event, clip.id, "trim-start")}
                                />
                            ) : null}
                            <span className="pointer-events-none flex min-w-0 flex-1 items-center gap-1 truncate px-2">
                                {clip.kind === "image" ? <ImageIcon className="size-3 shrink-0 opacity-75" aria-hidden="true" /> : null}
                                <span className="truncate">{clip.title || trackLabel(clip.trackId)}</span>
                            </span>
                            {!isSubtitle ? (
                                <div
                                    className="absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize touch-none opacity-0 hover:opacity-100"
                                    style={{ background: theme.timeline.handle }}
                                    onPointerDown={(event) => onClipPointerDown(event, clip.id, "trim-end")}
                                />
                            ) : null}
                        </div>
                    );
                })}
                <div className="pointer-events-none absolute inset-y-0" style={{ left: Math.round(playheadMs * pxPerMs), width: 2, background: theme.timeline.playhead }} />
            </div>
        );
    };

    const sortedTracks = draft.tracks.slice().sort((a, b) => a.order - b.order);
    return (
        <div
            className="timeline-editor-tracks relative flex min-h-44 flex-1"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <div className="flex w-24 shrink-0 flex-col border-r sm:w-52" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                <div className="shrink-0 border-b" style={{ height: 32, borderColor: theme.toolbar.border }} />
                {sortedTracks.map((track) => {
                    const hidden = track.visible === false;
                    const muted = Boolean(track.muted);
                    const canMute = track.kind === "video" || track.kind === "audio";
                    return (
                        <div key={track.id} className="flex items-center gap-1.5 border-b px-2 sm:px-2.5" style={{ height: TRACK_ROW_HEIGHT, borderColor: theme.toolbar.border }}>
                            <span className="grid size-6 shrink-0 place-items-center rounded-md text-xs font-medium" style={{ background: theme.accent.primarySoft, color: theme.accent.primary }}>
                                {track.kind === "video" ? "V" : track.kind === "audio" ? "A" : track.kind === "image" ? "I" : "S"}
                            </span>
                            <span className={`min-w-0 flex-1 truncate text-xs leading-[18px] ${hidden ? "opacity-45" : ""}`}>{track.label}</span>
                            {canMute ? (
                                <button
                                    type="button"
                                    data-track-mute-toggle={track.id}
                                    aria-label={muted ? `取消静音 ${track.label}` : `静音轨道 ${track.label}`}
                                    aria-pressed={muted}
                                    title={muted ? "取消静音" : "静音轨道"}
                                    onClick={() => onToggleTrackMute(track.id)}
                                    className="grid size-6 shrink-0 place-items-center rounded transition hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                                    style={{
                                        color: muted ? theme.accent.primary : theme.node.muted,
                                        background: muted ? theme.accent.primarySoft : "transparent",
                                    }}
                                >
                                    {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
                                </button>
                            ) : null}
                            <button
                                type="button"
                                data-track-visibility-toggle={track.id}
                                aria-label={hidden ? `显示轨道 ${track.label}` : `隐藏轨道 ${track.label}`}
                                aria-pressed={hidden}
                                title={hidden ? "显示轨道" : "隐藏轨道"}
                                onClick={() => onToggleTrackVisibility(track.id)}
                                className="grid size-6 shrink-0 place-items-center rounded transition hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                                style={{
                                    color: hidden ? theme.accent.primary : theme.node.muted,
                                    background: hidden ? theme.accent.primarySoft : "transparent",
                                }}
                            >
                                {hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                            </button>
                            {track.locked ? <Lock className="size-3 shrink-0 opacity-45" aria-hidden="true" /> : <LockOpen className="size-3 shrink-0 opacity-30" aria-hidden="true" />}
                        </div>
                    );
                })}
            </div>

            <div ref={trackAreaRef} className="thin-scrollbar relative min-w-0 flex-1 overflow-auto" data-canvas-no-zoom>
                <div ref={scrollRef} style={{ width: trackWidth }} className="min-h-full">
                    <CanvasTimelineRuler pxPerMs={pxPerMs} durationMs={durationMs} playheadMs={playheadMs} width={trackWidth} theme={theme} scrollContainerRef={trackAreaRef} onSeek={onSeek} />
                    {sortedTracks.map((track) => renderTrackRow(track))}
                </div>
                {isEmpty ? (
                    <div
                        data-timeline-empty-state
                        className="pointer-events-none absolute inset-x-0 bottom-0 top-8 flex items-center justify-center px-4"
                    >
                        <div
                            className="pointer-events-auto flex flex-col items-center gap-2 rounded-xl border border-dashed px-5 py-4 text-center"
                            style={{
                                borderColor: dragOver ? theme.accent.primary : theme.toolbar.border,
                                background: theme.toolbar.panel,
                                color: theme.node.text,
                            }}
                        >
                            <div className="text-[13px] font-medium leading-5">拖入或上传本地视频、音频、图片开始剪辑</div>
                            <div className="text-xs leading-[18px]" style={{ color: theme.node.muted }}>
                                支持 MP4 / MOV / MKV / WebM、MP3 / WAV / M4A / FLAC 与 PNG / JPG / WebP
                            </div>
                            <Button size="small" type="primary" icon={<Upload className="size-3.5" />} onClick={onTriggerUpload}>
                                上传本地素材
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
