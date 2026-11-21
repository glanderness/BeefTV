import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ProjectSyncProgressOverlay } from "@/components/canvas/canvas-project-card";
import { projectSyncProgress, syncBeforeUnloadMessage, useSyncProgressStore } from "@/stores/use-sync-progress-store";

describe("local project progress copy", () => {
    test("renders local persistence copy instead of cloud sync copy during active save", () => {
        const projectId = "proj-progress-copy-test";
        const progress = {
            projectId,
            phase: "saving" as const,
            completed: 1,
            total: 3,
            message: "saving",
        };
        useSyncProgressStore.getState().setProjectProgress(projectId, progress);
        try {
            const active = projectSyncProgress(projectId);
            expect(active).toEqual(progress);

            const html = renderToStaticMarkup(<ProjectSyncProgressOverlay syncProgress={progress} />);
            expect(html).toContain("本地保存中");
            expect(html).toContain("媒体保存");
            expect(html).toContain("1/3");
            expect(html).not.toContain("云端同步中");
            expect(html).not.toContain("媒体上传");
            expect(syncBeforeUnloadMessage([progress])).toBe("画布正在保存到本地，请勿关闭页面。");
        } finally {
            useSyncProgressStore.getState().clearAll();
        }
    });
});
