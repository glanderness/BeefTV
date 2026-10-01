import { finalizeCanvasAssetHandoff } from "@/lib/canvas/canvas-asset-handoff";
import type { CanvasNodeData } from "@/types/canvas";

import { canvasOwnerEpochMatches, type CanvasOwnerEpoch } from "./canvas-owner-epoch";

export function rebaseCreatedCanvasNodes<T extends { id: string }>(live: T[], created: T[]) {
    const createdIds = new Set(created.map((node) => node.id));
    return [...live.filter((node) => !createdIds.has(node.id)), ...created];
}

export function applyArchivedCanvasNodeAssets(
    current: CanvasNodeData[],
    archivedByNodeId: Map<string, { assetId: string; content: unknown; previousAssetId: unknown }>,
) {
    return current.map((node) => {
        const archived = archivedByNodeId.get(node.id);
        if (!archived || node.metadata?.content !== archived.content || node.metadata?.assetId !== archived.previousAssetId) return node;
        return { ...node, metadata: { ...node.metadata, assetId: archived.assetId } };
    });
}

export async function commitOwnedCanvasAssetHandoff<T extends { id: string }>(input: {
    owner: CanvasOwnerEpoch;
    getLiveCanvasId: () => string;
    getLiveUserScope?: () => string;
    stillOwnsPage?: () => boolean;
    searchParams: URLSearchParams;
    createdNodes: T[];
    readLiveNodes: () => T[];
    persist: (nodes: T[]) => Promise<void>;
    consumeUrl: (searchParams: URLSearchParams) => void;
    applyCreated: (createdNodes: T[]) => void;
    resetAttempt: () => void;
}): Promise<"committed" | "abandoned" | "failed"> {
    try {
        const finalized = await finalizeCanvasAssetHandoff({
            searchParams: input.searchParams,
            currentNodes: input.readLiveNodes(),
            createdNodes: input.createdNodes,
            persist: input.persist,
        });
        const stillOwns = input.stillOwnsPage
            ? input.stillOwnsPage()
            : canvasOwnerEpochMatches(input.owner, input.getLiveCanvasId(), input.getLiveUserScope?.());
        if (!stillOwns) return "abandoned";
        input.applyCreated(input.createdNodes);
        input.consumeUrl(finalized.searchParams);
        return "committed";
    } catch {
        input.resetAttempt();
        return "failed";
    }
}
