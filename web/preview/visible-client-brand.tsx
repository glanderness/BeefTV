// 截图用预览页：用真实组件与免费的模拟数据渲染本次清理过的用户可见文案。
// 仅供本地预览与截图，不参与产品构建（vite build 只打包 index.html）。
//
// 主题与样式上下文必须和产品一致，否则弹窗拿不到 --user-* 变量，会出现深底黑字：
// AppProviders 的 ConfigProvider 主题 + applySkinTheme（application.tsx / app-providers.tsx），
// UserLayout 的工作台 ConfigProvider、.app-user-workspace / .app-product-workspace 与 body 浮层类（user-layout.tsx）。
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import "antd/dist/reset.css";
import "@/styles/globals.css";
import "@/styles/beeftv-local-overrides.css";
import "@/styles/workspace-product.css";
import "@/components/layout/workspace-sidebar-update.css";

import { AppChangelogButton } from "@/components/layout/app-changelog-modal";
import { WorkspaceSidebarSocialLinks } from "@/components/layout/workspace-sidebar-social-links";
import { UpscaleNodeContent } from "@/components/canvas/nodes/upscale-node";
import { CanvasNodeGraphContext } from "@/components/canvas/canvas-node-graph-context";
import { CanvasNodeActionContext } from "@/components/canvas/canvas-node-action-context";
import { useCanvasUpscaleBatch } from "@/pages/canvas/use-canvas-upscale-batch";
import { createDefaultUpscaleSettings } from "@/lib/canvas/canvas-upscale";
import { canvasThemes } from "@/lib/canvas-theme";
import { getAntThemeConfig, getWorkspaceAntThemeConfig } from "@/lib/app-theme";
import { applySkinTheme } from "@/lib/skin-themes";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasThemeStore } from "@/stores/canvas/use-canvas-theme-store";
import { setActiveUserScope } from "@/lib/user-scope";
import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

// 主题来源与产品一致：工作台跟随全局主题，画布跟随画布主题（默认跟随全局）。
const appearance = { skin: "classic", theme: useThemeStore.getState().theme };
applySkinTheme(appearance.skin, appearance.theme);
document.documentElement.classList.toggle("dark", appearance.theme === "dark");
document.documentElement.style.colorScheme = appearance.theme;
// Ant Design 浮层挂载在 body，用户工作台的浮层 token 由 body 上的这两个类提供。
document.body.classList.add("app-user-overlays", "app-product-overlays");
document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

const baseTheme = getAntThemeConfig(appearance.theme === "dark", appearance.skin);
const workspaceTheme = getWorkspaceAntThemeConfig();

// 内置渠道已连接（有凭据）时，超分节点才显示官方的超分模型选项。
setActiveUserScope("visible-client-brand-preview");
useConfigStore.setState(state => ({
    config: {
        ...state.config,
        channels: [createModelChannel({ id: "beefapi", pinned: true, enabled: true, credentialRef: "beefapi-enterprise", baseUrl: "https://enterprise.beefapi.com", models: [] })],
    },
}));

function UpscalePreview() {
    const [nodes, setNodes] = useState<CanvasNodeData[]>([
        { id: "source", title: "原图", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status: "success", storageKey: "resource:owned-source", naturalWidth: 100, naturalHeight: 100 } },
        { id: "processor", type: CanvasNodeType.Upscale, position: { x: 200, y: 0 }, width: 360, height: 200, metadata: { upscale: createDefaultUpscaleSettings() } },
    ]);
    const [connections, setConnections] = useState<CanvasConnection[]>([{ id: "edge", fromNodeId: "source", toNodeId: "processor" }]);
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    const connectionsRef = useRef(connections);
    connectionsRef.current = connections;
    const { startUpscaleBatch } = useCanvasUpscaleBatch({
        projectId: "visible-client-brand-preview",
        nodesRef,
        connectionsRef,
        setNodes,
        setConnections,
        setSelectedNodeIds: () => {},
        prepareResource: async () => "owned-source",
        observeTask: () => {},
    });
    const processor = nodes.find(node => node.id === "processor")!;
    return (
        <CanvasNodeGraphContext.Provider value={{ getUpstreamNodes: () => [nodes[0]], getNode: id => nodes.find(node => node.id === id) }}>
            <CanvasNodeActionContext.Provider
                value={{
                    updateMetadata: (id, patch) => setNodes(current => current.map(node => (node.id === id ? { ...node, metadata: { ...node.metadata, ...patch } } : node))),
                    startUpscaleBatch: async node => { await startUpscaleBatch(node); },
                }}
            >
                <div id="upscale-node" style={{ width: 360, height: 200, position: "relative" }}>
                    <UpscaleNodeContent node={processor} theme={canvasThemes[useCanvasThemeStore.getState().theme]} />
                </div>
            </CanvasNodeActionContext.Provider>
        </CanvasNodeGraphContext.Provider>
    );
}

function Preview() {
    return (
        <ConfigProvider locale={zhCN} theme={baseTheme} modal={{ centered: true }}>
            <App message={{ duration: 3, maxCount: 3 }} notification={{ duration: 4.5, maxCount: 3, placement: "topRight" }}>
                {/* 产品工作区：更新日志与侧栏社交入口所在的路由壳（UserLayout + app-product-workspace）。 */}
                <ConfigProvider theme={workspaceTheme}>
                    <div className="app-user-workspace app-product-workspace" style={{ display: "grid", gap: 32, padding: 24, minHeight: "100vh", alignContent: "start" }}>
                        <section>
                            <h2>更新日志入口（账户菜单里的同一个按钮）</h2>
                            <div id="changelog-entry" style={{ width: 280, padding: 8, borderRadius: 12, background: "var(--user-surface-muted)" }}>
                                <AppChangelogButton className="flex h-8 w-full items-center gap-2 rounded px-2 text-[var(--fs-label)] text-foreground/58 hover:bg-surface-hover hover:text-foreground [&_svg]:size-3.5" showLabel showVersion versionClassName="ml-auto text-[var(--fs-micro)] tabular-nums text-foreground/32" />
                            </div>
                        </section>
                        <section>
                            <h2>侧栏社交入口</h2>
                            <div id="social-links" style={{ width: 320, display: "flex", justifyContent: "flex-end" }}>
                                <WorkspaceSidebarSocialLinks />
                            </div>
                        </section>
                    </div>
                </ConfigProvider>
                {/* 画布编辑器：超分节点所在的路由壳（app-spatial-workspace，不套工作台主题）。 */}
                <div className="app-user-workspace app-spatial-workspace" style={{ display: "grid", gap: 32, padding: 24, paddingBottom: 520, alignContent: "start" }}>
                    <section>
                        <h2>超分模型</h2>
                        <UpscalePreview />
                    </section>
                </div>
            </App>
        </ConfigProvider>
    );
}

createRoot(document.getElementById("root")!).render(<Preview />);
