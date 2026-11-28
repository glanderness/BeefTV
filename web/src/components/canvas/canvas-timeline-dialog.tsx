import "./canvas-media-editors.css";
import { App } from "antd";
import { AppModal } from "@/components/ui/product/app-modal";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { ArrowLeft, Clapperboard } from "lucide-react";

import { downloadOwnedOrBrowserMedia, saveOwnedOrBrowserVideoBlob } from "@/services/desktop-media-save";
import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { buildTimelineFromNodes, isNodeInTimeline, syncTimelineSubtitleClips } from "@/lib/timeline/timeline-build";
import { findNearestAvailablePlacement } from "@/lib/timeline/timeline-placement";
import { DEFAULT_AUDIO_TRACK_ID, DEFAULT_VIDEO_TRACK_ID, getVisualTracks, normalizeTimelineProject } from "@/lib/timeline/timeline-tracks";
import { MIN_CLIP_DURATION_MS, getFitTimelineZoom, getTimelineTrackWidth, zoomIn, zoomOut } from "@/lib/timeline/timeline-view";
import { getVisibleMediaClips } from "@/lib/timeline/timeline-to-ffmpeg";
import type { CanvasNodeData } from "@/types/canvas";
import type { SrtEntry, TimelineClip, TimelineDirectMedia, TimelineProject } from "@/types/timeline";

import { executeTimelineRender, type TimelineRenderOutcome } from "./canvas-timeline-export";
import { CanvasTimelineInspector } from "./canvas-timeline-inspector";
import { CanvasTimelinePreview } from "./canvas-timeline-preview";
import { CanvasTimelineToolbar, CanvasTimelineTrackArea } from "./canvas-timeline-tracks";
import { useTimelineClipDrag } from "./use-timeline-clip-drag";
import { useTimelineDraftHistory } from "./use-timeline-draft-history";

const BASE_PX_PER_SECOND = 96;
const DEFAULT_IMAGE_CLIP_DURATION_MS = 3_000;

export type AssembledResourceNodeInput = {
    resourceId: string;
    title: string;
    durationMs?: number;
    width?: number;
    height?: number;
    size?: number;
    mimeType?: string;
};

type CanvasTimelineDialogProps = {
    projectId?: string;
    node?: CanvasNodeData | null;
    open: boolean;
    nodes: CanvasNodeData[];
    timeline: TimelineProject | null;
    onClose: () => void;
    onOpenSubtitleDialog?: (nodeId: string) => void;
    onSave: (timeline: TimelineProject) => void | Promise<void>;
    onSaveSubtitles: (nodeId: string, entries: SrtEntry[]) => void;
    onOpenAssetLibrary?: () => void;
    onOpenProjectAssets?: () => void;
    onUploadLocalFiles: (files: File[]) => Promise<TimelineDirectMedia[]>;
    addNodeToTimelineRef?: MutableRefObject<((node: CanvasNodeData) => void) | null>;
    addMediaToTimelineRef?: MutableRefObject<((media: TimelineDirectMedia) => void) | null>;
    onCreateAssembledNode: (blob: Blob, title: string) => Promise<CanvasNodeData | null>;
    onCreateAssembledNodeFromResource?: (input: AssembledResourceNodeInput) => Promise<CanvasNodeData | null>;
};

export async function runTimelineDialogSaveAttempt(save: () => Promise<void>, close: () => void) {
    try {
        await save();
        close();
        return undefined;
    } catch (error) {
        return error;
    }
}

