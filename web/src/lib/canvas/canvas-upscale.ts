import type { CapturedUserScope } from "@/lib/user-scope-guard";
import type { UpscaleMode, UpscaleParams, UpscaleSource } from "@/services/api/media-upscale";
import { nanoid } from "nanoid";
import type { CanvasNodeData } from "@/types/canvas";
import { findAvailableGenerationGroupPosition } from "./canvas-generation-layout";

export type QuotedUpscaleSource = { nodeId: string; fingerprint: string; source: UpscaleSource; mode: UpscaleMode; reservation: number };
export type UpscaleQuote = { id: string; projectId: string; epoch: number; scope: CapturedUserScope; params: UpscaleParams; sources: QuotedUpscaleSource[]; reservation: number };

export function createUpscaleResultNodes(origins: CanvasNodeData[], existing: CanvasNodeData[], factor: number): CanvasNodeData[] {
    const occupied = [...existing];
    return origins.map((source) => {
        const node: CanvasNodeData = {
            id: nanoid(),
            type: source.type,
            title: `${source.title || "素材"} · ${factor}× 超分`,
            position: findAvailableGenerationGroupPosition(occupied, { x: source.position.x + source.width + 96, y: source.position.y }, source),
            width: source.width,
            height: source.height,
            metadata: { status: "loading", prompt: "AI 超分", generatedFromNodeId: source.id },
        };
        occupied.push(node);
        return node;
    });
}
