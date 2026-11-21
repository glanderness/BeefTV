import { useMemo } from "react";

import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasLibrarySummary } from "@/services/api/workspace-data";
import { listCanvasWorkspaceProjectRoots, previewNodesForWorkspaceProject } from "@/lib/canvas/canvas-workspace-project";
import { HomeDashboard } from "./home-dashboard";
import "./home-dashboard.css";

export default function HomePage() {
    const sessionHydrated = useUserStore((state) => state.hydrated);
    const localProjects = useCanvasStore((state) => state.projects);
    const localHydrated = useCanvasStore((state) => state.hydrated);
    const projects = useMemo<CanvasLibrarySummary[]>(() => listCanvasWorkspaceProjectRoots(localProjects)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 4)
        .map((project) => ({
            ...project,
            nodeCount: project.summaryNodeCount ?? project.nodes.length,
            previewNodes: previewNodesForWorkspaceProject(localProjects, project.id),
        })), [localProjects]);

    return <HomeDashboard projects={projects} loading={!sessionHydrated || !localHydrated} />;
}