export function CanvasTimelineDialog({
    projectId,
    node = null,
    open,
    nodes,
    timeline,
    onClose,
    onOpenSubtitleDialog,
    onSave,
    onSaveSubtitles,
    onOpenAssetLibrary,
    onOpenProjectAssets,
    onUploadLocalFiles,
    addNodeToTimelineRef,
    addMediaToTimelineRef,
    onCreateAssembledNode,
    onCreateAssembledNodeFromResource,
}: CanvasTimelineDialogProps) {
    const { message } = App.useApp();
    const theme = canvasThemes[useActiveTheme()];
    const {
        draft,
        canUndo,
        canRedo,
        resetDraft,
        commitDraft,
        replaceDraft,
        recordSnapshot,
        undo,
        redo,
    } = useTimelineDraftHistory(() => buildTimelineFromNodes([]), open);

    const [playheadMs, setPlayheadMs] = useState(0);
    const [zoomLevel, setZoomLevel] = useState(1);
    const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
    const [snapEnabled, setSnapEnabled] = useState(true);
    const [previewPlaying, setPreviewPlaying] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [finalizingExport, setFinalizingExport] = useState(false);
    const finalizingExportRef = useRef(false);
    const exportControllerRef = useRef<AbortController | null>(null);
    useEffect(() => {
        if (!open) exportControllerRef.current?.abort();
        return () => exportControllerRef.current?.abort();
    }, [open]);

    const [saving, setSaving] = useState(false);
    const [exportPercent, setExportPercent] = useState(0);
    const [exportDetail, setExportDetail] = useState("");
    const gestureSnapshotRef = useRef<TimelineProject | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const trackAreaRef = useRef<HTMLDivElement>(null);
    const uploadInputRef = useRef<HTMLInputElement>(null);
    const toolbarRef = useRef<HTMLDivElement>(null);
    const addGroupProbeRef = useRef<HTMLDivElement>(null);
    const moreBtnRef = useRef<HTMLSpanElement>(null);
    const initializedRef = useRef(false);

    useEffect(() => {
        if (!open) {
            initializedRef.current = false;
            return;
        }
        if (initializedRef.current) return;
        initializedRef.current = true;
        const base = timeline ? normalizeTimelineProject(timeline) : buildTimelineFromNodes(nodes);
        const next = timeline ? syncTimelineSubtitleClips(base, nodes) : base;
        resetDraft(next);
        setPlayheadMs(0);
        setZoomLevel(1);
        setSelectedClipId(null);
        setPreviewPlaying(false);
        const triggerClip = node?.id ? next.clips.find((clip) => clip.nodeId === node.id) : null;
        if (triggerClip) setPlayheadMs(triggerClip.startMs);
    }, [open, node?.id, nodes, timeline, resetDraft]);

    const pxPerMs = (BASE_PX_PER_SECOND / 1_000) * zoomLevel;
    const durationMs = Math.max(1_000, draft.durationMs);
    const [viewportWidth, setViewportWidth] = useState(900);
    const trackWidth = useMemo(() => getTimelineTrackWidth(durationMs, zoomLevel, viewportWidth), [durationMs, zoomLevel, viewportWidth]);
    const clampPlayheadMs = useCallback((ms: number) => Math.min(durationMs, Math.max(0, Math.round(ms))), [durationMs]);

    useEffect(() => {
        if (playheadMs > durationMs) setPlayheadMs(durationMs);
        else if (playheadMs < 0) setPlayheadMs(0);
    }, [durationMs, playheadMs]);

    useEffect(() => {
        if (!open) return;
        const measure = () => setViewportWidth(trackAreaRef.current?.clientWidth || 900);
        measure();
        const observer = new ResizeObserver(measure);
        if (trackAreaRef.current) observer.observe(trackAreaRef.current);
        return () => observer.disconnect();
    }, [open]);

    const [addGroupCollapsed, setAddGroupCollapsed] = useState(false);
    const toolbarObserverRef = useRef<ResizeObserver | null>(null);
    const measureToolbar = useCallback(() => {
        const el = toolbarRef.current;
        const probe = addGroupProbeRef.current;
        if (!el || !probe) return;
        const addGroupWidth = probe.offsetWidth;
        const shownAddWidth = addGroupCollapsed ? (moreBtnRef.current?.offsetWidth ?? 56) : addGroupWidth;
        const expandedWidth = el.scrollWidth - shownAddWidth + addGroupWidth;
        setAddGroupCollapsed(expandedWidth > el.clientWidth + 2);
    }, [addGroupCollapsed]);
    const ensureToolbarObserved = useCallback(() => {
        const el = toolbarRef.current;
        if (!el || toolbarObserverRef.current) return;
        const observer = new ResizeObserver(measureToolbar);
        toolbarObserverRef.current = observer;
        observer.observe(el);
        measureToolbar();
    }, [measureToolbar]);
    useEffect(() => {
        if (!open) return;
        ensureToolbarObserved();
        return () => {
            toolbarObserverRef.current?.disconnect();
            toolbarObserverRef.current = null;
        };
    }, [open, ensureToolbarObserved]);

    const updateClip = (clipId: string, patch: Partial<TimelineClip>, transient = false) => {
        const apply = transient ? replaceDraft : commitDraft;
        apply((current) => ({
            ...current,
            clips: current.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)),
        }));
    };

    const updateSelectedMediaNumbers = (patch: Partial<TimelineClip>) => {
        if (!selectedClipId) return;
        gestureSnapshotRef.current = null;
        if (patch.durationMs === undefined && patch.startMs === undefined) {
            updateClip(selectedClipId, patch, false);
            return;
        }
        commitDraft((current) => {
            const target = current.clips.find((clip) => clip.id === selectedClipId);
            if (!target) return current;
            const updatedTarget = { ...target, ...patch };
            const sameTrackLater = current.clips
                .filter((clip) => clip.trackId === target.trackId && clip.id !== selectedClipId && clip.startMs >= target.startMs)
                .sort((a, b) => a.startMs - b.startMs);
            const shiftedStarts = new Map<string, number>();
            let cursor = updatedTarget.startMs + updatedTarget.durationMs;
            for (const next of sameTrackLater) {
                if (next.startMs < cursor) {
                    shiftedStarts.set(next.id, cursor);
                    cursor += next.durationMs;
                } else {
                    cursor = next.startMs + next.durationMs;
                }
            }
            return {
                ...current,
                clips: current.clips.map((clip) => {
                    if (clip.id === selectedClipId) return updatedTarget;
                    const shifted = shiftedStarts.get(clip.id);
                    return shifted !== undefined ? { ...clip, startMs: shifted } : clip;
                }),
            };
        });
    };

    const previewSelectedMediaNumbers = (patch: Partial<TimelineClip>) => {
        if (!selectedClipId) return;
        if (!gestureSnapshotRef.current) gestureSnapshotRef.current = draft;
        updateClip(selectedClipId, patch, true);
    };

    const commitMediaNumberGesture = () => {
        if (gestureSnapshotRef.current) {
            recordSnapshot(gestureSnapshotRef.current);
            gestureSnapshotRef.current = null;
        }
    };

    const toggleTrackMute = (trackId: string) => {
        commitDraft((current) => ({
            ...current,
            tracks: current.tracks.map((track) => (track.id === trackId ? { ...track, muted: !track.muted } : track)),
        }));
    };

    const toggleTrackVisibility = (trackId: string) => {
        commitDraft((current) => ({
            ...current,
            tracks: current.tracks.map((track) => (track.id === trackId ? { ...track, visible: track.visible === false ? true : false } : track)),
        }));
    };

    const updateOutputOptions = (nextOutput: TimelineProject["output"]) => {
        commitDraft((current) => ({
            ...current,
            output: nextOutput,
        }));
    };

    const { handleClipPointerDown, handleClipPointerMove, handleClipPointerUp } = useTimelineClipDrag({
        open,
        draft,
        playheadMs,
        pxPerMs,
        snapEnabled,
        trackAreaRef,
        onSelectClip: setSelectedClipId,
        replaceDraft,
        recordSnapshot,
    });

    const deleteSelectedClip = () => {
        if (!selectedClipId) {
            message.info("请先点击选中一个片段");
            return;
        }
        commitDraft((current) => ({ ...current, clips: current.clips.filter((clip) => clip.id !== selectedClipId) }));
        setSelectedClipId(null);
    };

    const resolveTargetTrackFrom = (tracks: TimelineProject["tracks"], kind: "video" | "audio" | "image") => {
        if (kind === "audio") {
            const trackId = tracks.find((track) => track.kind === "audio")?.id ?? DEFAULT_AUDIO_TRACK_ID;
            return tracks.find((track) => track.id === trackId);
        }
        const visualTracks = getVisualTracks(tracks);
        return visualTracks[0] ?? tracks.find((track) => track.id === DEFAULT_VIDEO_TRACK_ID);
    };

    const resolvePlacementStartMsFrom = (clips: TimelineClip[], trackId: string, clipDurationMs: number) => {
        const placement = findNearestAvailablePlacement({ targetStartMs: playheadMs, durationMs: clipDurationMs, trackId, clips });
        return placement.fits
            ? placement.startMs
            : clips.filter((item) => item.trackId === trackId).reduce((max, item) => Math.max(max, item.startMs + item.durationMs), 0);
    };

    const addNodeToTimeline = (targetNode: CanvasNodeData) => {
        const kind = targetNode.type === "video" ? "video" : targetNode.type === "audio" ? "audio" : targetNode.type === "image" ? "image" : null;
        if (!kind) return;
        const targetTrack = resolveTargetTrackFrom(draft.tracks, kind);
        if (!targetTrack || targetTrack.locked) {
            message.warning(kind === "audio" ? "音频轨已锁定或不存在" : "画面轨已锁定或不存在");
            return;
        }
        const fallbackDuration = kind === "image" ? DEFAULT_IMAGE_CLIP_DURATION_MS : 4_000;
        const clipDurationMs = targetNode.metadata?.durationMs && targetNode.metadata.durationMs > 0 ? Math.round(targetNode.metadata.durationMs) : fallbackDuration;
        const clipId = `clip-${targetNode.id}-${Date.now()}`;
        const clipTitle = targetNode.title || (kind === "video" ? "视频片段" : kind === "image" ? "图片片段" : "音频片段");
        commitDraft((current) => {
            const track = resolveTargetTrackFrom(current.tracks, kind);
            if (!track || track.locked) return current;
            const startMs = resolvePlacementStartMsFrom(current.clips, track.id, clipDurationMs);
            const clip: TimelineClip = {
                id: clipId,
                kind,
                nodeId: targetNode.id,
                trackId: track.id,
                startMs,
                durationMs: clipDurationMs,
                title: clipTitle,
                ...(kind === "image" ? {} : { sourceStartMs: 0, sourceDurationMs: clipDurationMs, volume: 1, fadeInMs: 0, fadeOutMs: 0 }),
            };
            return { ...current, clips: [...current.clips, clip] };
        });
        setSelectedClipId(clipId);
        message.success(`已添加「${clipTitle}」到时间线`);
    };

    useEffect(() => {
        if (!addNodeToTimelineRef) return;
        addNodeToTimelineRef.current = addNodeToTimeline;
        return () => { addNodeToTimelineRef.current = null; };
    }, [addNodeToTimeline, addNodeToTimelineRef]);

    const addDirectMediasToTimeline = (medias: TimelineDirectMedia[]) => {
        if (!medias.length) return;
        const supported: Array<{ media: TimelineDirectMedia; kind: "video" | "audio" | "image" }> = [];
        for (const media of medias) {
            const kind = media.kind === "video" ? "video" : media.kind === "audio" ? "audio" : media.kind === "image" ? "image" : null;
            if (!kind) {
                message.info("文本素材暂不支持直接入轨");
                continue;
            }
            const targetTrack = resolveTargetTrackFrom(draft.tracks, kind);
            if (!targetTrack || targetTrack.locked) {
                message.warning(kind === "audio" ? "音频轨已锁定或不存在" : "画面轨已锁定或不存在");
                continue;
            }
            supported.push({ media, kind });
        }
        if (!supported.length) return;
        const now = Date.now();
        const lastItem = supported[supported.length - 1];
        const lastClipId = `clip-media-${lastItem.media.id}-${now}-${supported.length - 1}`;
        const lastTitle = lastItem.media.title || (lastItem.kind === "video" ? "视频片段" : lastItem.kind === "image" ? "图片片段" : "音频片段");
        commitDraft((current) => {
            const nextClips = [...current.clips];
            let added = 0;
            supported.forEach(({ media, kind }, index) => {
                const track = resolveTargetTrackFrom(current.tracks, kind);
                if (!track || track.locked) return;
                const fallbackDuration = kind === "image" ? DEFAULT_IMAGE_CLIP_DURATION_MS : 4_000;
                const clipDurationMs = media.durationMs && media.durationMs > 0 ? Math.round(media.durationMs) : fallbackDuration;
                const startMs = resolvePlacementStartMsFrom(nextClips, track.id, clipDurationMs);
                const clipId = `clip-media-${media.id}-${now}-${index}`;
                const clipTitle = media.title || (kind === "video" ? "视频片段" : kind === "image" ? "图片片段" : "音频片段");
                nextClips.push({
                    id: clipId,
                    kind,
                    nodeId: `timeline-media-${media.id}-${now}-${index}`,
                    trackId: track.id,
                    startMs,
                    durationMs: clipDurationMs,
                    title: clipTitle,
                    directMedia: media,
                    ...(kind === "image" ? {} : { sourceStartMs: 0, sourceDurationMs: clipDurationMs, volume: 1, fadeInMs: 0, fadeOutMs: 0 }),
                });
                added += 1;
            });
            return added > 0 ? { ...current, clips: nextClips } : current;
        });
        setSelectedClipId(lastClipId);
        if (supported.length === 1 && lastTitle) message.success(`已添加「${lastTitle}」到时间线`);
        else if (supported.length > 1) message.success(`已添加 ${supported.length} 个素材到时间线`);
    };

    const addDirectMediaToTimeline = (media: TimelineDirectMedia) => addDirectMediasToTimeline([media]);

    useEffect(() => {
        if (!addMediaToTimelineRef) return;
        addMediaToTimelineRef.current = addDirectMediaToTimeline;
        return () => { addMediaToTimelineRef.current = null; };
    }, [addDirectMediaToTimeline, addMediaToTimelineRef]);

    const splitClipAtPlayhead = () => {
        const clip = draft.clips.find((item) => (item.kind === "video" || item.kind === "audio" || item.kind === "image") && playheadMs > item.startMs && playheadMs < item.startMs + item.durationMs);
        if (!clip) {
            message.info("请先将播放头移动到片段内部，再执行分割");
            return;
        }
        const cutMs = playheadMs - clip.startMs;
        if (cutMs < MIN_CLIP_DURATION_MS || clip.durationMs - cutMs < MIN_CLIP_DURATION_MS) {
            message.warning("分割点太靠近片段边缘");
            return;
        }
        const left: TimelineClip = { ...clip, id: `${clip.id}-left-${Date.now()}`, durationMs: Math.round(cutMs) };
        const right: TimelineClip = {
            ...clip,
            id: `${clip.id}-right-${Date.now()}`,
            startMs: playheadMs,
            durationMs: Math.round(clip.durationMs - cutMs),
            ...(clip.kind === "image" ? {} : { sourceStartMs: (clip.sourceStartMs || 0) + Math.round(cutMs) }),
        };
        commitDraft((current) => ({ ...current, clips: [...current.clips.filter((item) => item.id !== clip.id), left, right] }));
        setSelectedClipId(left.id);
        message.success("已在播放头处分割片段");
    };

    const handleLocalUpload = async (files: FileList | null) => {
        const list = files ? Array.from(files) : [];
        if (!list.length) return;
        const medias = await onUploadLocalFiles(list);
        addDirectMediasToTimeline(medias);
    };

    const handleClose = () => {
        if (saving || finalizingExportRef.current) return;
        exportControllerRef.current?.abort();
        onClose();
    };

    const buildSubtitleEntriesForNode = (subNodeId: string, source: TimelineProject = draft): SrtEntry[] => {
        const currentNode = nodes.find((item) => item.id === subNodeId);
        if ((currentNode?.metadata?.subtitleEntries?.length ?? 0) === 0) return [];
        const videoClip = source.clips.find((clip) => clip.nodeId === subNodeId && clip.kind === "video");
        const baseMs = videoClip?.startMs ?? 0;
        return source.clips
            .filter((clip) => clip.nodeId === subNodeId && clip.kind === "subtitle" && Boolean(clip.text))
            .sort((a, b) => a.startMs - b.startMs)
            .map((clip, index) => ({
                index: index + 1,
                startMs: Math.max(0, Math.round(clip.startMs - baseMs)),
                endMs: Math.max(0, Math.round(clip.startMs + clip.durationMs - baseMs)),
                text: (clip.text || "").trim(),
            }));
    };

    const handleSave = async () => {
        if (saving || exportControllerRef.current) return;
        const clearedSubtitleNodeIds = new Set(nodes.filter((item) => (item.metadata?.subtitleEntries?.length ?? 0) === 0).map((item) => item.id));
        const base = normalizeTimelineProject({ ...draft, updatedAt: new Date().toISOString() });
        const reconciledClips = clearedSubtitleNodeIds.size ? base.clips.filter((clip) => !(clip.kind === "subtitle" && clearedSubtitleNodeIds.has(clip.nodeId))) : base.clips;
        const normalized = normalizeTimelineProject({ ...base, clips: reconciledClips });
        setSaving(true);
        const error = await runTimelineDialogSaveAttempt(async () => {
            await onSave(normalized);
            const previousSubtitleNodeIds = new Set((timeline?.clips || []).filter((clip) => clip.kind === "subtitle").map((clip) => clip.nodeId));
            const nextSubtitleNodeIds = new Set(normalized.clips.filter((clip) => clip.kind === "subtitle").map((clip) => clip.nodeId));
            const nodeSubtitleNodeIds = new Set(nodes.filter((item) => (item.metadata?.subtitleEntries?.length ?? 0) > 0).map((item) => item.id));
            const subtitleNodeIds = new Set([...previousSubtitleNodeIds, ...nextSubtitleNodeIds, ...nodeSubtitleNodeIds]);
            subtitleNodeIds.forEach((subNodeId) => onSaveSubtitles(subNodeId, buildSubtitleEntriesForNode(subNodeId, normalized)));
            message.success("时间线已保存");
        }, onClose);
        if (error) message.error(error instanceof Error ? error.message : "时间线保存失败，请重试");
        setSaving(false);
    };

    const runRender = async (): Promise<TimelineRenderOutcome> => {
        if (exportControllerRef.current) throw new Error("正在导出，请等待当前操作完成");
        setExporting(true);
        const controller = new AbortController();
        exportControllerRef.current = controller;
        setExportPercent(0);
        setExportDetail("准备导出");
        return executeTimelineRender({
            projectId,
            draft,
            nodes,
            controller,
            onProgress: (percent, detail) => {
                setExportPercent(percent);
                setExportDetail(detail);
            },
        });
    };

    const finishExport = () => {
        exportControllerRef.current = null;
        finalizingExportRef.current = false;
        setExporting(false);
        setFinalizingExport(false);
        setExportPercent(0);
        setExportDetail("");
    };

    const defaultBaseTitle = node?.title?.trim() || "成片";

    const handleExport = async () => {
        if (exportControllerRef.current) return;
        try {
            const outcome = await runRender();
            finalizingExportRef.current = true;
            setFinalizingExport(true);
            setExportDetail("正在保存成片");
            const fileName = `${defaultBaseTitle}.mp4`;
            const saved = outcome.mode === "native"
                ? await downloadOwnedOrBrowserMedia({ fileName, resourceId: outcome.resourceId })
                : await saveOwnedOrBrowserVideoBlob(fileName, outcome.blob);
            if (saved === "saved") message.success("成片导出完成");
        } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
                message.error(error instanceof Error ? error.message : "导出失败");
            }
        } finally {
            finishExport();
        }
    };

    const handleCreateAssembledNode = async () => {
        if (exportControllerRef.current) return;
        try {
            const outcome = await runRender();
            finalizingExportRef.current = true;
            setFinalizingExport(true);
            setExportDetail("正在保存新片段");
            const nextTitle = `${defaultBaseTitle}-新片段`;
            let created: CanvasNodeData | null = null;
            if (outcome.mode === "native") {
                if (!onCreateAssembledNodeFromResource) throw new Error("当前视图不支持直接绑定渲染结果");
                created = await onCreateAssembledNodeFromResource({
                    resourceId: outcome.resourceId,
                    title: nextTitle,
                    durationMs: outcome.durationMs,
                    width: outcome.width,
                    height: outcome.height,
                    size: outcome.size,
                });
            } else {
                created = await onCreateAssembledNode(outcome.blob, nextTitle);
            }
            if (created) message.success("已生成新视频片段并放到画布，可继续编辑字幕与样式");
        } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
                message.error(error instanceof Error ? error.message : "生成新片段失败");
            }
        } finally {
            finishExport();
        }
    };

    const addableNodes = nodes.filter((item) => (item.type === "video" || item.type === "audio" || item.type === "image") && Boolean(item.metadata?.content || item.metadata?.storageKey) && !isNodeInTimeline(item.id, draft));
    const selectedSubtitleClip = selectedClipId ? draft.clips.find((clip) => clip.id === selectedClipId && clip.kind === "subtitle") || null : null;
    const selectedMediaClip = selectedClipId ? draft.clips.find((clip) => clip.id === selectedClipId && (clip.kind === "video" || clip.kind === "audio" || clip.kind === "image")) || null : null;
    const hasRenderableMedia = getVisibleMediaClips(draft).length > 0;
    const hasSubtitleTargetNode = Boolean(selectedSubtitleClip?.nodeId && nodes.some((item) => item.id === selectedSubtitleClip.nodeId));

    const resetPlayheadToStart = useCallback(() => {
        setPreviewPlaying(false);
        setPlayheadMs(0);
        if (trackAreaRef.current) trackAreaRef.current.scrollLeft = 0;
    }, []);

    const title = (
        <div className="flex min-w-0 items-center gap-2.5 pr-10">
            <button
                type="button"
                disabled={saving || finalizingExport}
                onClick={handleClose}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium transition hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                style={{ borderColor: theme.toolbar.border, background: theme.node.fill, color: theme.node.text }}
            >
                <ArrowLeft className="size-3.5" />
                <span>返回</span>
            </button>
            <span className="grid size-8 shrink-0 place-items-center rounded-lg" style={{ background: theme.accent.primarySoft, color: theme.accent.primary }}>
                <Clapperboard className="size-4" />
            </span>
            <div className="min-w-0">
                <div className="truncate text-[var(--fs-heading-lg)] font-medium leading-6">多轨时间线</div>
            </div>
        </div>
    );

    return (
        <AppModal
            className="canvas-timeline-dialog"
            classNames={{ body: "text-sm" }}
            style={{
                "--editor-bg": theme.node.panel,
                "--editor-panel": theme.node.fill,
                "--editor-line": theme.toolbar.border,
                "--editor-text": theme.node.text,
                "--editor-muted": theme.node.muted,
                "--editor-button-bg": theme.node.fill,
                "--editor-button-line": theme.toolbar.border,
                "--editor-clip-text": canvasThemes.dark.node.text,
            } as CSSProperties}
            styles={{
                container: { height: "min(820px, calc(100dvh - 24px))", display: "flex", flexDirection: "column" },
                header: { flexShrink: 0 },
                body: { minHeight: 0, flex: "1 1 0px", display: "flex", flexDirection: "column", overflow: "hidden", color: theme.node.text },
            }}
            title={title}
            open={open}
            centered
            footer={null}
            width="min(1360px, calc(100vw - 24px))"
            destroyOnHidden
            onCancel={handleClose}
            afterOpenChange={(visible) => {
                if (visible) ensureToolbarObserved();
            }}
            flush
        >
            <div data-canvas-keyboard-scope className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <CanvasTimelineToolbar
                    theme={theme}
                    playheadMs={playheadMs}
                    onResetPlayhead={resetPlayheadToStart}
                    canUndo={canUndo}
                    canRedo={canRedo}
                    onUndo={undo}
                    onRedo={redo}
                    snapEnabled={snapEnabled}
                    onToggleSnap={() => setSnapEnabled((value) => !value)}
                    onZoomOut={() => setZoomLevel((value) => zoomOut(value))}
                    onZoomIn={() => setZoomLevel((value) => zoomIn(value))}
                    onFitZoom={() => setZoomLevel(getFitTimelineZoom(durationMs, viewportWidth))}
                    addGroupCollapsed={addGroupCollapsed}
                    addableNodes={addableNodes}
                    onAddNodeToTimeline={addNodeToTimeline}
                    onOpenAssetLibrary={onOpenAssetLibrary}
                    onOpenProjectAssets={onOpenProjectAssets}
                    onUploadFiles={(files) => void handleLocalUpload(files)}
                    onSplitClipAtPlayhead={splitClipAtPlayhead}
                    selectedClipId={selectedClipId}
                    onDeleteSelectedClip={deleteSelectedClip}
                    toolbarRef={toolbarRef}
                    moreBtnRef={moreBtnRef}
                    addGroupProbeRef={addGroupProbeRef}
                    uploadInputRef={uploadInputRef}
                />

                <div className="timeline-editor-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
                    <CanvasTimelinePreview
                        clips={draft.clips}
                        tracks={draft.tracks}
                        output={draft.output}
                        nodes={nodes}
                        playheadMs={playheadMs}
                        playing={previewPlaying}
                        theme={theme}
                        onTogglePlay={() => setPreviewPlaying((value) => !value)}
                        onRequestPause={() => setPreviewPlaying(false)}
                        onPlayheadChange={clampPlayheadMs}
                        onUpdateOutput={updateOutputOptions}
                    />

                    <CanvasTimelineTrackArea
                        draft={draft}
                        theme={theme}
                        pxPerMs={pxPerMs}
                        durationMs={durationMs}
                        playheadMs={playheadMs}
                        trackWidth={trackWidth}
                        selectedClipId={selectedClipId}
                        trackAreaRef={trackAreaRef}
                        scrollRef={scrollRef}
                        onSeek={(ms) => {
                            setPreviewPlaying(false);
                            setPlayheadMs(clampPlayheadMs(ms));
                        }}
                        onClipPointerDown={handleClipPointerDown}
                        onClipPointerMove={handleClipPointerMove}
                        onClipPointerUp={handleClipPointerUp}
                        onToggleTrackMute={toggleTrackMute}
                        onToggleTrackVisibility={toggleTrackVisibility}
                        onUploadFiles={(files) => void handleLocalUpload(files)}
                        onTriggerUpload={() => uploadInputRef.current?.click()}
                    />
                </div>

                <CanvasTimelineInspector
                    draft={draft}
                    theme={theme}
                    durationMs={durationMs}
                    exporting={exporting}
                    exportPercent={exportPercent}
                    exportDetail={exportDetail}
                    finalizingExport={finalizingExport}
                    saving={saving}
                    hasRenderableMedia={hasRenderableMedia}
                    hasSubtitleTargetNode={hasSubtitleTargetNode}
                    selectedSubtitleClip={selectedSubtitleClip}
                    selectedMediaClip={selectedMediaClip}
                    onOpenSubtitleDialog={onOpenSubtitleDialog}
                    onUpdateClip={(clipId, patch) => updateClip(clipId, patch)}
                    onUpdateSelectedMediaNumbers={updateSelectedMediaNumbers}
                    onPreviewSelectedMediaNumbers={previewSelectedMediaNumbers}
                    onCommitMediaNumberGesture={commitMediaNumberGesture}
                    onSplitClipAtPlayhead={splitClipAtPlayhead}
                    onAbortExport={() => {
                        if (!finalizingExportRef.current) exportControllerRef.current?.abort();
                    }}
                    onExport={() => void handleExport()}
                    onCreateAssembledNode={() => void handleCreateAssembledNode()}
                    onClose={handleClose}
                    onSave={() => void handleSave()}
                />
            </div>
        </AppModal>
    );
}
