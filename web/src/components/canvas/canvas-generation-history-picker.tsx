import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Input, Modal, Spin } from "antd";
import { FileAudio, FileVideo, Image as ImageIcon, Search } from "lucide-react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import {
    awaitCanvasGenerationHistoryDetailIfValid,
    canvasGenerationHistorySelectStillValid,
    insertableCanvasGenerationHistoryTasks,
    type CanvasGenerationHistorySelectGate,
} from "@/lib/canvas/canvas-generation-history";
import { generationTaskMode } from "@/lib/canvas/canvas-generation-task-sync";
import { captureUserScopeEpoch, getActiveUserScope } from "@/lib/user-scope";
import { ownedResourceIdFromMediaRef, resourceIdFromStorageKey, resourceStorageKey } from "@/services/api/resources";
import { listGenerationTasks, queryGenerationTask, type GenerationTask } from "@/services/api/task-center";

type CanvasGenerationHistoryPickerProps = {
    open: boolean;
    projectId: string;
    onClose: () => void;
    onSelect: (task: GenerationTask) => void;
};

export function CanvasGenerationHistoryPicker({ open, projectId, onClose, onSelect }: CanvasGenerationHistoryPickerProps) {
    const { message } = App.useApp();
    const [keyword, setKeyword] = useState("");
    const selectionRequest = useRef<AbortController | null>(null);
    const selectionEpoch = useRef(0);
    const openRef = useRef(open);
    const projectIdRef = useRef(projectId);
    const mountedRef = useRef(true);
    const onSelectRef = useRef(onSelect);
    openRef.current = open;
    projectIdRef.current = projectId;
    onSelectRef.current = onSelect;
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    const scope = getActiveUserScope();
    const cancelSelection = () => {
        selectionEpoch.current += 1;
        selectionRequest.current?.abort();
        selectionRequest.current = null;
    };
    useEffect(() => () => cancelSelection(), [open, projectId, scope]);
    const query = useQuery({
        queryKey: ["canvas-generation-history", scope, projectId],
        queryFn: ({ signal }) => listGenerationTasks(100, { projectId, activeOnly: false }, undefined, signal),
        enabled: open && Boolean(projectId.trim()),
        staleTime: 15_000,
    });
    const tasks = useMemo(
        () => insertableCanvasGenerationHistoryTasks(query.data || [], { projectId, keyword }),
        [keyword, projectId, query.data],
    );

    const liveSelectGate = (): CanvasGenerationHistorySelectGate => ({
        open: openRef.current,
        projectId: projectIdRef.current,
        epoch: captureUserScopeEpoch(),
        mounted: mountedRef.current,
        selectionEpoch: selectionEpoch.current,
    });

    const selectSummary = async (task: GenerationTask) => {
        if (selectionRequest.current || !task.id?.trim() || !projectId.trim()) return;
        const captured = liveSelectGate();
        if (!canvasGenerationHistorySelectStillValid(captured, captured)) return;
        const request = new AbortController();
        selectionRequest.current = request;
        try {
            const resolved = await awaitCanvasGenerationHistoryDetailIfValid({
                detail: queryGenerationTask(task.id, { signal: request.signal }),
                captured,
                live: liveSelectGate,
                expectedId: task.id,
            });
            if (!resolved) return;
            onSelectRef.current(resolved);
        } catch (error) {
            if (!canvasGenerationHistorySelectStillValid(captured, liveSelectGate())) return;
            message.error(error instanceof Error ? error.message : "生成结果无法插入画布");
        } finally {
            if (selectionRequest.current === request) selectionRequest.current = null;
        }
    };

    return (
        <Modal open={open} title="从生成历史选择" footer={null} onCancel={() => { cancelSelection(); onClose(); }} width={720} destroyOnHidden>
            <Input allowClear prefix={<Search className="size-3.5" />} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索提示词或模型" aria-label="搜索生成历史" />
            <div className="mt-3 max-h-[min(560px,65vh)] overflow-y-auto pr-1">
                {query.isLoading ? <div className="grid min-h-40 place-items-center"><Spin /></div> : tasks.length ? (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {tasks.map((task) => <HistoryTaskCard key={task.id} task={task} onSelect={() => void selectSummary(task)} />)}
                    </div>
                ) : (
                    <div className="grid min-h-24 place-items-center rounded-lg border border-dashed border-border/70 text-sm text-foreground/55">
                        {query.isError ? "生成历史暂时无法读取" : "暂无可插入的生成结果"}
                    </div>
                )}
            </div>
        </Modal>
    );
}

