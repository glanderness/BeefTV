import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { buildCanvasResourceReferences, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { useCanvasDocumentState } from "./use-canvas-document-state";
import type { useCanvasProjectDialogs } from "./use-canvas-project-dialogs";
import type { useCanvasRenderModel } from "./use-canvas-render-model";
import type { useCanvasGenerationOrchestration } from "./use-canvas-generation-orchestration";
import type { useCanvasNodeEditor } from "./use-canvas-node-editor";
import type { useCanvasNodeOperations } from "./use-canvas-node-operations";
import type { useCanvasSelectionController } from "./use-canvas-selection-controller";
import type { useCanvasNodeReferences } from "./use-canvas-node-references";
const EMPTY_RESOURCE_REFERENCES: CanvasResourceReference[] = [];

type Props = {
    node: CanvasNodeData;
    projectId: string;
    videoModel: string;
    document: ReturnType<typeof useCanvasDocumentState>;
    dialogs: ReturnType<typeof useCanvasProjectDialogs>;
    renderModel: ReturnType<typeof useCanvasRenderModel>;
    generation: ReturnType<typeof useCanvasGenerationOrchestration>;
    nodeEditor: ReturnType<typeof useCanvasNodeEditor>;
    pageUi: CanvasPageUiStoreHook;
    referenceActions: ReturnType<typeof useCanvasNodeReferences>;
    onFocusNode: (id: string) => void;
    onCreateReplacement: ReturnType<typeof useCanvasNodeOperations>["createGenerationReplacement"];
    onNodeMouseDown: ReturnType<typeof useCanvasSelectionController>["handleNodeMouseDown"];
};

export function CanvasProjectNodePrompt({ node: panelNode, projectId, videoModel, document, dialogs,
    renderModel, generation, nodeEditor, pageUi, referenceActions, onFocusNode: focusCanvasNode,
    onCreateReplacement: createGenerationReplacement, onNodeMouseDown: handleNodeMouseDown,
}: Props) {
    const { nodesRef, connectionsRef } = document;
    const { configInputsById, mentionReferencesByNodeId, skillMentionReferences } = renderModel;
    const { handleConfigNodeChange, handleNodePromptChange } = nodeEditor;
    const { handleGenerateNode, runningNodeId } = generation;
    const { setDialogNodeId, setNodeImageSettingsOpen, setToolbarNodeId } = pageUi.getState();
    const { setGenerationHistoryOpen } = dialogs;
    const { handleRemoveNodeReference, handleReorderNodeReferences, handleReplaceNodeReference, handleReplaceNodeReferenceFiles } = referenceActions;
    const workspaceMode = "professional";
    if (panelNode.type === CanvasNodeType.Script || panelNode.type === CanvasNodeType.Drawing) return null;
    return panelNode.type === CanvasNodeType.Config ? (
        <CanvasConfigComposer
            model={panelNode.metadata?.model || videoModel}
            value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
            inputs={configInputsById.get(panelNode.id) || []}
            skillReferences={skillMentionReferences}
            generationMode={panelNode.metadata?.generationMode}
            metadata={panelNode.metadata}
            workspaceMode={workspaceMode}
            onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
            onMetadataChange={(patch) => handleConfigNodeChange(panelNode.id, patch)}
            onClose={() => setDialogNodeId(null)}
        />
    ) : (
        <CanvasNodePromptPanel
            projectId={projectId}
            node={panelNode}
            referenceNodes={nodesRef.current}
            referenceConnections={connectionsRef.current}
            onLocateReferenceNode={focusCanvasNode}
            isRunning={isCanvasNodeGenerating(panelNode, runningNodeId)}
            mentionReferences={[
                ...(mentionReferencesByNodeId.get(panelNode.id) || EMPTY_RESOURCE_REFERENCES),
                ...buildCanvasResourceReferences(nodesRef.current, connectionsRef.current).filter((reference) => reference.kind === "text" && reference.nodeId !== panelNode.id && !(mentionReferencesByNodeId.get(panelNode.id) || []).some((active) => active.nodeId === reference.nodeId)),
            ]}
            onAddReference={referenceActions.addTextReference}
            onPromptChange={handleNodePromptChange}
            onConfigChange={handleConfigNodeChange}
            onGenerate={handleGenerateNode}
            onOpenGenerationHistory={() => setGenerationHistoryOpen(true)}
            onCreateGenerationReplacement={createGenerationReplacement}
            onRemoveReference={handleRemoveNodeReference}
            onReorderReferences={handleReorderNodeReferences}
            onReplaceReference={handleReplaceNodeReference}
            onReplaceReferenceFiles={handleReplaceNodeReferenceFiles}
            onClose={() => setDialogNodeId(null)}
            onNodeMouseDown={handleNodeMouseDown}
            workspaceMode={workspaceMode}
            onImageSettingsOpenChange={(open) => {
                setNodeImageSettingsOpen(open);
                if (open) setToolbarNodeId(null);
            }}
        />
    );
}
