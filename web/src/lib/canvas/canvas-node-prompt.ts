import { renameCanvasNodeTitle } from "@/lib/canvas/canvas-generation-title";
import { getNodeResourceKind } from "@/lib/canvas/node-registry";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export type WriteCanvasNodePromptOptions = {
    metadata?: CanvasNodeMetadata;
    clearPromptTemplate?: boolean;
};

/**
 * A generated or authored result is committed once the node registry exposes it
 * as a resource. Text-like resources additionally require persisted content so
 * a draft prompt alone is not mistaken for a submitted result.
 */
export function canvasNodeHasCommittedContent(node: CanvasNodeData) {
    const resourceKind = getNodeResourceKind(node);
    if (resourceKind === "text") return Boolean(node.metadata?.content?.trim());
    return resourceKind !== null;
}

/**
 * Update the editable prompt draft without replacing the prompt snapshot that
 * produced an existing result. Callers may provide sanitized task metadata,
 * but prompt ownership remains centralized here.
 */
export function writeCanvasNodePrompt(node: CanvasNodeData, prompt: string, options: WriteCanvasNodePromptOptions = {}) {
    const metadata = options.metadata ?? node.metadata;
    const clearPromptTemplate = options.clearPromptTemplate ?? Boolean(metadata?.promptTemplateOperation);
    const promptTemplateMetadata = clearPromptTemplate
        ? { promptTemplateOperation: undefined, promptTemplateVariables: undefined }
        : {};
    return {
        ...node,
        metadata: canvasNodeHasCommittedContent(node)
            ? { ...metadata, ...promptTemplateMetadata, composerContent: prompt }
            : { ...metadata, ...promptTemplateMetadata, prompt, composerContent: prompt },
    };
}

export type CanvasTextNodeSave = {
    title: string;
    content: string;
    richText?: Record<string, unknown>;
};

/**
 * 文本编辑器的保存是第二个改名入口（标题在弹窗里可编辑）。内容编辑必须保留
 * 自动命名状态，只有标题真的变了才按改名处理，所以标题交给 renameCanvasNodeTitle，
 * 它会在标题未变时原样返回节点。
 */
export function saveCanvasTextNode(node: CanvasNodeData, input: CanvasTextNodeSave) {
    const renamed = renameCanvasNodeTitle(node, input.title);
    return { ...renamed, metadata: { ...renamed.metadata, content: input.content, richText: input.richText } };
}
