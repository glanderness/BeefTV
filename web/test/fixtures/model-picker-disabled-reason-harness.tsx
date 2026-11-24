import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelPicker } from "@/components/model-picker";
import { createModelChannel, defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { useCanvasThemeStore } from "@/stores/canvas/use-canvas-theme-store";
import { useThemeStore } from "@/stores/use-theme-store";

const testConfig: AiConfig = {
    ...defaultConfig,
    channels: [
        createModelChannel({
            id: "beeftv",
            name: "BeefTV 官方",
            scope: "system",
            pinned: true,
            enabled: true,
            models: ["seedream-5.0-pro", "moss-image-sft"],
            modelProfiles: [
                {
                    model: "seedream-5.0-pro",
                    displayName: "Seedream 5.0 Pro",
                    capability: "image",
                    imageCapabilitiesVersion: "2026-09",
                    capabilityConfig: {
                        image: {
                            size: { allowCustom: false, values: ["1K", "2K"] },
                            references: { maxImages: 4 },
                        },
                    },
                },
                {
                    model: "moss-image-sft",
                    displayName: "MOSS Image",
                    capability: "image",
                    imageCapabilitiesVersion: "2026-09",
                    capabilityConfig: {
                        image: {
                            size: { allowCustom: false, values: ["1K", "2K"] },
                            references: { maxImages: 0 },
                        },
                    },
                },
            ],
        }),
    ],
};

function Harness() {
    const params = new URLSearchParams(window.location.search);
    const themeName = params.get("theme") === "light" ? "light" : "dark";
    const appThemeName = params.get("appTheme") === "light" ? "light" : params.get("appTheme") === "dark" ? "dark" : themeName;
    const variant = params.get("variant") === "creation" ? "creation" : "canvas";
    useThemeStore.setState({ theme: appThemeName });
    useCanvasThemeStore.setState({ theme: themeName, active: true });
    document.documentElement.classList.toggle("dark", appThemeName === "dark");
    const [model, setModel] = useState("beeftv::seedream-5.0-pro");

    return (
        <div
            className="app-user-workspace"
            style={{
                minHeight: "100vh",
                padding: 32,
                background: themeName === "dark" ? "#111214" : "#f5f5f7",
                color: themeName === "dark" ? "#f3f4f6" : "#111827",
            }}
        >
            <div data-testid="selected-model" style={{ marginBottom: 12, fontSize: 12 }}>
                {model}
            </div>
            <ModelPicker
                config={testConfig}
                value={model}
                onChange={setModel}
                capability="image"
                variant={variant}
                requirements={{
                    capability: "image",
                    input: { imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 },
                }}
            />
        </div>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
