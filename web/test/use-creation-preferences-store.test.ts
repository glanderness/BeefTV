import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasPresetPicker } from "@/components/canvas/canvas-preset-picker";
import { defaultConfig } from "@/stores/use-config-store";
import { savedVideoSettings, normalizeCreationComposerPreferences, useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";

describe("useCreationPreferencesStore (#091)", () => {
    const initialPreferences = useCreationPreferencesStore.getState().preferences;

    afterEach(() => {
        useCreationPreferencesStore.setState({ preferences: initialPreferences });
    });

    test("saves and removes custom user presets and normalizes persisted presets", () => {
        useCreationPreferencesStore.setState({ preferences: {} });
        const store = useCreationPreferencesStore.getState();

        const created = store.saveCustomPreset({
            name: "电影特写光影",
            prompt: "柔和侧逆光，电影级浅景深，人物眼神特写",
            mode: "image",
        });
        expect(created).not.toBeNull();
        expect(created?.name).toBe("电影特写光影");
        expect(created?.modes).toEqual(["image"]);
        expect(useCreationPreferencesStore.getState().preferences.customPresets).toHaveLength(1);

        const autoNamed = useCreationPreferencesStore.getState().saveCustomPreset({
            prompt: "跟随镜头缓慢推进，穿过霓虹雨夜街道",
            mode: "video",
        });
        expect(autoNamed?.name).toBe("跟随镜头缓慢推进，穿过霓虹雨夜街道");
        expect(useCreationPreferencesStore.getState().preferences.customPresets).toHaveLength(2);

        const renamed = useCreationPreferencesStore.getState().renameCustomPreset(created!.id, "  逆光人物眼神特写  ");
        expect(renamed?.name).toBe("逆光人物眼神特写");
        expect(useCreationPreferencesStore.getState().preferences.customPresets?.find((item) => item.id === created!.id)?.name).toBe("逆光人物眼神特写");

        // Blank names or unknown IDs are safely rejected without corrupting state.
        expect(useCreationPreferencesStore.getState().renameCustomPreset(created!.id, "   ")).toBeNull();
        expect(useCreationPreferencesStore.getState().renameCustomPreset("custom:missing", "新名称")).toBeNull();
        expect(useCreationPreferencesStore.getState().preferences.customPresets?.find((item) => item.id === created!.id)?.name).toBe("逆光人物眼神特写");

        const normalized = normalizeCreationComposerPreferences({
            customPresets: useCreationPreferencesStore.getState().preferences.customPresets,
        });
        expect(normalized.customPresets).toHaveLength(2);

        useCreationPreferencesStore.getState().removeCustomPreset(created!.id);
        expect(useCreationPreferencesStore.getState().preferences.customPresets).toHaveLength(1);
        expect(useCreationPreferencesStore.getState().preferences.customPresets?.[0]?.id).toBe(autoNamed?.id);

        useCreationPreferencesStore.getState().removeCustomPreset(autoNamed!.id);
        expect(useCreationPreferencesStore.getState().preferences.customPresets).toBeUndefined();
    });

    test("resetting image settings preserves video preferences", () => {
        useCreationPreferencesStore.setState({
            preferences: {
                promptFontSize: 16,
                mode: "image",
                image: { ratio: "16:9", quality: "high", count: "2" },
                video: { ratio: "9:16", seconds: "10", videoQuality: "1080p" },
            },
        });

        useCreationPreferencesStore.getState().resetImageSettings();
        expect(useCreationPreferencesStore.getState().preferences.image).toBeUndefined();
        expect(useCreationPreferencesStore.getState().preferences.video).toEqual({
            ratio: "9:16",
            seconds: "10",
            videoQuality: "1080p",
        });
        expect(useCreationPreferencesStore.getState().preferences.promptFontSize).toBe(16);

    });

    test("confirmed video settings survive reload and are isolated by channel and model", () => {
        useCreationPreferencesStore.setState({ preferences: {} });
        const store = useCreationPreferencesStore.getState();
        const a = { ...defaultConfig, model: "a::video", videoSeconds: "5", videoReturnLastFrame: "true" };
        const b = { ...a, model: "b::video", videoSeconds: "10" };
        store.confirmVideoSettings(a, { seed: 42 });
        store.rememberModelProvider("video", "b");
        store.rememberModelProvider("image", "a");
        store.rememberVideoReferenceMode("frames");
        store.confirmVideoSettings(b);
        const prefs = normalizeCreationComposerPreferences(JSON.parse(JSON.stringify(useCreationPreferencesStore.getState().preferences)));
        expect(savedVideoSettings(prefs, a.model, b.model)).toMatchObject({ seconds: "5", returnLastFrame: "true", h3Options: { seed: 42 } });
        expect(savedVideoSettings(prefs, b.model, b.model)?.seconds).toBe("10");
        expect(savedVideoSettings(prefs, "a::other", b.model)).toBeUndefined();
        expect(prefs.video).toEqual({ model: b.model });
        expect(prefs.videoReferenceMode).toBe("frames");
        expect(prefs.providers).toEqual({ video: "b", image: "a" });
        expect(normalizeCreationComposerPreferences({ video: { providerId: "legacy" } }).providers).toEqual({ video: "legacy" });
        store.confirmVideoSettings({ ...a, videoSeconds: "7" });
        expect(useCreationPreferencesStore.getState().preferences.videoByModel?.[a.model]?.seconds).toBe("7");
    });

    test("CanvasPresetPicker renders trigger button cleanly", () => {
        const html = renderToStaticMarkup(
            React.createElement(CanvasPresetPicker, {
                mode: "image",
                currentPrompt: "测试提示词",
                appearance: "quiet",
                dense: true,
                onSelect: () => {},
            }),
        );
        expect(html).toContain("预设");
    });
});
