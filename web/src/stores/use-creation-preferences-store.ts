import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { scopedLocalStorage } from "@/lib/user-scope";
import type { AiConfig, ModelCapability } from "@/stores/use-config-store";
import type { VideoGenerationControls } from "@/lib/model-capabilities";
import type { CanvasGenerationMode, CanvasVideoReferenceMode } from "@/types/canvas";

export type CreationModePreference = "text" | "image" | "video";

export type CreationImagePreferences = {
    model?: string;
    ratio?: string;
    quality?: string;
    count?: string;
    transparentBackground?: string;
};

export type CreationVideoPreferences = {
    model?: string;
    ratio?: string;
    seconds?: string;
    videoQuality?: string;
    generateAudio?: string;
    watermark?: string;
    draft?: string;
    returnLastFrame?: string;
    arkPrivateAssetUpload?: string;
    h3Options?: VideoGenerationControls;
};

export type CreationCustomPreset = {
    id: string;
    name: string;
    description: string;
    prompt: string;
    modes: CanvasGenerationMode[];
};

export type CreationComposerPreferences = {
    promptFontSize?: number;
    mode?: CreationModePreference;
    image?: CreationImagePreferences;
    video?: CreationVideoPreferences;
    providers?: Partial<Record<ModelCapability | "transcription", string>>;
    videoReferenceMode?: CanvasVideoReferenceMode;
    videoByModel?: Record<string, CreationVideoPreferences>;
    customPresets?: CreationCustomPreset[];
};

export type CreationPreferences = CreationComposerPreferences;

type CreationPreferencesStore = {
    hydrated: boolean;
    preferences: CreationComposerPreferences;
    rememberMode: (mode: CreationModePreference) => void;
    rememberPromptFontSize: (fontSize: number) => void;
    rememberImageSettings: (settings: CreationImagePreferences) => void;
    rememberModelProvider: (capability: ModelCapability | "transcription", providerId: string) => void;
    rememberVideoReferenceMode: (mode: CanvasVideoReferenceMode) => void;
    confirmVideoSettings: (config: AiConfig, h3Options?: VideoGenerationControls) => void;
    resetImageSettings: () => void;
    saveCustomPreset: (input: { name?: string; description?: string; prompt: string; mode: CanvasGenerationMode; modes?: CanvasGenerationMode[] }) => CreationCustomPreset | null;
    renameCustomPreset: (id: string, name: string) => CreationCustomPreset | null;
    removeCustomPreset: (id: string) => void;
};

export const CREATION_PREFERENCES_STORE_KEY = "open_ai_canvas:creation_preferences";
export const DEFAULT_PROMPT_FONT_SIZE = 12;
export const MIN_PROMPT_FONT_SIZE = 12;
export const MAX_PROMPT_FONT_SIZE = 28;

function normalizePromptFontSize(value: number) {
    return Math.min(MAX_PROMPT_FONT_SIZE, Math.max(MIN_PROMPT_FONT_SIZE, Math.round(value)));
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && Boolean(value.trim());
}

function normalizeImagePreferences(value: unknown): CreationImagePreferences | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const preferences = {
        ...(nonEmptyString(raw.model) ? { model: raw.model } : {}),
        ...(nonEmptyString(raw.ratio) ? { ratio: raw.ratio } : {}),
        ...(nonEmptyString(raw.quality) ? { quality: raw.quality } : {}),
        ...(nonEmptyString(raw.count) ? { count: raw.count } : {}),
        ...(nonEmptyString(raw.transparentBackground) ? { transparentBackground: raw.transparentBackground } : {}),
    };
    return Object.keys(preferences).length ? preferences : undefined;
}

