import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button, ConfigProvider } from "antd";

import { AppWorkspaceShell } from "@/components/layout/app-top-nav";
import { FirstCreationGuide } from "@/components/onboarding/first-creation-guide";
import { WorkspaceOperationProgress } from "@/components/layout/workspace-operation-progress";
import { WorkspaceNotice } from "@/components/layout/workspace-notice";
import { hydrateLocalModelConfig } from "@/components/workspace/workspace-bootstrap-hydrator";
import { cn } from "@/lib/utils";
import { isEmbeddedRuntime, publishEmbeddedContext } from "@/lib/embedded-runtime";
import { createEmbeddedCanvasNoticeGate, createEmbeddedWorkspaceSyncHandler } from "@/lib/embedded-workspace-sync";
import { useEmbeddedAskResult } from "@/hooks/use-embedded-ask-result";
import { isSpatialWorkbenchPath } from "@/lib/workspace-routes";
import { getWorkspaceAntThemeConfig } from "@/lib/app-theme";
import { useWorkspaceButtonFeedback } from "@/hooks/use-workspace-button-feedback";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { notifyExternalCanvasEvent } from "@/services/canvas-external-writes";
import { hydrateLocalCanvasProjectsFromBackend, openLocalCanvasProjectFromBackend, refreshLocalCanvasProjectIfChanged } from "@/services/local-workspace-repository";
import { syncPluginsFromBackend } from "@/services/plugin-sync";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import "@/styles/workspace-product.css";

const workspaceTheme = getWorkspaceAntThemeConfig();

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const [canvasNoticeGate] = useState(() => createEmbeddedCanvasNoticeGate());
    const [workspaceNotice, setWorkspaceNotice] = useState<{ text: string; tone: "info" | "warning"; onOpen?: () => void } | null>(null);
    const showEmbeddedAskNotice = useCallback((text: string) => setWorkspaceNotice({ text, tone: "warning" }), []);
    useEmbeddedAskResult(showEmbeddedAskNotice);
    useEffect(() => {
        if (workspaceNotice?.tone !== "warning") return;
        const timer = setTimeout(() => setWorkspaceNotice(null), 5000);
        return () => clearTimeout(timer);
    }, [workspaceNotice]);
    const spatialWorkbench = isSpatialWorkbenchPath(pathname);
    const productWorkspace = !/^\/canvas\/[^/]+(?:\/|$)/.test(pathname);
    useWorkspaceButtonFeedback(productWorkspace);

    useLayoutEffect(() => {
        publishEmbeddedContext({ route: pathname, selectedNodeIds: [] });
    }, [pathname]);

    useEffect(() => {
        // A failed read keeps the plugins remembered in this browser.
        void syncPluginsFromBackend().catch(() => undefined);
    }, []);

    useEffect(() => {
        if (!isLocalWorkspaceMode()) return;
        const refreshProjects = () => {
            if (document.hidden) return;
            void hydrateLocalCanvasProjectsFromBackend();
        };
        window.addEventListener("focus", refreshProjects);
        document.addEventListener("visibilitychange", refreshProjects);
        return () => {
            window.removeEventListener("focus", refreshProjects);
            document.removeEventListener("visibilitychange", refreshProjects);
        };
    }, []);

    useEffect(() => {
        if (!isEmbeddedRuntime()) return;
        const onMessage = createEmbeddedWorkspaceSyncHandler({
            getPathname: () => pathname,
            hydrateProjects: () => { void hydrateLocalCanvasProjectsFromBackend(); },
            syncExtensions: () => {
                void syncPluginsFromBackend().catch(() => undefined);
                void hydrateLocalModelConfig().catch(() => undefined);
            },
            openCanvas: async (canvasId) => { await openLocalCanvasProjectFromBackend(canvasId); },
            refreshCanvas: async (canvasId) => { await refreshLocalCanvasProjectIfChanged(canvasId); },
            markExternalChange: notifyExternalCanvasEvent,
            findCanvasTitle: (canvasId) => useCanvasStore.getState().projects.find((project) => project.id === canvasId)?.title,
            canNotify: (canvasId) => canvasNoticeGate.allow(canvasId),
            openCanvasInUi: (canvasId) => navigate(`/canvas/${encodeURIComponent(canvasId)}`),
            notifyCanvasChange: (notice) => setWorkspaceNotice({ text: notice.text, tone: "info", onOpen: notice.onOpen }),
        });
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [canvasNoticeGate, navigate, pathname]);

    useLayoutEffect(() => {
        // Ant Design 浮层挂载在 body，必须用路由级标记隔离用户工作台与画布编辑器、运营后台。
        document.body.classList.add("app-user-overlays");
        document.body.classList.toggle("app-spatial-overlays", spatialWorkbench);
        document.body.classList.toggle("app-product-overlays", productWorkspace);
        return () => {
            document.body.classList.remove("app-user-overlays");
            document.body.classList.remove("app-spatial-overlays");
            document.body.classList.remove("app-product-overlays");
        };
    }, [spatialWorkbench, productWorkspace]);

    return (
        <ConfigProvider theme={productWorkspace ? workspaceTheme : undefined}>
            <div className={cn("app-user-workspace h-dvh overflow-hidden text-foreground", spatialWorkbench && "app-spatial-workspace", productWorkspace && "app-product-workspace", pathname === "/" && "app-home-route")}>
                <AppWorkspaceShell>{children}</AppWorkspaceShell>
                <FirstCreationGuide />
                <WorkspaceOperationProgress />
                {workspaceNotice ? (
                    <WorkspaceNotice
                        tone={workspaceNotice.tone}
                        title={workspaceNotice.text}
                        action={workspaceNotice.onOpen ? <Button size="small" autoInsertSpace={false} onClick={() => { const open = workspaceNotice.onOpen!; setWorkspaceNotice(null); open(); }}>打开</Button> : undefined}
                        onClose={() => setWorkspaceNotice(null)}
                    />
                ) : null}
            </div>
        </ConfigProvider>
    );
}
