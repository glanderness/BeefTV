import { useEffect, useMemo, useRef, useState } from "react";
import { Select, Switch } from "antd";
import { Pause, Play } from "lucide-react";

import {
    TIMELINE_FPS_OPTIONS,
    TIMELINE_OUTPUT_PRESETS,
    applyOutputPreset,
    getOutputPresetKey,
    resolveEffectiveOutputOptions,
    type TimelineOutputPresetKey,
} from "@/lib/timeline/timeline-output-presets";
import { canvasThemes } from "@/lib/canvas-theme";
import { acquireCanvasVideoSource } from "@/services/canvas-video-source";
import { resolveImageUrl } from "@/services/image-storage";
import { formatTimelineTime, getTimelineClipTitle, getTimelinePreviewPlaceholder } from "@/lib/timeline/timeline-view";
import { rasterizeTimelineSubtitle } from "@/lib/timeline/timeline-subtitle-image";
import { useTimelinePreviewPlayback } from "@/hooks/use-timeline-preview-playback";
import type { TimelineClip, TimelineProject, TimelineTrack } from "@/types/timeline";
import type { CanvasNodeData } from "@/types/canvas";

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

type CanvasTimelinePreviewProps = {
    clips: TimelineClip[];
    tracks?: TimelineTrack[];
    output?: TimelineProject["output"];
    nodes: CanvasNodeData[];
    playheadMs: number;
    playing: boolean;
    theme: CanvasTheme;
    onTogglePlay: () => void;
    onRequestPause: () => void;
    onPlayheadChange: (ms: number) => void;
    onUpdateOutput?: (next: TimelineProject["output"]) => void;
};

const EMPTY_TRACKS: TimelineTrack[] = [];

/**
 * 时间线弹窗的所见即所得预览：显示播放头所在视频或图片片段，并叠加当前字幕。
 * 同一时钟同步视频、静帧与独立音轨；右侧就近提供画幅/帧率/字幕烧录输出规格。
 */