function normalizeVideoPreferences(value: unknown): CreationVideoPreferences | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const preferences = {
        ...(nonEmptyString(raw.model) ? { model: raw.model } : {}),
        ...(nonEmptyString(raw.ratio) ? { ratio: raw.ratio } : {}),
        ...(nonEmptyString(raw.seconds) ? { seconds: raw.seconds } : {}),
        ...(nonEmptyString(raw.videoQuality) ? { videoQuality: raw.videoQuality } : {}),
        ...(nonEmptyString(raw.generateAudio) ? { generateAudio: raw.generateAudio } : {}),
        ...(nonEmptyString(raw.watermark) ? { watermark: raw.watermark } : {}),
        ...(nonEmptyString(raw.arkPrivateAssetUpload) ? { arkPrivateAssetUpload: raw.arkPrivateAssetUpload } : {}),
        ...(nonEmptyString(raw.returnLastFrame) ? { returnLastFrame: raw.returnLastFrame } : {}),
        ...(raw.h3Options && typeof raw.h3Options === "object" && !Array.isArray(raw.h3Options) ? { h3Options: raw.h3Options as VideoGenerationControls } : {}),
        ...(nonEmptyString(raw.draft) ? { draft: raw.draft } : {}),
    };
    return Object.keys(preferences).length ? preferences : undefined;
}

const VALID_GENERATION_MODES = new Set<CanvasGenerationMode>(["text", "image", "video", "audio"]);

function normalizeCustomPresets(value: unknown): CreationCustomPreset[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const presets = value.flatMap((item): CreationCustomPreset[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const raw = item as Record<string, unknown>;
        if (!nonEmptyString(raw.id) || !nonEmptyString(raw.name) || !nonEmptyString(raw.prompt)) return [];
        const modes = Array.isArray(raw.modes)
            ? raw.modes.filter((m): m is CanvasGenerationMode => typeof m === "string" && VALID_GENERATION_MODES.has(m as CanvasGenerationMode))
            : [];
        if (!modes.length) return [];
        return [{
            id: raw.id.trim(),
            name: raw.name.trim(),
            description: nonEmptyString(raw.description) ? raw.description.trim() : raw.prompt.trim().slice(0, 48),
            prompt: raw.prompt.trim(),
            modes,
        }];
    });
    return presets.length ? presets : undefined;
}

export function normalizeCreationComposerPreferences(value: unknown): CreationComposerPreferences {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const raw = value as Record<string, unknown>;
    const image = normalizeImagePreferences(raw.image);
    const video = normalizeVideoPreferences(raw.video);
    const providers: Partial<Record<ModelCapability | "transcription", string>> = {};
    if (raw.video && typeof raw.video === "object" && "providerId" in raw.video && nonEmptyString(raw.video.providerId)) {
        providers.video = raw.video.providerId;
    }
    if (raw.providers && typeof raw.providers === "object") {
        for (const [key, id] of Object.entries(raw.providers)) {
            if ((key === "transcription" || VALID_GENERATION_MODES.has(key as CanvasGenerationMode)) && nonEmptyString(id)) providers[key as ModelCapability | "transcription"] = id;
        }
    }
    const videoByModel: Record<string, CreationVideoPreferences> = {};
    if (raw.videoByModel && typeof raw.videoByModel === "object") {
        for (const [model, entry] of Object.entries(raw.videoByModel)) {
            const settings = normalizeVideoPreferences(entry);
            if (settings && model.includes("::")) videoByModel[model] = settings;
        }
    }
    const customPresets = normalizeCustomPresets(raw.customPresets);
    return {
        ...(typeof raw.promptFontSize === "number" && Number.isFinite(raw.promptFontSize) ? { promptFontSize: normalizePromptFontSize(raw.promptFontSize) } : {}),
        ...(raw.mode === "text" || raw.mode === "image" || raw.mode === "video" ? { mode: raw.mode } : {}),
        ...(image ? { image } : {}),
        ...(video ? { video } : {}),
        ...(raw.videoReferenceMode === "all" || raw.videoReferenceMode === "frames" ? { videoReferenceMode: raw.videoReferenceMode } : {}),
        ...(Object.keys(providers).length ? { providers } : {}),
        ...(Object.keys(videoByModel).length ? { videoByModel } : {}),
        ...(customPresets ? { customPresets } : {}),
    };
}

export function savedVideoSettings(preferences: CreationComposerPreferences, model: string, defaultModel: string) {
    const saved = preferences.videoByModel?.[model];
    if (saved) return saved;
    const legacy = preferences.video;
    return model === (legacy?.model || defaultModel) ? legacy : undefined;
}

