import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    CANVAS_LOCAL_DRAFT_TAB_LABEL,
    CANVAS_SAVED_VERSION_TAB_LABEL,
    loadPersistedCanvasVersionHistory,
    partitionCanvasVersionHistory,
} from "../src/lib/canvas/canvas-version-history-source";
import type { CanvasHistoryEntry } from "../src/services/api/workspace-data";
import type { CanvasSyncDraft } from "../src/services/canvas-sync-drafts";

const versionHistory = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/canvas-version-history.tsx"), "utf8");

function snapshot(revision: number): CanvasHistoryEntry {
    return {
        id: `snap-${revision}`,
        canvasId: "lelvpvjEnuJ98wD_f2FI7",
        revision,
        title: "未命名项目",
        nodeCount: 3,
        connectionCount: 0,
        payloadBytes: 3694,
        reason: "automatic",
        createdAt: "2026-10-02T07:26:00.000Z",
        contentUpdatedAt: "2026-10-02T07:18:58.000Z",
    };
}

function draft(revision: number): CanvasSyncDraft {
    return {
        id: `draft-${revision}`,
        savedAt: "2026-10-02T07:30:00.000Z",
        project: {
            id: "lelvpvjEnuJ98wD_f2FI7",
            title: "未命名项目",
            revision,
            nodes: [],
            connections: [],
            createdAt: "2026-10-02T06:05:27.000Z",
            updatedAt: "2026-10-02T07:30:00.000Z",
        },
    } as CanvasSyncDraft;
}

describe("canvas version history source", () => {
    test("local workspace still reads persisted Go snapshots", async () => {
        const listed = await loadPersistedCanvasVersionHistory("lelvpvjEnuJ98wD_f2FI7", {
            list: async (id) => {
                expect(id).toBe("lelvpvjEnuJ98wD_f2FI7");
                return { snapshots: [snapshot(14)], currentRevision: 21 };
            },
        });
        expect(listed.snapshots.map((entry) => entry.revision)).toEqual([14]);
        await expect(loadPersistedCanvasVersionHistory("  ")).rejects.toThrow("缺少画布");
        await expect(loadPersistedCanvasVersionHistory("lelvpvjEnuJ98wD_f2FI7", {
            list: async () => {
                throw new Error("history unavailable");
            },
        })).rejects.toThrow("history unavailable");
    });

    test("saved snapshots and local drafts stay on separate lists", () => {
        const view = partitionCanvasVersionHistory({
            snapshots: [snapshot(14)],
            drafts: [draft(13)],
        });
        expect(view.saved.map((entry) => entry.revision)).toEqual([14]);
        expect(view.drafts.map((item) => item.project.revision)).toEqual([13]);
        expect(view.mixed).toBe(false);
        expect(partitionCanvasVersionHistory({
            snapshots: [snapshot(14)],
            drafts: [{ ...draft(13), id: "snap-14" }],
        }).mixed).toBe(true);
    });

    test("version panel loads persisted history in local workspace and restores only on click", () => {
        expect(CANVAS_SAVED_VERSION_TAB_LABEL).toBe("已保存版本");
        expect(CANVAS_LOCAL_DRAFT_TAB_LABEL).toBe("本机草稿");
        expect(versionHistory).toContain("loadPersistedCanvasVersionHistory");
        expect(versionHistory).toContain("partitionCanvasVersionHistory");
        expect(versionHistory).not.toContain("if (!open || localOnly) return");
        expect(versionHistory).toContain("CANVAS_SAVED_VERSION_TAB_LABEL");
        expect(versionHistory).toContain("CANVAS_LOCAL_DRAFT_TAB_LABEL");
        expect(versionHistory).toContain("history.restore");
        expect(versionHistory).toContain("modal.confirm");
        expect(versionHistory).toContain("恢复前会备份当前画布，并保留本机草稿。恢复后会生成一个新版本。");
        expect(versionHistory).not.toContain("云端历史");
        expect(versionHistory).not.toContain("打开记录时云端为");
    });
});
