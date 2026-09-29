import { useEffect, useState } from "react";
import { ArrowUp, Move3d, Plus } from "lucide-react";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { resolveDirectorActiveShot, resolveDirectorPreviewSource, type DirectorNodeContentReader } from "@/lib/canvas/director/director-preview";
import { resolveImageUrl } from "@/services/image-storage";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { DirectorScene } from "@/types/director";

export function CanvasDirectorNodePanel({ node, scene, readNodeContent, onOpen, onAddReference, onSubmit, onPromptChange, professional = true }: { node: CanvasNodeData; scene: DirectorScene | null; readNodeContent: DirectorNodeContentReader; onOpen: () => void; onAddReference: () => void; onSubmit: () => void; onPromptChange: (value: string) => void; professional?: boolean }) {
    const theme = canvasThemes[useActiveTheme()];
    const shot = resolveDirectorActiveShot(scene, node.metadata?.directorShotId);
    // 记录「失败的那个 URL」而非布尔量：同一个坏 URL 不再反复渲染，换成另一个 URL 时自动重试。
    const [failedUrl, setFailedUrl] = useState<string | null>(null);
    const coverStorageKey = node.metadata?.directorCoverStorageKey;
    const [resolvedCover, setResolvedCover] = useState<{ key: string; url: string } | null>(null);
    useEffect(() => {
        if (!coverStorageKey) return;
        let live = true;
        void resolveImageUrl(coverStorageKey, node.metadata?.directorCoverUrl || "", { cacheMiss: true })
            .then((url) => { if (live && url) setResolvedCover({ key: coverStorageKey, url }); })
            .catch(() => { /* 旧预览或空态仍可使用。 */ });
        return () => { live = false; };
    }, [coverStorageKey, node.metadata?.directorCoverUrl]);
    const coverUrl = resolvedCover && resolvedCover.key === coverStorageKey ? resolvedCover.url : node.metadata?.directorCoverUrl;
    const preview = resolveDirectorPreviewSource({ scene, shot, coverUrl, failedUrl, previewNodeId: node.metadata?.directorPreviewNodeId, readNodeContent });

    return (
        <div className="flex h-full w-full min-h-0 flex-col gap-3 px-2 py-2" style={{ color: theme.node.text }}>
            <div className="flex min-h-0 flex-1 items-center justify-center">
                <button
                    type="button"
                    data-canvas-no-zoom
                    className="group relative aspect-square h-full max-w-full cursor-pointer overflow-hidden rounded-xl border focus-visible:outline-none focus-visible:ring-2 disabled:cursor-default"
                    style={{ background: theme.node.fill, borderColor: theme.node.stroke }}
                    aria-label={professional ? "打开导演台" : "切换到专业模式后编辑导演台"}
                    disabled={!professional}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => { event.stopPropagation(); onOpen(); }}
                >
                    {preview.kind === "image"
                        ? <img src={preview.url} alt={`${node.title} 导演台场景封面`} className="h-full w-full object-contain" draggable={false} onError={() => setFailedUrl(preview.url)} />
                        : <DirectorPreviewState kind={preview.kind} theme={theme} />}
                    {preview.kind === "image" ? <span className={`absolute inset-0 flex items-center justify-center text-sm font-medium transition-opacity ${professional ? "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" : "opacity-100"}`} style={{ background: `${theme.toolbar.panel}dd`, color: theme.node.text }}>{professional ? "打开导演台" : "专业模式可编辑"}</span> : null}
                </button>
            </div>
            <div className="relative h-24 shrink-0 overflow-hidden rounded-2xl border px-3 py-2" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
                <textarea
                    data-canvas-no-zoom
                    aria-label="场景描述"
                    placeholder="描述想要搭建的场景，支持通过参考图创建"
                    value={node.metadata?.composerContent ?? ""}
                    onChange={(event) => onPromptChange(event.target.value)}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            onSubmit();
                        }
                    }}
                    onWheel={(event) => event.stopPropagation()}
                    className="h-full w-full resize-none bg-transparent pb-8 text-sm leading-5 outline-none placeholder:opacity-60"
                    style={{ color: theme.node.text }}
                />
                <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center justify-between">
                    <button type="button" data-canvas-no-zoom aria-label="添加参考素材节点" title="上传参考素材到画布" className="pointer-events-auto grid size-8 place-items-center rounded-full transition hover:bg-black/10 dark:hover:bg-white/10" style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onAddReference(); }}>
                        <Plus className="size-6" aria-hidden />
                    </button>
                    <button type="button" data-canvas-no-zoom aria-label="在导演台中使用描述" title="在导演台中使用描述" className="pointer-events-auto grid size-9 place-items-center rounded-full transition hover:brightness-110" style={{ background: theme.node.text, color: theme.toolbar.panel }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSubmit(); }}>
                        <ArrowUp className="size-5" aria-hidden />
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * 诚实空态/准备态：不绘制地面、地平线、机位或任何伪 3D 物体。
 * 颜色全部走画布主题 token；层级靠字号/字重区分，不靠降低对比度。
 */
function DirectorPreviewState({ kind, theme }: { kind: "loading" | "empty"; theme: CanvasTheme }) {
    const loading = kind === "loading";
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-3 text-center">
            <Move3d className="size-7" style={{ color: theme.node.muted }} aria-hidden />
            <span className="text-xs leading-5" style={{ color: theme.node.muted }}>{loading ? "正在准备场景" : "在3D空间中搭建场景并进行多视角截图"}</span>
            <span className="rounded-lg px-3 py-1.5 text-xs" style={{ background: theme.toolbar.itemHover, color: theme.node.text }}>打开导演台</span>
        </div>
    );
}
