import { App } from "antd";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { GenerationCostBadge } from "@/components/generation/generation-cost-badge";
import { BeefTVConnectionProvider, useBeefTVConnection } from "@/components/layout/beeftv-connection-provider";
import { ChannelSettingsPane } from "@/pages/settings/channel-settings-pane";
import { localWorkspaceConfig } from "@/lib/user-session";
import { commitModelConfig, hydrateModelConfig, withoutModelConfigAutosave } from "@/services/model-config-repository";
import { normalizeConfigSnapshot, resolveModelChannel, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";

// Mirrors production AppProviders ordering: WorkspaceBootstrapHydrator hydrates
// local-model-config first and only then mounts BeefTVConnectionProvider.
function HydratorGate({ children }: { children: ReactNode }) {
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        let ready = false;
        const unsubscribe = useConfigStore.subscribe((state) => {
            if (!ready || state.config.channels.length === 0) return;
            void commitModelConfig(state.config);
        });
        void hydrateModelConfig()
            .then((result) => {
                if (result.supersededByLocalEdit) return;
                const normalized = localWorkspaceConfig(normalizeConfigSnapshot({ config: result.config }).config);
                withoutModelConfigAutosave(() => {
                    useConfigStore.getState().replaceConfig(normalized);
                });
            })
            .finally(() => {
                ready = true;
                setHydrated(true);
            });
        return () => unsubscribe();
    }, []);

    if (!hydrated) return <div data-testid="hydrated-flag">no</div>;
    return <>{children}</>;
}

function SyncHarnessBody() {
    const config = useConfigStore((state) => state.config);
    const { connection, catalogConfigRevision } = useBeefTVConnection();
    const [prompt, setPrompt] = useState("我的镜头描述");

    const imageModels = selectableModelsByCapability(config, "image");
    const selectedModel = config.imageModel || imageModels[0] || "";
    const priceChannel = resolveModelChannel(config, selectedModel);
    const costTarget = useMemo(() => (
        selectedModel
            ? { modelKey: selectedModel, kind: "image" as const, parameters: { count: "1", size: "1:1" } }
            : null
    ), [selectedModel]);

    const showChannels = typeof window !== "undefined" && window.location.search.includes("pane=channels");

    return (
        <main className="p-4 space-y-3">
            <div data-testid="hydrated-flag">yes</div>
            <div data-testid="connection-state">{connection?.state || "none"}</div>
            <div data-testid="catalog-revision">{catalogConfigRevision}</div>
            <div data-testid="image-models">{imageModels.join(",")}</div>
            {showChannels ? <ChannelSettingsPane /> : null}
            <button
                type="button"
                data-testid="user-edit-btn"
                onClick={() => {
                    const current = useConfigStore.getState().config;
                    useConfigStore.getState().replaceConfig({ ...current, textModel: "beeftv::deepseek-v4.1-flash" });
                }}
            >
                保存用户配置
            </button>
            <textarea
                aria-label="提示词"
                data-testid="prompt-input"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
            />
            <GenerationCostBadge
                target={costTarget}
                refreshKey={`${priceChannel.modelProfiles?.length || 0}:${catalogConfigRevision}`}
            />
        </main>
    );
}

createRoot(document.getElementById("root")!).render(
    <App>
        <HydratorGate>
            <BeefTVConnectionProvider>
                <SyncHarnessBody />
            </BeefTVConnectionProvider>
        </HydratorGate>
    </App>,
);