export const useCreationPreferencesStore = create<CreationPreferencesStore>()(
    persist(
        (set) => ({
            hydrated: false,
            preferences: {},
            rememberMode: (mode) => set((state) => ({ preferences: { ...state.preferences, mode } })),
            rememberPromptFontSize: (fontSize) => {
                if (Number.isFinite(fontSize)) set((state) => ({ preferences: { ...state.preferences, promptFontSize: normalizePromptFontSize(fontSize) } }));
            },
            rememberImageSettings: (settings) => set((state) => ({ preferences: { ...state.preferences, image: { ...state.preferences.image, ...settings } } })),
            rememberModelProvider: (capability, providerId) => set(({ preferences }) => ({
                preferences: { ...preferences, providers: { ...preferences.providers, [capability]: providerId } },
            })),
            rememberVideoReferenceMode: (mode) => set(({ preferences }) => ({ preferences: { ...preferences, videoReferenceMode: mode } })),
            confirmVideoSettings: (config, h3Options) => set(({ preferences }) => {
                if (!config.model) return { preferences };
                const videoByModel = { ...preferences.videoByModel };
                const previous = preferences.video;
                // Keep the legacy model's settings when the first confirmed run uses a different model.
                if (previous?.model && !videoByModel[previous.model]) videoByModel[previous.model] = previous;
                videoByModel[config.model] = {
                    ratio: config.size, seconds: config.videoSeconds, videoQuality: config.vquality,
                    generateAudio: config.videoGenerateAudio, watermark: config.videoWatermark,
                    draft: config.videoDraft, returnLastFrame: config.videoReturnLastFrame,
                    arkPrivateAssetUpload: config.videoArkPrivateAssetUpload, h3Options,
                };
                return { preferences: { ...preferences, video: { model: config.model }, videoByModel } };
            }),
            resetImageSettings: () =>
                set((state) => {
                    const { image: _image, ...rest } = state.preferences;
                    return { preferences: rest };
                }),
            saveCustomPreset: ({ name, description, prompt, mode, modes }) => {
                const cleanPrompt = prompt.trim();
                if (!cleanPrompt) return null;
                const compactPrompt = cleanPrompt.replace(/\s+/g, " ");
                const cleanName = name?.trim() || compactPrompt.slice(0, 18);
                const cleanDescription = description?.trim() || compactPrompt.slice(0, 48);
                const targetModes = modes?.length ? modes : [mode];
                const created: CreationCustomPreset = {
                    id: `custom:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    name: cleanName,
                    description: cleanDescription,
                    prompt: cleanPrompt,
                    modes: targetModes,
                };
                set((state) => ({
                    preferences: {
                        ...state.preferences,
                        customPresets: [created, ...(state.preferences.customPresets || [])],
                    },
                }));
                return created;
            },
            renameCustomPreset: (id, name) => {
                const cleanId = id.trim();
                const cleanName = name.trim();
                if (!cleanId || !cleanName) return null;
                let updated: CreationCustomPreset | null = null;
                set((state) => {
                    const current = state.preferences.customPresets || [];
                    const index = current.findIndex((item) => item.id === cleanId);
                    if (index < 0) return state;
                    const nextItem: CreationCustomPreset = {
                        ...current[index]!,
                        name: cleanName,
                    };
                    updated = nextItem;
                    const next = [...current];
                    next[index] = nextItem;
                    return {
                        preferences: {
                            ...state.preferences,
                            customPresets: next,
                        },
                    };
                });
                return updated;
            },
            removeCustomPreset: (id) =>
                set((state) => {
                    const next = (state.preferences.customPresets || []).filter((item) => item.id !== id);
                    const { customPresets: _prev, ...rest } = state.preferences;
                    return {
                        preferences: next.length ? { ...rest, customPresets: next } : rest,
                    };
                }),
        }),
        {
            name: CREATION_PREFERENCES_STORE_KEY,
            storage: createJSONStorage(() => scopedLocalStorage),
            partialize: (state) => ({ preferences: state.preferences }),
            merge: (persisted, current) => {
                const stored = (persisted || {}) as Partial<CreationPreferencesStore>;
                return { ...current, preferences: normalizeCreationComposerPreferences(stored.preferences) };
            },
            onRehydrateStorage: () => () => {
                useCreationPreferencesStore.setState({ hydrated: true });
            },
        },
    ),
);
