import { useEffect, useRef, type ChangeEvent, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { BookOpenCheck, Clapperboard, FileText, GripVertical, Image as ImageIcon, Lock, Move3d, Music2, Pencil, Settings2, Video } from "lucide-react";

import { CANVAS_VIEWPORT_PREVIEW_EVENT } from "@/lib/canvas/canvas-live-viewport";
import type { canvasThemes } from "@/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeTypeId } from "@/types/canvas";

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

export function NodeExternalHeader({ node, scale, dimensionLabel, active, editable, editing, draft, theme, onDragStart, onDraftChange, onEdit, onCommit, onCancel }: {
    node: CanvasNodeData;
    scale: number;
    dimensionLabel: string | null;
    active: boolean;
    editable: boolean;
    editing: boolean;
    draft: string;
    theme: CanvasTheme;
    onDraftChange: (value: string) => void;
    onDragStart?: (event: MouseEvent) => void;
    onEdit: () => void;
    onCommit: () => void;
    onCancel: () => void;
}) {
    const headerRef = useRef<HTMLDivElement>(null);
    const titleInputRef = useRef<HTMLInputElement>(null);
    const canceledRef = useRef(false);
    const isImage = node.type === CanvasNodeType.Image;
    useEffect(() => {
        if (!editing) return;
        canceledRef.current = false;
        const commitOutsideInput = (event: PointerEvent) => {
            const input = titleInputRef.current;
            if (!input || !(event.target instanceof Node) || input.contains(event.target)) return;
            // 画布手势可能阻止鼠标默认失焦，主动触发同一条 onBlur 保存路径。
            input.blur();
        };
        window.addEventListener("pointerdown", commitOutsideInput, true);
        return () => window.removeEventListener("pointerdown", commitOutsideInput, true);
    }, [editing]);
    useEffect(() => {
        const header = headerRef.current;
        if (!editing || !isImage || !header) {
            header?.style.removeProperty("--canvas-title-editor-max-width");
            header?.style.removeProperty("--canvas-title-editor-shift-x");
            return;
        }
        const viewportEl = header.closest("[data-canvas-viewport]");
        let appliedShiftX = 0;
        const updateBounds = () => {
            const rect = header.getBoundingClientRect();
            const naturalLeft = rect.left - appliedShiftX;
            const viewportRect = viewportEl?.getBoundingClientRect();
            const viewportLeft = viewportRect?.left ?? 0;
            const viewportRight = viewportRect?.right ?? window.innerWidth;
            const maxAllowed = Math.max(80, Math.floor(viewportRight - viewportLeft - 24));
            const rawAvailable = Math.floor(viewportRight - naturalLeft - 16);
            const minUsable = Math.min(160, maxAllowed);
            if (rawAvailable >= minUsable) {
                appliedShiftX = 0;
                header.style.setProperty("--canvas-title-editor-shift-x", "0px");
                header.style.setProperty("--canvas-title-editor-max-width", `${Math.min(rawAvailable, maxAllowed)}px`);
            } else {
                const maxLeftShift = Math.max(0, Math.floor(naturalLeft - (viewportLeft + 12)));
                const neededShift = Math.min(minUsable - rawAvailable, maxLeftShift);
                appliedShiftX = -neededShift;
                const budget = Math.max(0, Math.min(rawAvailable + neededShift, maxAllowed));
                header.style.setProperty("--canvas-title-editor-shift-x", `${appliedShiftX}px`);
                header.style.setProperty("--canvas-title-editor-max-width", `${budget}px`);
            }
        };
        updateBounds();
        window.addEventListener("resize", updateBounds);
        viewportEl?.addEventListener(CANVAS_VIEWPORT_PREVIEW_EVENT, updateBounds);
        return () => {
            window.removeEventListener("resize", updateBounds);
            viewportEl?.removeEventListener(CANVAS_VIEWPORT_PREVIEW_EVENT, updateBounds);
            header.style.removeProperty("--canvas-title-editor-max-width");
            header.style.removeProperty("--canvas-title-editor-shift-x");
        };
    }, [editing, isImage, scale]);
    const inverseScale = 1 / Math.max(scale, 0.05);
    const isDirectorNode = node.type === CanvasNodeType.Director || Boolean(node.metadata?.directorSceneId);
    const Icon = isDirectorNode ? Move3d : nodeTypeIcon(node.type);
    const editorProps = {
        ref: titleInputRef,
        autoFocus: true,
        value: draft,
        "data-canvas-no-zoom": "",
        onChange: (event: ChangeEvent<HTMLInputElement>) => onDraftChange(event.target.value),
        onFocus: (event: FocusEvent<HTMLInputElement>) => {
            canceledRef.current = false;
            event.currentTarget.select();
        },
        onBlur: () => { if (!canceledRef.current) onCommit(); },
        onDoubleClick: (event: MouseEvent<HTMLInputElement>) => event.stopPropagation(),
        onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
            if (event.nativeEvent.isComposing || (event.key !== "Enter" && event.key !== "Escape")) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") {
                canceledRef.current = true;
                onCancel();
            } else {
                event.currentTarget.blur();
            }
        },
        "aria-label": "节点名称",
    };

    return (
        <div
            ref={headerRef}
            className="canvas-node-external-header absolute bottom-full left-0 z-[var(--node-z-overlay)] flex min-h-6 items-center gap-1"
            data-canvas-live-scale
            data-compact-title={isImage ? "true" : undefined}
            data-active={active || editing ? "true" : undefined}
            data-expanded={!isImage && (active || editing) ? "true" : undefined}
            data-editing={editing ? "true" : undefined}
            style={{
                "--canvas-node-width": `${node.width}px`,
                "--canvas-node-header-width": `min(240px, max(112px, calc(var(--canvas-node-width) * var(--canvas-live-scale, ${scale}))))`,
                borderRadius: "var(--r-sm)",
                color: active ? theme.node.text : theme.node.label,
                transform: editing && isImage
                    ? `scale(var(--canvas-live-inverse-scale, ${inverseScale})) translateX(var(--canvas-title-editor-shift-x, 0px))`
                    : `scale(var(--canvas-live-inverse-scale, ${inverseScale}))`,
                transformOrigin: "left bottom",
            } as CSSProperties}
            onMouseDown={(event) => {
                // LibTV 的节点标题图标区域同时承担拖拽入口；名称按钮仍保留独立的重命名点击。
                // 只在非交互子控件上把事件交给画布选择控制器，避免点击标题时误触发移动。
                if (event.button !== 0) return;
                if ((event.target as HTMLElement).closest("button, input")) return;
                onDragStart?.(event);
            }}
            onPointerDown={(event) => {
                if (event.button !== 0) return;
                if ((event.target as HTMLElement).closest("button, input")) return;
                event.stopPropagation();
            }}
        >
            <div className="flex min-w-0 flex-1 items-center gap-1">
                <button
                    type="button"
                    // LibTV 标题行只展示节点类型图标；保留无障碍拖动按钮，但不额外绘制抓手，
                    // 节点主体仍支持拖动，避免标题前出现一组原版没有的竖向点。
                    className="flex size-0 shrink-0 touch-none items-center justify-center overflow-hidden rounded p-0 opacity-0 cursor-grab active:cursor-grabbing disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-1"
                    aria-label={node.metadata?.locked ? "节点已锁定" : `拖动节点：${node.title}`}
                    title={node.metadata?.locked ? "节点已锁定，请先解锁" : isImage ? "拖动此处移动节点；双击名称可重命名" : "拖动此处移动节点；点击名称可重命名"}
                    disabled={!onDragStart || Boolean(node.metadata?.locked)}
                    onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        // HTML / SVG 正文在跨源沙箱中；捕获指针，避免经过 iframe 后丢失 move / up。
                        event.preventDefault();
                        event.stopPropagation();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        onDragStart?.(event);
                    }}
                >
                    {node.metadata?.locked ? <Lock className="size-3" /> : <GripVertical className="size-3" strokeWidth={1.8} />}
                </button>
                <Icon className="canvas-node-title-type-icon size-3 shrink-0" strokeWidth={1.8} data-node-header-icon={isDirectorNode ? "director" : undefined} />
                {editing && isImage ? (
                    <span className="canvas-image-title-editor text-xs font-medium">
                        <span aria-hidden="true" className="canvas-image-title-sizer">{draft}{"\u00a0"}</span>
                        <input
                            {...editorProps}
                            size={1}
                            className="h-6 w-full min-w-0 rounded bg-transparent outline-none focus-visible:outline focus-visible:outline-1"
                            style={{ background: theme.node.fill, color: theme.node.text, outlineColor: theme.node.muted }}
                        />
                    </span>
                ) : editing ? (
                    <input
                        {...editorProps}
                        className="h-6 min-w-20 max-w-[190px] flex-1 truncate rounded bg-transparent px-1.5 text-xs font-medium outline-none"
                        style={{ background: "transparent", color: theme.node.text }}
                    />
                ) : editable ? (
                    <button
                        type="button"
                        className="group flex min-w-0 flex-1 items-center gap-1 rounded px-0.5 text-left text-xs font-medium outline-none transition-opacity hover:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                        style={{ opacity: active ? 1 : 0.78, outlineColor: theme.node.muted }}
                        onClick={isImage ? (event) => {
                            if (event.detail === 0 || (event.target instanceof Element && Boolean(event.target.closest(".canvas-node-title-edit-icon")))) {
                                onEdit();
                            }
                        } : onEdit}
                        onDoubleClick={isImage ? onEdit : undefined}
                        title={isImage ? undefined : node.title}
                        aria-label={`编辑节点名称：${node.title}`}
                    >
                        <span className="canvas-node-title-text min-w-0 truncate">{node.title}</span>
                        <Pencil className="canvas-node-title-edit-icon size-2.5 shrink-0 opacity-55 transition-opacity group-hover:opacity-100" />
                    </button>
                ) : (
                    <span className="canvas-node-title-text min-w-0 flex-1 truncate text-xs font-medium" title={isImage ? undefined : node.title} style={{ opacity: active ? 1 : 0.78 }}>{node.title}</span>
                )}
            </div>
            {dimensionLabel ? <span className="ml-auto shrink-0 whitespace-nowrap text-[var(--fs-micro)] font-medium leading-none tabular-nums" style={{ color: theme.node.muted }}>{dimensionLabel}</span> : null}
        </div>
    );
}

function nodeTypeIcon(type: CanvasNodeTypeId) {
    if (type === CanvasNodeType.Image) return ImageIcon;
    if (type === CanvasNodeType.Video) return Video;
    if (type === CanvasNodeType.Audio) return Music2;
    if (type === CanvasNodeType.Drawing) return Pencil;
    if (type === CanvasNodeType.Script) return Clapperboard;
    if (type === CanvasNodeType.Config) return Settings2;
    if (type === CanvasNodeType.Skill) return BookOpenCheck;
    return FileText;
}
