import { describe, expect, test } from "bun:test";

import { linkedFolderPresentation, resolveCanvasAssetHandoffPlan } from "@/pages/canvas/canvas-resource-handoff-plan";
import type { Asset } from "@/stores/use-asset-store";

function imageAsset(id: string): Asset {
    return {
        id,
        kind: "image",
        title: id,
        coverUrl: `/cover-${id}.png`,
        tags: [],
        status: "confirmed",
        source: "creation",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        data: { dataUrl: `/stored-${id}.png`, width: 720, height: 405, bytes: 1, mimeType: "image/png" },
    };
}

describe("resolveCanvasAssetHandoffPlan", () => {
    test("stays idle until the handoff query is ready", () => {
        const searchParams = new URLSearchParams({ mode: "handoff" });
        searchParams.append("asset", "asset-1");
        expect(resolveCanvasAssetHandoffPlan({
            projectLoaded: false,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams,
            currentKey: "",
            nodes: [],
        }).kind).toBe("idle");
        expect(resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "edit",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams,
            currentKey: "",
            nodes: [],
        }).kind).toBe("idle");
    });

    test("waits while any handoff asset is still missing, then commits uninserted payloads once", () => {
        const searchParams = new URLSearchParams({ mode: "handoff" });
        searchParams.append("asset", "asset-1");
        const waiting = resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [],
            searchParams,
            currentKey: "",
            nodes: [],
        });
        expect(waiting).toEqual({ kind: "wait", key: "canvas-1:asset-1:missing" });

        const commit = resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams,
            currentKey: "",
            nodes: [],
        });
        expect(commit.kind).toBe("commit");
        if (commit.kind !== "commit") return;
        expect(commit.payloads).toEqual([
            { kind: "image", dataUrl: "/stored-asset-1.png", storageKey: undefined, title: "asset-1", assetId: "asset-1" },
        ]);

        expect(resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams,
            currentKey: commit.key,
            nodes: [],
        }).kind).toBe("idle");

        expect(resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams,
            currentKey: "",
            nodes: [{ metadata: { assetId: "asset-1" } }],
        })).toMatchObject({ kind: "commit", payloads: [] });
    });
});

describe("linkedFolderPresentation", () => {
    test("keeps known folder style and theme, otherwise uses glass/aurora", () => {
        expect(linkedFolderPresentation({ style: "cinema", theme: "ember" })).toEqual({ style: "cinema", theme: "ember" });
        expect(linkedFolderPresentation({ style: "unknown", theme: "unknown" })).toEqual({ style: "glass", theme: "aurora" });
    });
});
