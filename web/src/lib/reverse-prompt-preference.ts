import { IMAGE_PROMPT_REVERSE, VIDEO_PROMPT_REVERSE } from "@/lib/prompts";
import { onStorageNamespaceChange, scopedLocalStorage } from "@/lib/user-scope";

export type ReversePromptKind = "image" | "video";

export const CUSTOM_IMAGE_REVERSE_PROMPT_KEY = "beeftv.reversePrompt.image";
export const CUSTOM_VIDEO_REVERSE_PROMPT_KEY = "beeftv.reversePrompt.video";

const changeListeners = new Set<() => void>();

function notifyReversePromptListeners(): void {
    for (const listener of changeListeners) {
        try {
            listener();
        } catch {
            // Ignore listener errors so preference updates remain reliable.
        }
    }
}

export function onReversePromptPreferenceChange(listener: () => void): () => void {
    changeListeners.add(listener);
    const unsubscribeNamespace = onStorageNamespaceChange(listener);
    return () => {
        changeListeners.delete(listener);
        unsubscribeNamespace();
    };
}

function storageKeyForKind(kind: ReversePromptKind): string {
    return kind === "video" ? CUSTOM_VIDEO_REVERSE_PROMPT_KEY : CUSTOM_IMAGE_REVERSE_PROMPT_KEY;
}

export function getDefaultReversePrompt(kind: ReversePromptKind): string {
    return kind === "video" ? VIDEO_PROMPT_REVERSE : IMAGE_PROMPT_REVERSE;
}

export function getCustomReversePrompt(kind: ReversePromptKind): string | null {
    const raw = scopedLocalStorage.getItem(storageKeyForKind(kind));
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function hasCustomReversePrompt(kind?: ReversePromptKind): boolean {
    if (kind) return getCustomReversePrompt(kind) !== null;
    return getCustomReversePrompt("image") !== null || getCustomReversePrompt("video") !== null;
}

export function getEffectiveReversePrompt(kind: ReversePromptKind): string {
    return getCustomReversePrompt(kind) ?? getDefaultReversePrompt(kind);
}

export function setCustomReversePrompt(kind: ReversePromptKind, prompt: string): string {
    const trimmed = String(prompt ?? "").trim();
    const defaultPrompt = getDefaultReversePrompt(kind);
    const key = storageKeyForKind(kind);
    if (!trimmed || trimmed === defaultPrompt.trim()) {
        scopedLocalStorage.removeItem(key);
        notifyReversePromptListeners();
        return defaultPrompt;
    }
    scopedLocalStorage.setItem(key, trimmed);
    notifyReversePromptListeners();
    return trimmed;
}

export function resetCustomReversePrompt(kind?: ReversePromptKind): void {
    if (!kind || kind === "image") {
        scopedLocalStorage.removeItem(CUSTOM_IMAGE_REVERSE_PROMPT_KEY);
    }
    if (!kind || kind === "video") {
        scopedLocalStorage.removeItem(CUSTOM_VIDEO_REVERSE_PROMPT_KEY);
    }
    notifyReversePromptListeners();
}
