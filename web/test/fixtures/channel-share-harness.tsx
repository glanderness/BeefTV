import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { getAntThemeConfig } from "@/lib/app-theme";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { ChannelSettingsPane } from "@/pages/settings/channel-settings-pane";
import { commitModelConfig, hydrateModelConfig } from "@/services/model-config-repository";
import { useConfigStore } from "@/stores/use-config-store";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
const result = await hydrateModelConfig();
useConfigStore.getState().replaceConfig(result.config);
useConfigStore.subscribe((state) => { void commitModelConfig(state.config); });
createRoot(document.getElementById("root")!).render(
    <ConfigProvider theme={getAntThemeConfig(dark)}><App>
        <div className="app-product-workspace h-screen bg-background text-foreground">
            <WorkspacePage><ChannelSettingsPane onOpenDiagnostics={() => {}} /></WorkspacePage>
        </div>
    </App></ConfigProvider>,
);
