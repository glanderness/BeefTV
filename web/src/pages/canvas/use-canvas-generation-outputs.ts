import { useCallback, useMemo, type RefObject } from "react";
import type { CanvasNodeActionContextValue } from "@/components/canvas/canvas-node-action-context";
import type { CanvasNodeData } from "@/types/canvas";
import type { GenerationOutput } from "@/lib/generation-outputs";
import { addGenerationOutputNodes, generationOutputMetadata } from "@/lib/canvas/canvas-generation-outputs";
import { resolveCanvasGenerationOutputs } from "@/services/canvas-generation-outputs";

export function useCanvasGenerationOutputs(nodesRef: RefObject<CanvasNodeData[]>, setNodes: (nodes: CanvasNodeData[]) => void, base: CanvasNodeActionContextValue) {
    const applyGenerationOutputs = useCallback(async (node: CanvasNodeData, outputs: GenerationOutput[], selectPrimary: boolean, signal?: AbortSignal) => {
        const taskId = node.metadata?.generationOutputTaskId;
        if (!taskId) throw new Error("节点缺少生成任务记录，请刷新结果后重试");
        const resolved = await resolveCanvasGenerationOutputs(taskId, outputs, signal);
        const source = nodesRef.current.find((item) => item.id === node.id);
        if (!source || source.metadata?.generationOutputTaskId !== taskId) throw new Error("节点已删除或生成结果已更新，请重新选择");
        if (selectPrimary) {
            if (resolved.length !== 1 || resolved[0].mediaType !== source.type) throw new Error("主输出类型与节点不匹配");
            const patch = generationOutputMetadata(resolved[0]);
            setNodes(nodesRef.current.map((item) => item.id === source.id ? { ...item, metadata: { ...item.metadata, ...patch } } : item));
        } else {
            setNodes(addGenerationOutputNodes(nodesRef.current, source, resolved));
        }
    }, [nodesRef, setNodes]);
 return useMemo(() => ({ ...base,
 addGenerationOutputs: (node: CanvasNodeData, outputs: GenerationOutput[], signal?: AbortSignal) => applyGenerationOutputs(node, outputs, false, signal),
 selectGenerationOutput: (node: CanvasNodeData, output: GenerationOutput, signal?: AbortSignal) => applyGenerationOutputs(node, [output], true, signal),
 }), [applyGenerationOutputs, base.upload, base.duplicate, base.deleteNode, base.download, base.updateMetadata, base.updateNode, base.updateMediaNode, base.resizeNode, base.openVideoSegment, base.openArtCritique, base.addPanoramaCaptureNode, base.startUpscaleBatch, base.recoverUpscaleResult]);
}
