import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router";

import { CanvasPresetPicker, type CanvasPromptPreset } from "@/components/canvas/canvas-preset-picker";
import { getAntThemeConfig, getWorkspaceAntThemeConfig } from "@/lib/app-theme";
import { DEFAULT_CLASSIC_SKIN } from "@/lib/skin-themes";
import { PromptPreferencesPane } from "@/pages/settings/prompt-preferences-pane";
import { StorageSettingsPane } from "@/pages/settings/storage-settings-pane";

const workspaceTheme = getWorkspaceAntThemeConfig();

function Harness() {
    const params = new URLSearchParams(window.location.search);
    const view = params.get("view") || "preset";
    const dark = document.documentElement.classList.contains("dark");
    const [prompt, setPrompt] = useState("柔和侧逆光，35mm电影镜头，雨夜霓虹反射下的角色近景特写");
    const [selectedPresetName, setSelectedPresetName] = useState("");

    return (
        <ConfigProvider theme={getAntThemeConfig(dark, DEFAULT_CLASSIC_SKIN)}>
            <ConfigProvider theme={workspaceTheme}>
                <App>
                    <MemoryRouter>
                        <main className="app-user-workspace app-product-workspace p-6 text-foreground">
                            {view === "preset" ? (
                                <div style={{ paddingTop: 320 }}>
                                    <div data-testid="selected-preset-name">{selectedPresetName}</div>
                                    <div data-testid="current-prompt">{prompt}</div>
                                    <CanvasPresetPicker
                                        mode="image"
                                        currentPrompt={prompt}
                                        onSelect={(preset: CanvasPromptPreset) => {
                                            setSelectedPresetName(preset.name);
                                            setPrompt(preset.prompt);
                                        }}
                                    />
                                </div>
                            ) : view === "prompts" ? (
                                <PromptPreferencesPane />
                            ) : (
                                <StorageSettingsPane />
                            )}
                        </main>
                    </MemoryRouter>
                </App>
            </ConfigProvider>
        </ConfigProvider>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
