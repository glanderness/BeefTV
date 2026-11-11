import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider, Select } from "antd";
import { MemoryRouter } from "react-router";
import { BeefTVConnectionProvider } from "@/components/layout/beeftv-connection-provider";
import { WorkspaceSidebarAccount } from "@/components/layout/workspace-sidebar-account";
import { WorkspaceSidebarSocialLinks } from "@/components/layout/workspace-sidebar-social-links";
import { AppModal } from "@/components/ui/product/app-modal";
import { getAntThemeConfig } from "@/lib/app-theme";
import { DEFAULT_CLASSIC_SKIN, skinCSSVariables } from "@/lib/skin-themes";
import { PluginCard } from "@/pages/plugins/plugin-card";
import { useThemeStore } from "@/stores/use-theme-store";
import { activate } from "../../../plugin-packages/beeftv-plugin-market/client/index.js";
import type { PluginCenterSectionContribution } from "@/lib/plugins/plugin-types";
import "@/styles/workspace-product.css";
import "@/pages/plugins/plugins.css";

let MarketSection: PluginCenterSectionContribution["render"] | undefined;
activate({
    React,
    ui: { requestInstallPlugin: () => {} },
    contribute(_slot: string, contribution: PluginCenterSectionContribution) {
        MarketSection = contribution.render || contribution.component;
        return () => {};
    },
});

const SimpleMarkdown = ({ source, className }: { source: string; className?: string }) => <div className={className}>{source}</div>;

function Harness() {
    const [collapsed, setCollapsed] = useState(false);
    const activeTheme = useThemeStore((state) => state.theme);
    const dark = activeTheme === "dark";
    const showMarket = location.pathname === "/market";

    useLayoutEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.colorScheme = activeTheme;
        for (const [property, value] of Object.entries(skinCSSVariables(DEFAULT_CLASSIC_SKIN, activeTheme))) {
            document.documentElement.style.setProperty(property, value);
        }
    }, [activeTheme, dark]);

    return (
        <ConfigProvider theme={getAntThemeConfig(dark)}>
            <App>
                <MemoryRouter>
                    <BeefTVConnectionProvider>
                        <main style={{ padding: 20, width: "100%", maxWidth: 960, boxSizing: "border-box" }}>
                            {showMarket && MarketSection ? (
                                <MarketSection
                                    pluginId="beeftv-plugin-market"
                                    Card={PluginCard}
                                    Button={Button}
                                    DetailsModal={AppModal}
                                    Markdown={SimpleMarkdown}
                                    RegistrySelect={Select}
                                    installedPlugins={[]}
                                />
                            ) : (
                                <>
                                    <Button onClick={() => setCollapsed((value) => !value)}>切换侧栏收起</Button>
                                    <div style={{ width: collapsed ? 56 : 240 }}>
                                        <WorkspaceSidebarSocialLinks collapsed={collapsed} onExpand={() => setCollapsed(false)} />
                                        <WorkspaceSidebarAccount collapsed={collapsed} />
                                    </div>
                                </>
                            )}
                        </main>
                    </BeefTVConnectionProvider>
                </MemoryRouter>
            </App>
        </ConfigProvider>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
