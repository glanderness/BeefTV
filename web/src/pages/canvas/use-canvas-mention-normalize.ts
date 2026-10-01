import { useEffect, type Dispatch, type SetStateAction } from "react";

import { normalizeCanvasNodeMentionTokens, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { CanvasNodeData } from "@/types/canvas";

export function normalizeCanvasNodesMentionTokens(
    nodes: CanvasNodeData[],
    mentionReferencesByNodeId: Map<string, CanvasResourceReference[]>,
) {
    let changed = false;
    const next = nodes.map((node) => {
        const references = mentionReferencesByNodeId.get(node.id);
        const savedPrompt = node.metadata?.composerContent ?? node.metadata?.prompt;
        if (!references?.length || !savedPrompt?.includes("@[node:")) return node;
        const normalizedPrompt = normalizeCanvasNodeMentionTokens(savedPrompt, references);
        if (normalizedPrompt === savedPrompt) return node;
        changed = true;
        return {
            ...node,
            metadata: node.metadata?.composerContent !== undefined
                ? { ...node.metadata, composerContent: normalizedPrompt }
                : { ...node.metadata, prompt: normalizedPrompt },
        };
    });
    return changed ? next : nodes;
}

export function useCanvasMentionNormalize(
    mentionReferencesByNodeId: Map<string, CanvasResourceReference[]>,
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>,
) {
    useEffect(() => {
        setNodes((current) => normalizeCanvasNodesMentionTokens(current, mentionReferencesByNodeId));
    }, [mentionReferencesByNodeId, setNodes]);
}