export function CanvasTimelinePreview({
    clips,
    tracks = EMPTY_TRACKS,
    output,
    nodes,
    playheadMs,
    playing,
    theme,
    onTogglePlay,
    onRequestPause,
    onPlayheadChange,
    onUpdateOutput,
}: CanvasTimelinePreviewProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [resolvedVideo, setResolvedVideo] = useState({ key: "", url: "" });
    const [resolvedImage, setResolvedImage] = useState({ key: "", url: "" });
    const [playbackError, setPlaybackError] = useState("");
    const [subtitleImage, setSubtitleImage] = useState<{ key: string; url?: string; error?: string } | null>(null);
    // 复用统一输出规格解析：显式预设直接透传，「自适应首素材」时按首个可见素材尺寸预览，缺省回退 1920×1080。
    const effectiveOutput = useMemo(
        () => resolveEffectiveOutputOptions({ version: 2, tracks, clips, durationMs: 0, output }, nodes),
        [clips, nodes, output, tracks],
    );
    const outputWidth = effectiveOutput.width || 1920;
    const outputHeight = effectiveOutput.height || 1080;
    const visibleTracks = useMemo(() => new Map(tracks.map(track => [track.id, track.visible !== false])), [tracks]);
    const visualClips = useMemo(
        () => clips.filter((clip) => (clip.kind === "video" || clip.kind === "image") && visibleTracks.get(clip.trackId) !== false).sort((a, b) => a.startMs - b.startMs),
        [clips, visibleTracks],
    );
    const activeVisualClip = useMemo(
        () => visualClips.find((clip) => playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs) || null,
        [playheadMs, visualClips],
    );
    const activeVideoClip = activeVisualClip?.kind === "video" ? activeVisualClip : null;
    const activeImageClip = activeVisualClip?.kind === "image" ? activeVisualClip : null;
    const activeSubtitleClip = useMemo(
        () => clips.find((clip) => clip.kind === "subtitle" && visibleTracks.get(clip.trackId) !== false && playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs && Boolean(clip.text?.trim())) || null,
        [clips, playheadMs, visibleTracks],
    );
    const activeNode = useMemo(() => (activeVisualClip ? nodes.find((node) => node.id === activeVisualClip.nodeId) || null : null), [activeVisualClip, nodes]);
    const media = activeVisualClip?.directMedia;
    const storageKey = media ? media.storageKey || "" : activeNode?.metadata?.storageKey || "";
    const fallback = media ? media.url || media.dataUrl || media.content || "" : activeNode?.metadata?.content || "";
    const visualSourceKey = JSON.stringify([activeVisualClip?.id, activeVisualClip?.kind, storageKey, fallback]);
    const videoUrl = activeVideoClip && resolvedVideo.key === visualSourceKey ? resolvedVideo.url : "";
    const imageUrl = activeImageClip && resolvedImage.key === visualSourceKey ? resolvedImage.url : "";
    const subtitleText = output?.burnSubtitles === false ? "" : activeSubtitleClip?.text || "";
    const subtitleKey = JSON.stringify([subtitleText, outputWidth, outputHeight]);

    useEffect(() => {
        if (!subtitleText) return;
        let cancelled = false;
        let url: string | undefined;
        void rasterizeTimelineSubtitle(subtitleText, outputWidth, outputHeight).then((bytes) => {
            if (cancelled) return;
            url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: "image/png" }));
            setSubtitleImage({ key: subtitleKey, url });
        }).catch((error: unknown) => {
            if (!cancelled) setSubtitleImage({ key: subtitleKey, error: error instanceof Error ? error.message : "字幕预览失败" });
        });
        return () => {
            cancelled = true;
            if (url) URL.revokeObjectURL(url);
        };
    }, [subtitleText, subtitleKey, outputWidth, outputHeight]);

    const currentSubtitleImage = subtitleText && subtitleImage?.key === subtitleKey ? subtitleImage : null;
    const previewPlaceholder = getTimelinePreviewPlaceholder({
        hasClip: Boolean(activeVisualClip),
        hasSource: Boolean(storageKey || fallback),
        hasVideoUrl: Boolean(videoUrl || imageUrl),
        failed: Boolean(playbackError),
    });

    useEffect(() => {
        if (!activeVideoClip || (!storageKey && !fallback)) return;
        const controller = new AbortController();
        let release: (() => void) | undefined;
        setPlaybackError("");
        void acquireCanvasVideoSource(storageKey, fallback, controller.signal).then(source => {
            if (controller.signal.aborted) { source.release(); return; }
            release = source.release;
            setResolvedVideo({ key: visualSourceKey, url: source.url });
        }).catch(() => {
            if (!controller.signal.aborted) {
                setPlaybackError("视频预览未能载入，请重新打开剪辑后重试。");
                onRequestPause();
            }
        });
        return () => {
            controller.abort();
            release?.();
        };
    }, [activeVideoClip, storageKey, fallback, visualSourceKey]);

    useEffect(() => {
        if (!activeImageClip || (!storageKey && !fallback)) return;
        let cancelled = false;
        setPlaybackError("");
        void resolveImageUrl(storageKey, fallback).then((url) => {
            if (!cancelled && url) setResolvedImage({ key: visualSourceKey, url });
        }).catch(() => {
            if (!cancelled) setPlaybackError("图片预览未能载入，请检查原素材。");
        });
        return () => { cancelled = true; };
    }, [activeImageClip, storageKey, fallback, visualSourceKey]);

    const { syncVideoMetadata } = useTimelinePreviewPlayback({
        clips,
        tracks,
        nodes,
        playheadMs,
        playing,
        videoRef,
        activeVideoClipId: activeVideoClip?.id || null,
        onPlayheadChange,
        onRequestPause,
        onPlaybackError: setPlaybackError,
    });

    const previewDisplay = useMemo(() => {
        const ratio = outputWidth / outputHeight;
        const inverse = outputHeight / outputWidth;
        return {
            width: `min(100cqw, calc(100cqh * ${ratio}))`,
            height: `min(100cqh, calc(100cqw * ${inverse}))`,
        };
    }, [outputWidth, outputHeight]);

    const presetKey = getOutputPresetKey(output);
    const presetOptions = [
        ...TIMELINE_OUTPUT_PRESETS.map((item) => ({ value: item.key, label: item.label })),
        ...(presetKey === "custom" && output?.width && output?.height
            ? [{ value: "custom" as const, label: `自定义 (${output.width}×${output.height})` }]
            : []),
    ];
    const currentFps = output?.fps ?? 30;
    const fpsOptions = TIMELINE_FPS_OPTIONS.includes(currentFps as (typeof TIMELINE_FPS_OPTIONS)[number])
        ? TIMELINE_FPS_OPTIONS.map((fps) => ({ value: fps, label: `${fps} fps` }))
        : [...TIMELINE_FPS_OPTIONS.map((fps) => ({ value: fps, label: `${fps} fps` })), { value: currentFps, label: `${currentFps} fps` }];
    const burnSubtitles = output?.burnSubtitles !== false;

    return (
        <div className="canvas-timeline-preview flex items-center gap-3 border-b px-4 py-2" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
            <div
                className="canvas-timeline-preview-monitor relative grid shrink-0 place-items-center overflow-hidden rounded-lg bg-black"
                style={{ width: "var(--timeline-preview-w, 300px)", height: "var(--timeline-preview-h, 168px)", containerType: "size" }}
                data-canvas-no-zoom
            >
                {videoUrl && activeVideoClip ? (
                    <div className="relative bg-black" data-timeline-output-frame style={previewDisplay}>
                        <video key={visualSourceKey} ref={videoRef} className="block h-full w-full object-contain" src={videoUrl} playsInline preload="auto" onLoadedMetadata={syncVideoMetadata} />
                        {currentSubtitleImage?.url ? <img className="pointer-events-none absolute inset-0 h-full w-full" src={currentSubtitleImage.url} alt="" data-timeline-subtitle-preview /> : null}
                    </div>
                ) : imageUrl && activeImageClip ? (
                    <div className="relative bg-black" data-timeline-output-frame style={previewDisplay}>
                        <img key={visualSourceKey} className="block h-full w-full object-contain" src={imageUrl} alt={activeImageClip.title || "图片片段"} data-timeline-image-preview />
                        {currentSubtitleImage?.url ? <img className="pointer-events-none absolute inset-0 h-full w-full" src={currentSubtitleImage.url} alt="" data-timeline-subtitle-preview /> : null}
                    </div>
                ) : (
                    <div className="px-4 text-center text-xs text-white/70">{previewPlaceholder}</div>
                )}
                <button
                    type="button"
                    className="absolute inset-0 z-10 grid place-items-center"
                    aria-label={playing ? "暂停预览" : "播放预览"}
                    onClick={(event) => {
                        event.stopPropagation();
                        setPlaybackError("");
                        onTogglePlay();
                    }}
                >
                    <span className="grid size-10 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition hover:scale-105 hover:bg-black/60">
                        {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
                    </span>
                </button>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex items-center gap-2 text-xs leading-[18px]">
                    <span className="truncate font-medium" style={{ color: theme.accent.primary }}>
                        {activeVisualClip ? getTimelineClipTitle(activeVisualClip, nodes) : "无画面片段"}
                    </span>
                    <span className="tabular-nums" style={{ color: theme.node.muted }}>
                        {activeVisualClip ? `${formatTimelineTime(activeVisualClip.startMs)} ~ ${formatTimelineTime(activeVisualClip.startMs + activeVisualClip.durationMs)}` : ""}
                    </span>
                </div>
                <div className="max-h-14 min-h-9 overflow-y-auto rounded-lg border px-2.5 py-1.5 text-xs leading-5" style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}>
                    {activeSubtitleClip ? activeSubtitleClip.text : <span style={{ color: theme.node.muted }}>此处无字幕，点选字幕片段后在下方编辑</span>}
                </div>
                {onUpdateOutput ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs leading-[18px]">
                        <span className="inline-flex items-center gap-1.5">
                            <span className="font-medium" style={{ color: theme.node.muted }}>输出画幅</span>
                            <Select
                                size="small"
                                aria-label="输出画幅"
                                className="min-w-40"
                                value={presetKey}
                                options={presetOptions}
                                onChange={(value: TimelineOutputPresetKey) => {
                                    if (value === "custom") return;
                                    onUpdateOutput(applyOutputPreset(output, value));
                                }}
                            />
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                            <span className="font-medium" style={{ color: theme.node.muted }}>帧率</span>
                            <Select
                                size="small"
                                aria-label="输出帧率"
                                className="w-24"
                                value={currentFps}
                                options={fpsOptions}
                                onChange={(fps: number) => onUpdateOutput({ ...(output || {}), fps })}
                            />
                        </span>
                        <label className="inline-flex cursor-pointer items-center gap-1.5">
                            <Switch
                                size="small"
                                aria-label="烧录字幕"
                                checked={burnSubtitles}
                                onChange={(checked) => onUpdateOutput({ ...(output || {}), burnSubtitles: checked })}
                            />
                            <span className="font-medium" style={{ color: theme.node.muted }}>烧录字幕</span>
                        </label>
                    </div>
                ) : null}
                {currentSubtitleImage?.error ? <div role="alert" className="text-xs">{currentSubtitleImage.error}</div> : null}
                {playbackError ? <div role="alert" className="text-xs">{playbackError}</div> : null}
            </div>
        </div>
    );
}
