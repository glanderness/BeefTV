import { useEffect, useEffectEvent, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { ImageSettingsPanel, imageCountDisplay, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasPopoverLayer, notifyCanvasPopoverOpen, subscribeCanvasPopoverOpen } from "@/lib/canvas/canvas-popover-layer";
import { normalizeImageValue } from "@/lib/model-capabilities";
import { mergedImageCapabilityConfig } from "@/lib/model-selection";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { seedreamFamily, seedreamSizeLabel } from "@/lib/seedream-image";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    autoAdjustOverflow?: boolean;
    showCount?: boolean;
    summaryOverride?: string;
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onOpenChange, buttonClassName, placement = "topLeft", showCount = true, summaryOverride }: CanvasImageSettingsPopoverProps) {
    const theme = canvasThemes[useActiveTheme()];
    const popoverId = useId();
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [editingWidth, setEditingWidth] = useState<string>();
    const open = editingWidth !== undefined;
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const profile = mergedImageCapabilityConfig(config, config.model || config.imageModel);
    const normalized = normalizeImageValue(profile, config);
    const seedream = seedreamFamily(config.model || config.imageModel);
    const layers = config.seedreamMode === "layers";
    const sizeLabel = (seedream && seedreamSizeLabel(profile, normalized.size, layers)) || imageSizeLabel(normalized.size, profile);
    const countDisplay = imageCountDisplay(config, profile, seedream);
    const summaryParts = [
        ...(seedream && layers ? ["图层拆分"] : []),
        ...(profile.size.parameter !== "none" ? [sizeLabel] : []),
        ...(profile.quality.supported ? [imageQualityLabel(normalized.quality)] : []),
        ...(showCount && profile.maxOutputs > 1 ? [`${normalized.count} ${countDisplay.unit}`] : []),
        ...(countDisplay.groupLimit ? [`每组最多 ${countDisplay.groupLimit} 张`] : []),
        ...(profile.transparentBackground.supported && normalized.transparentBackground === "true" ? ["透明"] : []),
    ];
    const summary = summaryOverride || summaryParts.join(" · ");
    const hasSettings = profile.size.parameter !== "none" || profile.quality.supported || profile.transparentBackground.supported || (showCount && profile.maxOutputs > 1);
    const updateOpen = (nextOpen: boolean) => {
        if (nextOpen) notifyCanvasPopoverOpen(popoverId);
        // Keep the anchor in place while editing. Between sessions its width follows the summary.
        setEditingWidth(nextOpen && buttonRef.current ? getComputedStyle(buttonRef.current).width : undefined);
        onOpenChange?.(nextOpen);
    };

    const closeFromOutside = useEffectEvent(() => {
        setEditingWidth(undefined);
        onOpenChange?.(false);
    });
    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) document.activeElement.blur();
            closeFromOutside();
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        const unsubscribeCanvasPopover = subscribeCanvasPopoverOpen(popoverId, () => closeFromOutside());
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
            unsubscribeCanvasPopover();
        };
    }, [open, popoverId]);

    const panel = open && buttonRect ? <ImageSettingsPortal layer={canvasPopoverLayer(buttonRef.current)} buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} showCount={showCount} onConfigChange={onConfigChange} /> : null;

    if (!hasSettings) return null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0 max-w-full" style={{ width: editingWidth }}>
                <Button size="small" type="text" className={`canvas-generation-settings-trigger ${buttonClassName || "!h-8 !max-w-[180px] !justify-start !rounded-full !px-2.5"}`} style={{ background: theme.node.fill, color: theme.node.text, width: open ? "100%" : undefined }} icon={<Settings2 className="size-3.5" />} aria-expanded={open} aria-label={`高级设置：${summary}`} title={`高级设置 · ${summary}`} onClick={() => updateOpen(!open)}>
                    <span className="truncate">{summary}</span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function ImageSettingsPortal({
    layer,
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    showCount,
    onConfigChange,
}: {
    layer: number | string;
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasImageSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    showCount: boolean;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
}) {
    const gap = 8;
    const margin = 12;
    const width = Math.min(356, window.innerWidth - margin * 2);
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const above = buttonRect.top - gap - margin;
    const below = window.innerHeight - buttonRect.bottom - gap - margin;
    const placeAbove = topPlacement ? above >= 370 || above >= below : below < 370 && above > below;
    const style = {
        position: "fixed",
        zIndex: layer,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(placeAbove ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: above } : { top: buttonRect.bottom + gap, maxHeight: below }),
        background: theme.canvas.background,
        border: `1px solid ${theme.toolbar.border}`,
        borderRadius: 10,
        boxShadow: `0 24px 72px ${theme.spatial.shadow}`,
        padding: 12,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            data-canvas-settings-popover
            className="canvas-image-settings-popover aceternity-floating-panel backdrop-blur-2xl"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <ImageSettingsPanel showTitle={false} config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} showCount={showCount} quickCount={3} className="space-y-3" />

        </div>,
        document.body,
    );
}
