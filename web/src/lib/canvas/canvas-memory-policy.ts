import { useEffect, useState } from "react";

export type CanvasMemoryMode = "normal" | "low-memory" | "thumbnail-only";
export type CanvasPreviewTier = 256 | 512 | 1024 | 2048;

const MEMORY_MODE_STORAGE_KEY = "beeftv-canvas-memory-mode";
const listeners = new Set<(mode: CanvasMemoryMode) => void>();

function normalizeMode(raw: string | null | undefined): CanvasMemoryMode | null {
    const value = (raw || "").trim().toLowerCase();
    if (value === "normal" || value === "low-memory" || value === "thumbnail-only") {
        return value;
    }
    return null;
}

function readInitialCanvasMemoryMode(): CanvasMemoryMode {
    if (typeof window !== "undefined") {
        try {
            const params = new URLSearchParams(window.location.search);
            const fromQuery = normalizeMode(params.get("memoryMode"));
            if (fromQuery) return fromQuery;
            if (params.get("safeMode") === "1" || params.get("safeMode") === "true") {
                return "thumbnail-only";
            }
        } catch {
            // Ignore URL parse issues in non-standard environments.
        }
        try {
            const saved = normalizeMode(window.localStorage?.getItem(MEMORY_MODE_STORAGE_KEY));
            if (saved) return saved;
        } catch {
            // Ignore localStorage failures.
        }
    }
    return "normal";
}

let currentMemoryMode: CanvasMemoryMode = readInitialCanvasMemoryMode();

export function getCanvasMemoryMode(): CanvasMemoryMode {
    return currentMemoryMode;
}

function clearMemoryModeQueryParams() {
    if (typeof window === "undefined" || typeof window.history?.replaceState !== "function") return;
    try {
        const parsed = new URL(window.location.href);
        if (!parsed.searchParams.has("safeMode") && !parsed.searchParams.has("memoryMode")) return;
        parsed.searchParams.delete("safeMode");
        parsed.searchParams.delete("memoryMode");
        const nextUrl = `${parsed.pathname}${parsed.search}${parsed.hash}`;
        window.history.replaceState(window.history.state, "", nextUrl);
    } catch {
        // Ignore URL/history failures in non-browser environments.
    }
}

export function applySessionCanvasMemoryMode(mode: CanvasMemoryMode) {
    if (currentMemoryMode === mode) return;
    currentMemoryMode = mode;
    for (const listener of listeners) {
        listener(mode);
    }
}

export function setCanvasMemoryMode(mode: CanvasMemoryMode) {
    clearMemoryModeQueryParams();
    if (currentMemoryMode === mode) return;
    currentMemoryMode = mode;
    if (typeof window !== "undefined") {
        try {
            window.localStorage?.setItem(MEMORY_MODE_STORAGE_KEY, mode);
        } catch {
            // Ignore localStorage failures.
        }
    }
    for (const listener of listeners) {
        listener(mode);
    }
}

export function subscribeCanvasMemoryMode(listener: (mode: CanvasMemoryMode) => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useCanvasMemoryMode(): [CanvasMemoryMode, (mode: CanvasMemoryMode) => void] {
    const [mode, setMode] = useState<CanvasMemoryMode>(() => getCanvasMemoryMode());
    useEffect(() => subscribeCanvasMemoryMode(setMode), []);
    return [mode, setCanvasMemoryMode];
}

export function normalizeCanvasPreviewTier(size?: number, mode: CanvasMemoryMode = getCanvasMemoryMode()): CanvasPreviewTier {
    const maxTier: CanvasPreviewTier =
        mode === "thumbnail-only" ? 256 : mode === "low-memory" ? 512 : 2048;
    const desired = size ?? maxTier;
    const clamped = Math.min(desired, maxTier);
    if (clamped <= 256) return 256;
    if (clamped <= 512) return 512;
    if (clamped <= 1024) return 1024;
    return 2048;
}

export function isVideoHoverPreviewAllowed(mode: CanvasMemoryMode = getCanvasMemoryMode()): boolean {
    return mode === "normal";
}
