import { Modal, Popover } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { Check, Image as ImageIcon, Music2, Play, UserRound, X } from "lucide-react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import { useCanvasNodeActions } from "@/components/canvas/canvas-node-action-context";
import { Tooltip } from "@/components/ui/base/tooltip";
import { canvasNodeVideoPreviewUrl } from "@/lib/canvas/canvas-media-preview";
import {
    collectBindableStoryboardAssetNodes,
    collectSelectedBindableAssetNodes,
    mergeStoryboardAssetBindings,
    removeStoryboardAssetBinding,
    STORYBOARD_ASSET_ROLE_LABELS,
    STORYBOARD_ASSET_ROLE_OPTIONS,
    storyboardAssetNodeBadge,
    toggleStoryboardAssetBinding,
    updateStoryboardAssetBindingRole,
} from "@/lib/canvas/canvas-storyboard-assets";
import { isStoryboardPreviewAsset } from "@/lib/canvas/canvas-storyboard-materializer";
import { isProtectedResourceFileUrl, ownedResourceStorageKey } from "@/services/api/resources";
import { resolveMediaUrl } from "@/services/file-storage";
import { createCanvasPageUiStore } from "@/stores/canvas/use-canvas-page-ui-store";
import { CanvasNodeType, type CanvasNodeData, type StoryboardAssetBinding, type StoryboardAssetRole } from "@/types/canvas";

const FALLBACK_PAGE_UI_STORE = createCanvasPageUiStore();

export type StoryboardAssetsCellProps = {
    bindings: StoryboardAssetBinding[];
    nodes: CanvasNodeData[];
    selectedCanvasNodeIds?: Iterable<string>;
    limit?: number;
    onChange?: (bindings: StoryboardAssetBinding[]) => void;
};

export function StoryboardAssetsCell({
    bindings,
    nodes,
    selectedCanvasNodeIds,
    limit,
    onChange,
}: StoryboardAssetsCellProps) {
    const [previewNode, setPreviewNode] = useState<CanvasNodeData | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const { pageUi } = useCanvasNodeActions();
    const storeSelectedIds = useStore(pageUi ?? FALLBACK_PAGE_UI_STORE, (state) => state.selectedNodeIds);
    const effectiveSelectedIds = selectedCanvasNodeIds ?? storeSelectedIds;

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const assets = useMemo(
        () => bindings.map((binding) => ({ binding, node: nodeById.get(binding.nodeId) })).filter((item) => !item.node || isStoryboardPreviewAsset(item.node)),
        [bindings, nodeById],
    );
    const effectiveLimit = limit ?? (onChange ? 3 : 4);
    const visible = assets.slice(0, effectiveLimit);
    const hiddenCount = Math.max(0, assets.length - visible.length);

    if (!assets.length && !onChange) {
        return <span className="text-[var(--fs-caption)] text-foreground/35">未关联</span>;
    }

    return (
        <>
            <div className="flex min-w-0 items-center gap-1.5" aria-label={assets.length ? `已关联 ${assets.length} 个资产` : "未关联资产"}>
                {visible.map(({ binding, node }) => (
                    <Tooltip key={binding.nodeId} title={`${node?.title || "资产已失效"} · ${STORYBOARD_ASSET_ROLE_LABELS[binding.role]}`}>
                        <button
                            type="button"
                            disabled={!node}
                            data-canvas-no-zoom
                            className="relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-md border border-foreground/10 bg-foreground/[0.035] text-foreground/45 outline-none transition enabled:hover:border-foreground/30 enabled:hover:text-foreground/70 focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:cursor-not-allowed"
                            aria-label={`预览${node?.title || "失效资产"}`}
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (node) setPreviewNode(node);
                            }}
                        >
                            {node ? <AssetThumbnail node={node} /> : <ImageIcon className="size-4" />}
                            <span className="absolute bottom-0 right-0 rounded-tl bg-black/70 px-1 text-[var(--fs-caption)] leading-4 text-white">
                                {STORYBOARD_ASSET_ROLE_LABELS[binding.role].slice(0, 1)}
                            </span>
                        </button>
                    </Tooltip>
                ))}
                {hiddenCount ? <span className="shrink-0 text-[var(--fs-caption)] font-medium tabular-nums text-foreground/45">+{hiddenCount}</span> : null}
                {onChange ? (
                    <Popover
                        open={pickerOpen}
                        onOpenChange={setPickerOpen}
                        trigger="click"
                        placement="bottomRight"
                        destroyOnHidden
                        content={
                            <StoryboardAssetBindingPanel
                                bindings={bindings}
                                nodes={nodes}
                                selectedCanvasNodeIds={effectiveSelectedIds}
                                onChange={onChange}
                            />
                        }
                    >
                        <button
                            type="button"
                            data-canvas-no-zoom
                            aria-label="关联画布资产"
                            className="inline-flex h-7 shrink-0 items-center rounded-md border border-dashed border-foreground/20 px-2 text-[var(--fs-caption)] font-medium text-[var(--user-ink-muted)] outline-none transition hover:border-foreground/40 hover:bg-foreground/[0.04] hover:text-[var(--user-ink)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.stopPropagation();
                                setPickerOpen((current) => !current);
                            }}
                        >
                            + 关联
                        </button>
                    </Popover>
                ) : null}
            </div>
            <AssetPreviewModal node={previewNode} onClose={() => setPreviewNode(null)} />
        </>
    );
}

