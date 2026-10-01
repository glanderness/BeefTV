import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasAssetHandoffAttempt, uninsertedCanvasAssetHandoffPayloads } from "@/lib/canvas/canvas-asset-handoff";
import type { Asset } from "@/stores/use-asset-store";
import type { CanvasFolderStyle, CanvasFolderTheme } from "@/types/canvas";

export type CanvasAssetHandoffPlan =
    | { kind: "idle" }
    | { kind: "wait"; key: string }
    | { kind: "commit"; key: string; payloads: InsertAssetPayload[] };

export function canvasAssetHandoffReadiness(assetIds: readonly string[], assets: Asset[]) {
    return assetIds
        .map((assetId) => {
            const asset = assets.find((candidate) => candidate.id === assetId);
            return `${assetId}:${asset?.kind || "missing"}`;
        })
        .join("|");
}

export function resolveCanvasAssetHandoffPlan(input: {
    projectLoaded: boolean;
    assetsHydrated: boolean;
    mode: string | null;
    projectId: string;
    assets: Asset[];
    searchParams: URLSearchParams;
    currentKey: string;
    nodes: Iterable<{ metadata?: { assetId?: unknown } }>;
}): CanvasAssetHandoffPlan {
    if (!input.projectLoaded || !input.assetsHydrated || input.mode !== "handoff") return { kind: "idle" };
    const attempt = canvasAssetHandoffAttempt(input.assets, input.searchParams);
    if (!attempt.assetIds.length) return { kind: "idle" };
    const key = `${input.projectId}:${canvasAssetHandoffReadiness(attempt.assetIds, input.assets)}`;
    if (input.currentKey === key) return { kind: "idle" };
    if (attempt.kind === "retry") return { kind: "wait", key };
    return {
        kind: "commit",
        key,
        payloads: uninsertedCanvasAssetHandoffPayloads(input.nodes, attempt.payloads),
    };
}

export function linkedFolderPresentation(folder: { style?: string; theme?: string }): { style: CanvasFolderStyle; theme: CanvasFolderTheme } {
    const style: CanvasFolderStyle = folder.style === "stacked" || folder.style === "midnight" || folder.style === "paper" || folder.style === "cinema" || folder.style === "compact" ? folder.style : "glass";
    const theme: CanvasFolderTheme = folder.theme === "obsidian" || folder.theme === "ember" || folder.theme === "pearl" ? folder.theme : "aurora";
    return { style, theme };
}
