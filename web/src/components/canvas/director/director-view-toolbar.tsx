import { ChevronDown, Compass } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import { Tooltip } from "@/components/ui/base/tooltip";
import { releaseDirectorFocusAfterPointer } from "@/lib/canvas/director/director-shortcuts";
import { DIRECTOR_VIEW_MODES, type DirectorViewMode } from "@/lib/canvas/director/director-view-modes";

type DirectorViewToolbarProps = {
    viewMode: DirectorViewMode;
    onViewModeChange: (mode: DirectorViewMode) => void;
};

const primaryModes = new Set<DirectorViewMode>(["free", "camera"]);
const primaryLabels: Record<"free" | "camera", string> = { free: "导演视角", camera: "机位视角" };

/** Observe a scene without modifying its content or undo history. */
export function DirectorViewToolbar({ viewMode, onViewModeChange }: DirectorViewToolbarProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const primary = DIRECTOR_VIEW_MODES.filter((item) => primaryModes.has(item.mode));
    const orthographic = DIRECTOR_VIEW_MODES.filter((item) => !primaryModes.has(item.mode));
    const activeOrthographic = orthographic.find((item) => item.mode === viewMode);

    useEffect(() => {
        if (!menuOpen) return;
        const onPointerDown = (event: PointerEvent) => {
            if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") setMenuOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [menuOpen]);

    const chooseMode = (mode: DirectorViewMode, event: MouseEvent<HTMLButtonElement>) => {
        onViewModeChange(mode);
        setMenuOpen(false);
        releaseDirectorFocusAfterPointer(event);
    };

    return (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-[var(--z-toolbar)]">
            <div
                role="group"
                aria-label="导演台取景模式"
                className="pointer-events-auto absolute left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-[var(--r-lg)] border p-1 shadow-xl backdrop-blur"
                style={{ borderColor: "var(--director-sequencer-border)", background: "var(--director-dock-surface)", color: "var(--director-dock-fg)" }}
            >
                {primary.map((item) => {
                    const active = viewMode === item.mode;
                    const label = primaryLabels[item.mode as "free" | "camera"];
                    return (
                        <Tooltip key={item.mode} title={item.hint} placement="bottom">
                            <button
                                type="button"
                                aria-pressed={active}
                                aria-label={label}
                                title={item.hint}
                                className="inline-flex h-8 min-w-20 items-center justify-center whitespace-nowrap rounded-[var(--r-md)] px-3 text-[var(--fs-tiny)] font-medium transition-colors hover:bg-[var(--director-control-hover)] hover:text-[var(--director-dock-fg-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--control-focus-ring)] motion-reduce:transition-none"
                                style={active ? { background: "var(--director-dock-active-surface)", color: "var(--director-dock-fg-strong)" } : undefined}
                                onClick={(event) => chooseMode(item.mode, event)}
                            >
                                {label}
                            </button>
                        </Tooltip>
                    );
                })}
            </div>
            <div ref={menuRef} className="pointer-events-auto absolute right-3 top-0">
                <button
                    type="button"
                    aria-label="其他视角"
                    aria-expanded={menuOpen}
                    aria-haspopup="menu"
                    onClick={() => setMenuOpen((open) => !open)}
                    className="inline-flex h-10 items-center gap-1 rounded-[var(--r-lg)] border px-2 text-[var(--fs-tiny)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--control-focus-ring)]"
                    style={{ borderColor: "var(--director-sequencer-border)", background: "var(--director-dock-surface)", color: "var(--director-dock-fg)" }}
                >
                    <Compass className="size-4" aria-hidden />
                    <span>{activeOrthographic?.label || "视图"}</span>
                    <ChevronDown className="size-3" aria-hidden />
                </button>
                {menuOpen ? <div role="menu" aria-label="正交视角" className="absolute right-0 top-11 min-w-32 rounded-[var(--r-lg)] border p-1 shadow-xl" style={{ borderColor: "var(--director-sequencer-border)", background: "var(--director-dock-surface)", color: "var(--director-dock-fg)" }}>
                    {orthographic.map((item) => <button key={item.mode} type="button" role="menuitemradio" aria-checked={viewMode === item.mode} title={item.hint} onClick={(event) => chooseMode(item.mode, event)} className="flex w-full rounded-[var(--r-md)] px-3 py-2 text-left text-[var(--fs-tiny)] hover:bg-[var(--director-control-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--control-focus-ring)]">{item.label}</button>)}
                </div> : null}
            </div>
        </div>
    );
}
