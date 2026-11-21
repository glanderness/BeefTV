import { createRoot } from "react-dom/client";
import { WorkspaceBootstrapHydrator } from "@/components/workspace/workspace-bootstrap-hydrator";
import { getCanvasHydrationHealth, setCanvasHydrationHealth } from "@/services/canvas-hydration-health";

Object.assign(window, { getCanvasHydrationHealth, setCanvasHydrationHealth });

createRoot(document.getElementById("root")!).render(<WorkspaceBootstrapHydrator><button>开始创作</button></WorkspaceBootstrapHydrator>);
