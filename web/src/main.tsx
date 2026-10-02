import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { bootstrapAppearance } from "@/services/appearance-bootstrap";
import { bootstrapDesktopRuntime } from "@/services/desktop-runtime";
import { hydrateLocalCanvasProjectsFromBackend } from "@/services/local-workspace-repository";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

async function startApplication() {
    await bootstrapDesktopRuntime();
    // 浏览器缓存晚于后端读入完成时，会用旧连接数组盖掉刚合并的画布。
    await useCanvasStore.persist.rehydrate();
    await hydrateLocalCanvasProjectsFromBackend();
    await bootstrapAppearance().finally(() => import("./application"));
}

void startApplication();