export function StoryboardAssetBindingPanel({
    bindings,
    nodes,
    selectedCanvasNodeIds,
    onChange,
}: {
    bindings: StoryboardAssetBinding[];
    nodes: CanvasNodeData[];
    selectedCanvasNodeIds?: Iterable<string>;
    onChange: (bindings: StoryboardAssetBinding[]) => void;
}) {
    const [keyword, setKeyword] = useState("");
    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const eligibleNodes = useMemo(() => collectBindableStoryboardAssetNodes(nodes), [nodes]);
    const selectedBindableNodes = useMemo(
        () => collectSelectedBindableAssetNodes(nodes, selectedCanvasNodeIds),
        [nodes, selectedCanvasNodeIds],
    );
    const referenceImageNodes = useMemo(
        () => eligibleNodes.filter((node) => node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Drawing || node.metadata?.workflowKind === "character"),
        [eligibleNodes],
    );
    const boundIds = useMemo(() => new Set(bindings.map((binding) => binding.nodeId)), [bindings]);
    const filteredCandidates = useMemo(() => {
        const trimmed = keyword.trim().toLowerCase();
        if (!trimmed) return eligibleNodes;
        return eligibleNodes.filter((node) => {
            const title = (node.title || "").toLowerCase();
            const badge = storyboardAssetNodeBadge(node).toLowerCase();
            return title.includes(trimmed) || badge.includes(trimmed);
        });
    }, [eligibleNodes, keyword]);

    return (
        <div
            data-canvas-no-zoom
            data-canvas-wheel-scroll
            className="w-80 space-y-2.5 text-[var(--user-ink)]"
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">关联镜头参考资产</span>
                <span className="text-[var(--fs-caption)] tabular-nums text-[var(--user-ink-muted)]">已关联 {bindings.length} 项</span>
            </div>

            {selectedBindableNodes.length > 0 || referenceImageNodes.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                    {selectedBindableNodes.length > 0 ? (
                        <button
                            type="button"
                            className="inline-flex h-7 items-center rounded-md border border-foreground/15 bg-foreground/[0.04] px-2.5 text-[var(--fs-caption)] font-medium text-[var(--user-ink)] outline-none transition hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                            onClick={() => onChange(mergeStoryboardAssetBindings(bindings, selectedBindableNodes))}
                        >
                            一键勾选当前画布已选素材 ({selectedBindableNodes.length})
                        </button>
                    ) : null}
                    {referenceImageNodes.length > 0 ? (
                        <button
                            type="button"
                            className="inline-flex h-7 items-center rounded-md border border-foreground/15 px-2.5 text-[var(--fs-caption)] font-medium text-[var(--user-ink-muted)] outline-none transition hover:bg-foreground/[0.05] hover:text-[var(--user-ink)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                            onClick={() => onChange(mergeStoryboardAssetBindings(bindings, referenceImageNodes))}
                        >
                            全选画布参考图
                        </button>
                    ) : null}
                </div>
            ) : null}

            {bindings.length > 0 ? (
                <div className="space-y-1.5 border-t border-foreground/10 pt-2">
                    <div className="flex items-center justify-between">
                        <span className="text-[var(--fs-caption)] font-medium text-[var(--user-ink-muted)]">已关联资产</span>
                        <button
                            type="button"
                            className="text-[var(--fs-caption)] text-[var(--user-ink-muted)] outline-none transition hover:text-[var(--user-ink)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                            onClick={() => onChange([])}
                        >
                            清空
                        </button>
                    </div>
                    <div className="thin-scrollbar max-h-40 space-y-1 overflow-y-auto pr-0.5">
                        {bindings.map((binding) => {
                            const targetNode = nodeById.get(binding.nodeId);
                            const title = targetNode?.title || "资产已失效";
                            const roleOptions = binding.role === "weapon"
                                ? [...STORYBOARD_ASSET_ROLE_OPTIONS, { value: "weapon" as const, label: "武器" }]
                                : STORYBOARD_ASSET_ROLE_OPTIONS;
                            return (
                                <div key={binding.nodeId} className="flex items-center gap-2 rounded-md border border-foreground/10 bg-foreground/[0.025] px-2 py-1">
                                    <span className="relative grid size-7 shrink-0 place-items-center overflow-hidden rounded border border-foreground/10 bg-foreground/[0.04] text-foreground/50">
                                        {targetNode ? <AssetThumbnail node={targetNode} /> : <ImageIcon className="size-3.5" />}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-[var(--fs-caption)] font-medium" title={title}>
                                        {title}
                                    </span>
                                    <select
                                        aria-label={`${title} 资产角色`}
                                        value={binding.role}
                                        className="h-6 shrink-0 rounded border border-foreground/15 bg-transparent px-1.5 text-[var(--fs-caption)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                                        onChange={(event) => onChange(updateStoryboardAssetBindingRole(bindings, binding.nodeId, event.target.value as StoryboardAssetRole))}
                                    >
                                        {roleOptions.map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        aria-label={`移除 ${title}`}
                                        className="grid size-6 shrink-0 place-items-center rounded text-[var(--user-ink-muted)] outline-none transition hover:bg-foreground/10 hover:text-[var(--user-ink)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                                        onClick={() => onChange(removeStoryboardAssetBinding(bindings, binding.nodeId))}
                                    >
                                        <X className="size-3.5" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : null}

            <div className="space-y-1.5 border-t border-foreground/10 pt-2">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--fs-caption)] font-medium text-[var(--user-ink-muted)]">画布可用资产</span>
                    <span className="text-[var(--fs-caption)] tabular-nums text-[var(--user-ink-muted)]">{eligibleNodes.length} 个</span>
                </div>
                {eligibleNodes.length > 6 ? (
                    <input
                        type="search"
                        value={keyword}
                        placeholder="筛选角色、场景或素材名称"
                        aria-label="筛选画布资产"
                        className="h-7 w-full rounded-md border border-foreground/15 bg-transparent px-2.5 text-[var(--fs-caption)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                        onChange={(event) => setKeyword(event.target.value)}
                    />
                ) : null}
                {filteredCandidates.length > 0 ? (
                    <div className="thin-scrollbar max-h-52 space-y-1 overflow-y-auto pr-0.5">
                        {filteredCandidates.map((candidate) => {
                            const isBound = boundIds.has(candidate.id);
                            const badge = storyboardAssetNodeBadge(candidate);
                            const title = candidate.title || "未命名资产";
                            return (
                                <button
                                    key={candidate.id}
                                    type="button"
                                    aria-pressed={isBound}
                                    className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
                                        isBound
                                            ? "border-foreground/30 bg-foreground/[0.06]"
                                            : "border-transparent hover:border-foreground/15 hover:bg-foreground/[0.035]"
                                    }`}
                                    onClick={() => onChange(toggleStoryboardAssetBinding(bindings, candidate))}
                                >
                                    <span
                                        className={`grid size-4 shrink-0 place-items-center rounded border ${
                                            isBound ? "border-foreground/60 bg-foreground text-background" : "border-foreground/25"
                                        }`}
                                    >
                                        {isBound ? <Check className="size-3" /> : null}
                                    </span>
                                    <span className="relative grid size-7 shrink-0 place-items-center overflow-hidden rounded border border-foreground/10 bg-foreground/[0.04] text-foreground/50">
                                        <AssetThumbnail node={candidate} />
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-[var(--fs-caption)] font-medium" title={title}>
                                        {title}
                                    </span>
                                    <span className="shrink-0 rounded border border-foreground/15 px-1.5 py-0.5 text-[var(--fs-caption)] text-[var(--user-ink-muted)]">
                                        {badge}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                ) : (
                    <div className="py-3 text-center text-[var(--fs-caption)] text-[var(--user-ink-muted)]">
                        {eligibleNodes.length === 0 ? "画布暂无可关联的角色、图片、视频或音频节点" : "未找到匹配的画布资产"}
                    </div>
                )}
            </div>
        </div>
    );
}

function AssetThumbnail({ node }: { node: CanvasNodeData }) {
    const videoPreview = canvasNodeVideoPreviewUrl(node);
    const source = useNodeMediaSource(node.type === CanvasNodeType.Video ? null : node);
    const [failedUrl, setFailedUrl] = useState<string | null>(null);
    if (node.type === CanvasNodeType.Audio) return <Music2 className="size-4" />;
    if (node.metadata?.workflowKind === "character" && (!source || source === failedUrl)) return <UserRound className="size-4" />;
    if (node.type === CanvasNodeType.Video) {
        return videoPreview || node.metadata?.videoPreview?.storageKey ? (
            <>
                <CachedResourceImage
                    storageKey={node.metadata?.videoPreview?.storageKey}
                    src={videoPreview}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="size-full object-cover"
                    fallback={<Play className="size-4" />}
                />
                <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/15"><Play className="size-3.5 fill-white text-white" /></span>
            </>
        ) : <Play className="size-4" />;
    }
    return source && source !== failedUrl ? <img src={source} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-cover" onError={() => setFailedUrl(source)} /> : <ImageIcon className="size-4" />;
}

function AssetPreviewModal({ node, onClose }: { node: CanvasNodeData | null; onClose: () => void }) {
    const source = useNodeMediaSource(node);
    return (
        <Modal title={node?.title || "资产预览"} open={Boolean(node)} onCancel={onClose} footer={null} width={880} centered destroyOnHidden>
            {node ? (
                <div className="grid min-h-56 place-items-center overflow-hidden rounded-lg bg-black/[0.035] p-3 dark:bg-white/[0.035]" data-canvas-no-zoom>
                    {node.type === CanvasNodeType.Video && source ? <video src={source} controls autoPlay playsInline className="max-h-[68vh] max-w-full rounded-md" />
                        : node.type === CanvasNodeType.Audio && source ? <audio src={source} controls autoPlay className="w-full max-w-xl" />
                            : source ? <img src={source} alt={node.title || "资产预览"} className="max-h-[68vh] max-w-full object-contain" />
                                : <span className="text-sm text-foreground/45">当前资产没有可预览的媒体内容</span>}
                </div>
            ) : null}
        </Modal>
    );
}

function useNodeMediaSource(node: CanvasNodeData | null) {
    const fallback = node ? node.metadata?.workflowKind === "character"
        ? node.metadata.characterCoverUrl || ""
        : node.type === CanvasNodeType.Drawing
            ? node.metadata?.drawingPreviewUrl || node.metadata?.content || ""
            : node.metadata?.content || "" : "";
    const storageKey = ownedResourceStorageKey(node?.metadata?.storageKey, fallback);
    const safeFallback = isProtectedResourceFileUrl(fallback) ? "" : fallback;
    const [source, setSource] = useState(safeFallback);
    useEffect(() => {
        let cancelled = false;
        setSource(safeFallback);
        if (storageKey) void resolveMediaUrl(storageKey, fallback, { renderable: true }).then((url) => {
            if (!cancelled) setSource(isProtectedResourceFileUrl(url) ? safeFallback : url || safeFallback);
        }).catch(() => {
            if (!cancelled) setSource(safeFallback);
        });
        return () => { cancelled = true; };
    }, [fallback, safeFallback, storageKey]);
    return source;
}
