import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ProjectPreview } from "@/components/canvas/canvas-project-card";
import { canvasSyncProgressKey, syncBeforeUnloadMessage, useSyncProgressStore } from "@/stores/use-sync-progress-store";

describe("local project progress copy", () => {
    test("renders local persistence copy instead of cloud sync copy during active save", () => {
        const projectId = "proj-progress-copy-test";
        const key = canvasSyncProgressKey(projectId);
        const progress = {
            projectId,
            phase: "saving" as const,
            completed: 1,
            total: 3,
            message: "saving",
        };
        const initialSyncing = useSyncProgressStore.getInitialState().syncingProjects;
        initialSyncing[key] = progress;
        useSyncProgressStore.setState({ syncingProjects: { [key]: progress } });
        try {
            const html = renderToStaticMarkup(
                <ProjectPreview project={{ id: projectId, nodes: [] }} />,
            );
            expect(html).toContain("本地保存中");
            expect(html).toContain("媒体保存");
            expect(html).not.toContain("云端同步中");
            expect(html).not.toContain("媒体上传");
            expect(syncBeforeUnloadMessage([progress])).toBe("画布正在保存到本地，请勿关闭页面。");
        } finally {
            delete initialSyncing[key];
            useSyncProgressStore.setState({ syncingProjects: {} });
        }
    });
});