function HistoryTaskCard({ task, onSelect }: { task: GenerationTask; onSelect: () => void }) {
    const mode = generationTaskMode(task);
    const preview = generationHistoryPreviewImageSrc(task);
    const storageKey = generationHistoryPreviewStorageKey(task);
    const Icon = mode === "video" ? FileVideo : mode === "audio" ? FileAudio : ImageIcon;
    const iconFallback = <div className="grid size-full place-items-center text-foreground/45"><Icon className="size-7" /></div>;
    return (
        <button type="button" className="group overflow-hidden rounded-lg border border-border/70 bg-surface text-left transition hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onSelect} aria-label={`插入${modeLabel(mode)}：${task.prompt.slice(0, 40)}`}>
            <div className="relative aspect-video overflow-hidden bg-surface-tertiary">
                {storageKey ? (
                    <CachedResourceImage storageKey={storageKey} alt="生成结果预览" loading="lazy" className="size-full object-cover" fallback={iconFallback} loadingFallback={iconFallback} />
                ) : preview ? (
                    <img src={preview} alt="生成结果预览" loading="lazy" className="size-full object-cover" />
                ) : iconFallback}
                <span className="absolute bottom-1 left-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white">{modeLabel(mode)}</span>
            </div>
            <div className="truncate px-2 py-2 text-xs text-foreground/80" title={task.prompt}>{task.prompt || "无提示词"}</div>
        </button>
    );
}

function modeLabel(mode: string) {
    return mode === "video" ? "视频" : mode === "audio" ? "音频" : "图片";
}

export function generationHistoryPreviewImageSrc(task: GenerationTask) {
    const mode = generationTaskMode(task);
    if (mode === "audio") return "";
    const inline = mode === "video"
        ? inlineImagePreviewSrc(task.previewPosterUrl || previewPosterFromResult(task))
        : inlineImagePreviewSrc(task.previewPosterUrl || task.previewUrl || previewFromResult(task));
    if (generationHistoryPreviewStorageKey(task) && !inline.startsWith("data:image/")) return "";
    return inline;
}

export function generationHistoryPreviewStorageKey(task: GenerationTask) {
    const mode = generationTaskMode(task);
    if (mode === "audio") return "";
    if (mode === "video") {
        const poster = task.previewPosterUrl || previewPosterFromResult(task);
        const resourceId = ownedResourceIdFromMediaRef(undefined, poster);
        return resourceId ? resourceStorageKey(resourceId) : "";
    }
    return imagePreviewStorageKey(task);
}

function inlineImagePreviewSrc(value: string) {
    if (!value || ownedResourceIdFromMediaRef(undefined, value)) return "";
    return isImagePreviewSrc(value) ? value : "";
}

function imagePreviewStorageKey(task: GenerationTask) {
    const preview = task.previewPosterUrl || task.previewUrl || previewFromResult(task);
    if (!task.resultJson) {
        const resourceId = ownedResourceIdFromMediaRef(undefined, preview);
        return resourceId ? resourceStorageKey(resourceId) : "";
    }
    try {
        const result = JSON.parse(task.resultJson) as { images?: Array<{ storageKey?: string; dataUrl?: string; url?: string }> };
        const image = result.images?.[0];
        const resourceId = resourceIdFromStorageKey(image?.storageKey) || ownedResourceIdFromMediaRef(image?.storageKey, image?.dataUrl || image?.url || preview);
        return resourceId ? resourceStorageKey(resourceId) : "";
    } catch {
        const resourceId = ownedResourceIdFromMediaRef(undefined, preview);
        return resourceId ? resourceStorageKey(resourceId) : "";
    }
}

function isImagePreviewSrc(value: string) {
    if (!value) return false;
    const lower = value.toLowerCase();
    if (lower.startsWith("data:image/")) return true;
    if (lower.startsWith("data:")) return false;
    if (/\.(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov|mkv)(?:\?|$)/i.test(lower)) return false;
    return true;
}

function previewPosterFromResult(task: GenerationTask) {
    if (!task.resultJson) return "";
    try {
        const result = JSON.parse(task.resultJson) as { video?: { previewUrl?: string; posterUrl?: string } };
        return result.video?.previewUrl || result.video?.posterUrl || "";
    } catch {
        return "";
    }
}

function previewFromResult(task: GenerationTask) {
    if (!task.resultJson) return "";
    try {
        const result = JSON.parse(task.resultJson) as { images?: Array<{ dataUrl?: string; url?: string }>; video?: { previewUrl?: string; dataUrl?: string; url?: string }; audio?: { dataUrl?: string; url?: string } };
        const mode = generationTaskMode(task);
        if (mode === "image") return result.images?.[0]?.dataUrl || result.images?.[0]?.url || "";
        if (mode === "video") return result.video?.previewUrl || "";
        return "";
    } catch {
        return "";
    }
}
