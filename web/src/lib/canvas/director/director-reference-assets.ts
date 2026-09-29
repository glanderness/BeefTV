import { applyCanvasConnectionPromptSync } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

/** Attach uploaded image nodes to a director shot using the canvas' normal resource-edge semantics. */
export function connectDirectorReferenceNodes(nodes: CanvasNodeData[], connections: CanvasConnection[], sourceIds: string[], targetId: string, createId: () => string) {
    const target = nodes.find((node) => node.id === targetId);
    if (!target || target.metadata?.workflowKind !== "shot") return { nodes, connections, linkedSourceIds: [] as string[] };
    const sourceById = new Map(nodes.map((node) => [node.id, node]));
    const sourceIdsUnique = [...new Set(sourceIds)].filter((id) => {
        const source = sourceById.get(id);
        return id !== targetId && source?.type === CanvasNodeType.Image && Boolean(source.metadata?.content);
    });
    if (!sourceIdsUnique.length) return { nodes, connections, linkedSourceIds: [] as string[] };

    const existingReferences = target.metadata?.referenceAssetNodeIds || [];
    const referenceAssetNodeIds = [...new Set([...existingReferences, ...sourceIdsUnique])];
    const existingEdges = new Set(connections.filter((edge) => edge.toNodeId === targetId).map((edge) => edge.fromNodeId));
    const addedEdges = sourceIdsUnique.filter((id) => !existingEdges.has(id)).map((id) => ({ id: createId(), fromNodeId: id, toNodeId: targetId }));
    const nextConnections = addedEdges.length ? [...connections, ...addedEdges] : connections;
    const nextNodes = referenceAssetNodeIds.length === existingReferences.length
        ? nodes
        : nodes.map((node) => node.id === targetId ? { ...node, metadata: { ...node.metadata, referenceAssetNodeIds } } : node);
    if (nextNodes === nodes && nextConnections === connections) return { nodes, connections, linkedSourceIds: sourceIdsUnique };
    return { nodes: applyCanvasConnectionPromptSync(nodes, connections, nextNodes, nextConnections), connections: nextConnections, linkedSourceIds: sourceIdsUnique };
}
