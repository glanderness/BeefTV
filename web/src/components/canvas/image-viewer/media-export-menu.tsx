import { App } from "antd";
import { ChevronDown, Copy, Download } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

import type { CanvasTheme } from "@/lib/canvas-theme";

type Props = {
    theme: CanvasTheme;
    onDownload: () => Promise<void>;
    onCopy?: () => Promise<void>;
};

export function MediaExportMenu({ theme, onDownload, onCopy }: Props) {
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const group = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const id = useId();

    useEffect(() => {
        if (!open) return;
        const dismiss = (event: PointerEvent) => {
            if (!group.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("pointerdown", dismiss, true);
        return () => document.removeEventListener("pointerdown", dismiss, true);
    }, [open]);

    const run = async (action: () => Promise<void>) => {
        setOpen(false);
        trigger.current?.focus();
        setBusy(true);
        try {
            await action();
        } catch (err) {
            message.error(err instanceof Error ? err.message : "操作失败，请重试");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div ref={group} className="relative" onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }} onKeyDown={(event) => {
            if (open && event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
            }
        }}>
            <button ref={trigger} type="button" aria-expanded={onCopy ? open : undefined} aria-controls={open ? id : undefined}
                aria-label={onCopy ? "下载与复制图片" : "下载视频"} disabled={busy} onClick={() => onCopy ? setOpen(!open) : void run(onDownload)}
                className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-md)] px-2.5 disabled:opacity-50"
                style={{ background: theme.toolbar.itemHover }}>
                <Download className="size-3.5" />
                <span className="hidden sm:inline">下载</span>
                {onCopy && <ChevronDown className="size-3" />}
            </button>
            {open && onCopy && (
                <div id={id} role="group" aria-label="图片操作" className="media-export-menu"
                    style={{ background: theme.node.panel, borderColor: theme.toolbar.border, "--viewer-item-hover": theme.toolbar.itemHover } as CSSProperties}>
                    <button type="button" data-testid="canvas-image-download" onClick={() => void run(onDownload)}>
                        <Download className="size-3.5" />下载原图
                    </button>
                    <button type="button" onClick={() => void run(onCopy)}>
                        <Copy className="size-3.5" />复制图片
                    </button>
                </div>
            )}
        </div>
    );
}
