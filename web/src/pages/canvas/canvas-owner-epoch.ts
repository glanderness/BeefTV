import { getActiveUserScope } from "@/lib/user-scope";

export type CanvasOwnerEpoch = {
    canvasId: string;
    userScope: string;
};

export function captureCanvasOwnerEpoch(canvasId: string, userScope = getActiveUserScope()): CanvasOwnerEpoch {
    return { canvasId, userScope };
}

export function canvasOwnerEpochMatches(owner: CanvasOwnerEpoch, liveCanvasId: string, liveUserScope = getActiveUserScope()) {
    return Boolean(owner.canvasId) && owner.canvasId === liveCanvasId && owner.userScope === liveUserScope;
}

/** Page React state is current while this canvas is open; after a switch, read the original canvas from storage. */
export function readOwnedCanvasNodes<T>(input: {
    owner: CanvasOwnerEpoch;
    liveCanvasId: string;
    pageNodes: T[];
    storedNodes?: T[] | null;
    liveUserScope?: string;
}): T[] {
    if (canvasOwnerEpochMatches(input.owner, input.liveCanvasId, input.liveUserScope)) return input.pageNodes;
    return input.storedNodes ?? [];
}

export async function runOwnedCanvasPageCommit<T>(input: {
    owner: CanvasOwnerEpoch;
    getLiveCanvasId: () => string;
    getLiveUserScope?: () => string;
    work: () => Promise<T>;
    onCommit: (result: T) => void;
}): Promise<"committed" | "abandoned"> {
    const result = await input.work();
    if (!canvasOwnerEpochMatches(input.owner, input.getLiveCanvasId(), input.getLiveUserScope?.())) return "abandoned";
    input.onCommit(result);
    return "committed";
}
