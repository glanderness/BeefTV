import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** Reclassifies legacy director cards that were persisted as video generators. */
export function normalizeDirectorCanvasNode(node: CanvasNodeData): CanvasNodeData {
    if (!node.metadata?.directorSceneId) return node;

    const needsCleanup = node.metadata.generationMode !== undefined
        || node.metadata.videoEditOperation !== undefined
        || node.metadata.composerContent !== undefined
        || node.metadata.prompt !== undefined;
    const hasLegacyDefaultSize = node.type === CanvasNodeType.Director && node.width === 560 && node.height === 560;
    if (node.type === CanvasNodeType.Director && !needsCleanup && !hasLegacyDefaultSize) return node;

    const metadata = { ...node.metadata };
    delete metadata.generationMode;
    delete metadata.videoEditOperation;
    delete metadata.composerContent;
    delete metadata.prompt;

    return {
        ...node,
        type: CanvasNodeType.Director,
        title: node.type === CanvasNodeType.Director ? node.title : "导演台",
        width: hasLegacyDefaultSize ? 640 : node.width,
        height: hasLegacyDefaultSize ? 640 : node.height,
        metadata,
    };
}
