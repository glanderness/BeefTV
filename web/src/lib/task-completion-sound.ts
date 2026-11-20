import { onStorageNamespaceChange, scopedLocalStorage } from "@/lib/user-scope";

export const TASK_COMPLETION_SOUND_ENABLED_KEY = "beeftv.taskCompletionSoundEnabled";
export const SOUND_NOTIFIED_TASK_IDS_SESSION_KEY = "beeftv.soundNotifiedTaskIds";
export const TASK_COMPLETION_CHIME_THROTTLE_MS = 1500;

const MAX_TRACKED_TASK_IDS = 500;
const inMemoryNotifiedTaskIds = new Set<string>();
const changeListeners = new Set<() => void>();

let lastChimeAtMs = 0;

export type MinimalAudioParam = {
    value: number;
    setValueAtTime?: (value: number, startTime: number) => void;
    linearRampToValueAtTime?: (value: number, endTime: number) => void;
    exponentialRampToValueAtTime?: (value: number, endTime: number) => void;
};

export type MinimalOscillatorNode = {
    type: OscillatorType;
    frequency: MinimalAudioParam;
    connect: (destination: unknown) => void;
    start: (when?: number) => void;
    stop: (when?: number) => void;
    onended?: (() => void) | null;
};

export type MinimalGainNode = {
    gain: MinimalAudioParam;
    connect: (destination: unknown) => void;
};

export type MinimalAudioContext = {
    currentTime: number;
    state?: string;
    destination: unknown;
    resume?: () => Promise<void>;
    close?: () => Promise<void> | void;
    createOscillator: () => MinimalOscillatorNode;
    createGain: () => MinimalGainNode;
};

export type AudioContextConstructor = new () => MinimalAudioContext;

function notifySoundPreferenceListeners(): void {
    for (const listener of changeListeners) {
        try {
            listener();
        } catch {
            // Ignore listener failures so setting changes remain non-blocking.
        }
    }
}

export function onTaskCompletionSoundChange(listener: () => void): () => void {
    changeListeners.add(listener);
    const unsubscribeNamespace = onStorageNamespaceChange(listener);
    return () => {
        changeListeners.delete(listener);
        unsubscribeNamespace();
    };
}

export function getTaskCompletionSoundEnabled(): boolean {
    const raw = scopedLocalStorage.getItem(TASK_COMPLETION_SOUND_ENABLED_KEY);
    return raw === "true" || raw === "1";
}

export function setTaskCompletionSoundEnabled(enabled: boolean): void {
    scopedLocalStorage.setItem(TASK_COMPLETION_SOUND_ENABLED_KEY, enabled ? "true" : "false");
    notifySoundPreferenceListeners();
}

function readSessionNotifiedTaskIds(): Set<string> {
    const combined = new Set<string>(inMemoryNotifiedTaskIds);
    if (typeof window === "undefined") return combined;
    try {
        const raw = window.sessionStorage?.getItem(SOUND_NOTIFIED_TASK_IDS_SESSION_KEY);
        if (!raw) return combined;
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                if (typeof item === "string" && item.trim()) {
                    combined.add(item.trim());
                }
            }
        }
    } catch {
        // Ignore sessionStorage read errors in restricted environments.
    }
    return combined;
}

function writeSessionNotifiedTaskIds(ids: Set<string>): void {
    const list = Array.from(ids).slice(-MAX_TRACKED_TASK_IDS);
    inMemoryNotifiedTaskIds.clear();
    for (const id of list) {
        inMemoryNotifiedTaskIds.add(id);
    }
    if (typeof window === "undefined") return;
    try {
        window.sessionStorage?.setItem(SOUND_NOTIFIED_TASK_IDS_SESSION_KEY, JSON.stringify(list));
    } catch {
        // Ignore sessionStorage quota or security errors.
    }
}

export function hasTaskCompletionSoundPlayed(taskId: string): boolean {
    const normalized = String(taskId || "").trim();
    if (!normalized) return false;
    return readSessionNotifiedTaskIds().has(normalized);
}

function markTaskCompletionSoundPlayed(taskId: string): void {
    const normalized = String(taskId || "").trim();
    if (!normalized) return;
    const ids = readSessionNotifiedTaskIds();
    ids.add(normalized);
    writeSessionNotifiedTaskIds(ids);
}

