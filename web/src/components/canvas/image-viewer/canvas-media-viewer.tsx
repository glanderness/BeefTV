import { PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { CanvasTheme } from "@/lib/canvas-theme";
import "./image-viewer.css";

const FOCUSABLE_SELECTOR =
    "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

type Props = {
    kind: "图片" | "视频";
    testIdPrefix: "canvas-image" | "canvas-video";
    title: string;
    theme: CanvasTheme;
    titleDetails?: ReactNode;
    controls?: ReactNode;
    actions?: ReactNode;
    sidebar?: ReactNode;
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
    onClose: () => void;
    children: ReactNode;
};

export function CanvasMediaViewer({ kind, testIdPrefix, title, theme, titleDetails, controls, actions, sidebar, sidebarOpen, onToggleSidebar, onClose, children }: Props) {
    const dialogRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const dialog = dialogRef.current;
        const previousFocus = document.activeElement;
        dialog?.focus({ preventScroll: true });
        return () => {
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
                previousFocus.focus({ preventScroll: true });
            }
        };
    }, []);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const dialog = dialogRef.current;
            if (!dialog || event.defaultPrevented) return;
            if (event.key === "Escape" && !document.fullscreenElement && !dialog.querySelector("[data-fullscreen]")) {
                event.preventDefault();
                onClose();
            } else if (event.key === "Tab") {
                const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
                    .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible");
                const first = focusables[0];
                const last = focusables.at(-1);
                const active = document.activeElement;
                if (!dialog.contains(active) || active === dialog || active === (event.shiftKey ? first : last)) {
                    event.preventDefault();
                    ((event.shiftKey ? last : first) ?? dialog).focus({ preventScroll: true });
                }
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onClose]);

    const overlayRoot = typeof document !== "undefined" ? document.body : null;
    if (!overlayRoot) return null;

    return createPortal(
        <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`查看${kind}：${title}`}
            data-canvas-no-zoom data-canvas-media-viewer data-testid={`${testIdPrefix}-viewer-modal`}
            className="fixed inset-0 flex flex-col outline-none"
            style={{ background: theme.canvas.background, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4" style={{ background: theme.node.panel, borderColor: theme.toolbar.border }}>
                <div className="flex min-w-0 items-center gap-2.5">
                    <span title={title} className="viewer-heading truncate">{title}</span>
                    {titleDetails}
                </div>
                {controls}
                <div className="flex shrink-0 items-center gap-1.5">
                    {actions}
                    <button type="button" data-testid={`${testIdPrefix}-toggle-sidebar`} aria-pressed={sidebarOpen}
                        aria-label={sidebarOpen ? "收起生成信息栏" : "展开生成信息栏"}
                        title={sidebarOpen ? "收起生成信息" : "展开生成信息"}
                        className="grid size-8 place-items-center rounded-[var(--r-md)] border"
                        style={{ borderColor: theme.toolbar.border, background: sidebarOpen ? theme.toolbar.activeBg : theme.toolbar.itemHover }}
                        onClick={onToggleSidebar}
                    >
                        {sidebarOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
                    </button>
                    <button type="button" data-testid={`${testIdPrefix}-viewer-close`} aria-label={`关闭${kind}预览`}
                        className="grid size-8 place-items-center rounded-[var(--r-md)] hover:bg-black/6 dark:hover:bg-white/8"
                        onClick={onClose}
                    >
                        <X className="size-4" />
                    </button>
                </div>
            </header>
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
                {sidebarOpen ? sidebar : null}
            </div>
        </div>,
        overlayRoot,
    );
}
