import { ConfigProvider } from "antd";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { CanvasImageMaskEditor } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";

function buildConfig(includeSeedream: boolean): AiConfig {
    const models = includeSeedream ? ["gpt-image-2", "doubao-seedream-5-0-260128"] : ["gpt-image-2"];
    return {
        ...defaultConfig,
        model: "ch::gpt-image-2",
        imageModel: "ch::gpt-image-2",
        imageModels: models.map((item) => `ch::${item}`),
        models: models.map((item) => `ch::${item}`),
        channels: [
            {
                id: "ch",
                name: "图片渠道",
                models,
                interfaceType: "openai-image",
                modelProfiles: [
                    { model: "gpt-image-2", displayName: "GPT Image 2" },
                    ...(includeSeedream ? [{ model: "doubao-seedream-5-0-260128", displayName: "Seedream 5.0" }] : []),
                ],
            },
        ],
    };
}

function Harness() {
    const [sessionKey, setSessionKey] = useState(1);
    const [includeSeedream, setIncludeSeedream] = useState(true);
    const [cancelCount, setCancelCount] = useState(0);
    const remembered = useCreationPreferencesStore((state) => state.preferences.maskEditModel || "");

    return (
        <ConfigProvider theme={{ token: { motion: false } }} button={{ autoInsertSpace: false }}>
            <div style={{ padding: 120 }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 112 }}>
                    <button type="button" onClick={() => setSessionKey((k) => k + 1)}>
                        重新打开蒙版编辑
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setIncludeSeedream(false);
                            setSessionKey((k) => k + 1);
                        }}
                    >
                        下架 Seedream 并重开
                    </button>
                    <span data-testid="remembered-model">{remembered}</span>
                    <span data-testid="cancel-count">{cancelCount}</span>
                </div>
                <div style={{ position: "relative", width: 320, height: 320 }}>
                    <CanvasImageMaskEditor
                        key={sessionKey}
                        imageDimensions={{ width: 512, height: 512 }}
                        scale={1}
                        config={buildConfig(includeSeedream)}
                        onCancel={() => setCancelCount((count) => count + 1)}
                        onConfirm={() => {}}
                    />
                </div>
            </div>
        </ConfigProvider>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