function resolveAudioContextConstructor(override?: AudioContextConstructor): AudioContextConstructor | undefined {
    if (override) return override;
    if (typeof window !== "undefined") {
        const win = window as unknown as {
            AudioContext?: AudioContextConstructor;
            webkitAudioContext?: AudioContextConstructor;
        };
        if (typeof win.AudioContext === "function") return win.AudioContext;
        if (typeof win.webkitAudioContext === "function") return win.webkitAudioContext;
    }
    const g = globalThis as unknown as { AudioContext?: AudioContextConstructor };
    return typeof g.AudioContext === "function" ? g.AudioContext : undefined;
}

function scheduleNote(
    ctx: MinimalAudioContext,
    frequencyHz: number,
    startTime: number,
    durationSec: number,
    peakGain: number,
): MinimalOscillatorNode {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.type = "sine";
    if (oscillator.frequency.setValueAtTime) {
        oscillator.frequency.setValueAtTime(frequencyHz, startTime);
    } else {
        oscillator.frequency.value = frequencyHz;
    }

    if (gainNode.gain.setValueAtTime && gainNode.gain.linearRampToValueAtTime && gainNode.gain.exponentialRampToValueAtTime) {
        gainNode.gain.setValueAtTime(0.0001, startTime);
        gainNode.gain.linearRampToValueAtTime(peakGain, startTime + 0.015);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec);
    } else {
        gainNode.gain.value = peakGain;
    }

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    oscillator.start(startTime);
    oscillator.stop(startTime + durationSec + 0.01);
    return oscillator;
}

export function playTaskCompletionChime(options?: {
    force?: boolean;
    now?: number;
    AudioContextClass?: AudioContextConstructor;
}): boolean {
    const now = options?.now ?? Date.now();
    if (!options?.force && lastChimeAtMs > 0 && now - lastChimeAtMs < TASK_COMPLETION_CHIME_THROTTLE_MS) {
        return false;
    }
    const Ctor = resolveAudioContextConstructor(options?.AudioContextClass);
    if (!Ctor) return false;

    try {
        const ctx = new Ctor();
        lastChimeAtMs = now;
        if (ctx.state === "suspended" && typeof ctx.resume === "function") {
            void ctx.resume().catch(() => {});
        }
        const baseTime = Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0;
        scheduleNote(ctx, 587.33, baseTime, 0.14, 0.1);
        const secondNote = scheduleNote(ctx, 880, baseTime + 0.11, 0.22, 0.12);

        let closed = false;
        const closeContext = () => {
            if (closed) return;
            closed = true;
            if (typeof ctx.close === "function") {
                try {
                    void Promise.resolve(ctx.close()).catch(() => {});
                } catch {
                    // Ignore close errors.
                }
            }
        };
        secondNote.onended = closeContext;
        const timer = setTimeout(closeContext, 450);
        (timer as unknown as { unref?: () => void })?.unref?.();
        return true;
    } catch {
        return false;
    }
}

export function triggerSoundForCompletedTask(taskId?: string, options?: { now?: number }): boolean {
    if (!getTaskCompletionSoundEnabled()) return false;
    const normalized = String(taskId || "").trim();
    if (normalized && hasTaskCompletionSoundPlayed(normalized)) {
        return false;
    }
    const now = options?.now ?? Date.now();
    if (lastChimeAtMs > 0 && now - lastChimeAtMs < TASK_COMPLETION_CHIME_THROTTLE_MS) {
        // Coalesce concurrent completions within the throttle window so delayed retries do not double-chime.
        if (normalized) markTaskCompletionSoundPlayed(normalized);
        return false;
    }
    const played = playTaskCompletionChime({ now });
    if (played && normalized) {
        markTaskCompletionSoundPlayed(normalized);
    }
    return played;
}

export function resetTaskCompletionSoundStateForTests(): void {
    lastChimeAtMs = 0;
    inMemoryNotifiedTaskIds.clear();
    if (typeof window === "undefined") return;
    try {
        window.sessionStorage?.removeItem(SOUND_NOTIFIED_TASK_IDS_SESSION_KEY);
    } catch {
        // Ignore cleanup errors.
    }
}
