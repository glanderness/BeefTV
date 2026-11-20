import { App } from "antd";
import { useMemo } from "react";

import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { collectCanvasStoryboardTargets } from "@/components/canvas/canvas-context-menu-storyboard";
import { collectDownloadableMediaNodes, runCanvasBatchDownloadWithFeedback } from "@/lib/canvas/canvas-batch-download";
import { isFrameNode } from "@/lib/canvas/canvas-frame";
import { applyAssetsToStoryboardRows, collectSelectedBindableAssetNodes } from "@/lib/canvas/canvas-storyboard-assets";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeTypeId, type CanvasWorkspaceMode, type ContextMenuState, type Position, type StoryboardRow } from "@/types/canvas";

type CanvasAssetCategory = NonNullable<NonNullable<CanvasNodeData["metadata"]>["assetCategory"]>;

type CanvasProjectContextMenuProps = {
    menu: ContextMenuState | null;
    node: CanvasNodeData | null;
    nodes?: CanvasNodeData[];
    selectedNodeIds?: Iterable<string>;
    workspaceMode: CanvasWorkspaceMode;
    isProjectLinked: boolean;
    canUndo: boolean;
    canRedo: boolean;
    canPaste: boolean;
    selectedCount: number;
    downloadableSelectionCount?: number;
    screenToCanvas: (clientX: number, clientY: number) => Position;
    onClose: () => void;
    onAddNode: (type: CanvasNodeTypeId, position: Position) => void;
    onAddFolder: (position: Position) => void;
    onChooseStyle: () => void;
    onOpenDirector: (position?: Position) => void;
    onUpload: (nodeId: string | undefined, position: Position) => void;
    onOpenAssets: (position: Position) => void;
    onOpenProjectCharacters: (position: Position) => void;
    onOpenGenerationHistory: (position: Position) => void;
    onUndo: () => void;
    onRedo: () => void;
    onPaste: (position: Position) => void;
    onCopyNode: (nodeId: string) => void;
    onCreateGenerationCopy: (nodeId: string) => void;
    onDuplicate: (nodeId: string) => void;
    onDeleteNode: (nodeId: string) => void;
    onDeleteConnection: (connectionId: string) => void;
    onSaveAsset: (node: CanvasNodeData) => void;
    onViewMedia: (node: CanvasNodeData) => void;
    onInfoNode?: (node: CanvasNodeData) => void;
    onEditText: (node: CanvasNodeData) => void;
    onOpenDrawing: (node: CanvasNodeData) => void;
    onGenerateImage: (node: CanvasNodeData) => void;
    onCopyContent: (node: CanvasNodeData | null) => void;
    onCopyMediaUrl: (node: CanvasNodeData | null) => void;
    onUploadToArkPrivateAsset: (node: CanvasNodeData) => void;
    onSetAssetCategory?: (nodeId: string, category: CanvasAssetCategory) => void;
    onToggleFrame: (node: CanvasNodeData) => void;
    onUnpackFolder?: (nodeId: string) => void;
    onSpreadSelection: () => void;
    onPackSelectionToFolder?: () => void;
    onCopySelection: () => void;
    onDeleteSelection: () => void;
    onBatchDownloadSelection?: () => void;
    onBindStoryboardRows?: (scriptNodeId: string, updater: (rows: StoryboardRow[]) => StoryboardRow[]) => void;
    extractingAudio?: boolean;
    extractingAudioNode?: boolean;
    trimmingVideo?: boolean;
    onExtractAudioFromVideo?: (node: CanvasNodeData) => void;
    onExtractAudioNodeFromVideo?: (node: CanvasNodeData) => void;
};

export function CanvasProjectContextMenu({ menu, node, screenToCanvas, ...props }: CanvasProjectContextMenuProps) {
    const { message } = App.useApp();
    const downloadableNodes = useMemo(
        () => (props.nodes && props.selectedNodeIds ? collectDownloadableMediaNodes(props.nodes, props.selectedNodeIds) : []),
        [props.nodes, props.selectedNodeIds],
    );
    const bindableNodes = useMemo(() => {
        if (!props.nodes) return [];
        const selected = props.selectedNodeIds ? Array.from(props.selectedNodeIds) : [];
        const targetIds = selected.length > 0 ? selected : node ? [node.id] : [];
        return collectSelectedBindableAssetNodes(props.nodes, targetIds);
    }, [node, props.nodes, props.selectedNodeIds]);
    const storyboardTargets = useMemo(
        () => (props.nodes ? collectCanvasStoryboardTargets(props.nodes) : []),
        [props.nodes],
    );
    if (!menu) return null;
    const downloadableSelectionCount = props.downloadableSelectionCount ?? downloadableNodes.length;
    const handleBatchDownloadSelection = props.onBatchDownloadSelection ?? (() => {
        void runCanvasBatchDownloadWithFeedback(downloadableNodes, message);
    });
    const menuPosition = () => menu.type === "canvas" ? menu.position : screenToCanvas(menu.x, menu.y);
    return (
        <CanvasNodeContextMenu
            menu={menu}
            node={node}
            workspaceMode={props.workspaceMode}
            isProjectLinked={props.isProjectLinked}
            canUndo={props.canUndo}
            canRedo={props.canRedo}
            canPaste={props.canPaste}
            selectedCount={props.selectedCount}
            downloadableSelectionCount={downloadableSelectionCount}
            onClose={props.onClose}
            onAddNode={(type) => {
                if (menu.type === "canvas") props.onAddNode(type, menu.position);
            }}
            onAddFolder={() => {
                if (menu.type === "canvas") props.onAddFolder(menu.position);
            }}
            onChooseStyle={props.onChooseStyle}
            onOpenDirector={props.onOpenDirector}
            onUpload={() => props.onUpload(menu.type === "node" ? menu.nodeId : undefined, menuPosition())}
            onOpenAssets={() => props.onOpenAssets(menuPosition())}
            onOpenProjectCharacters={() => props.onOpenProjectCharacters(menuPosition())}
            onOpenGenerationHistory={() => props.onOpenGenerationHistory(menuPosition())}
            onUndo={props.onUndo}
            onRedo={props.onRedo}
            onPaste={() => props.onPaste(menuPosition())}
            onCopyNode={() => {
                if (menu.type === "node") props.onCopyNode(menu.nodeId);
            }}
            onCreateGenerationCopy={() => {
                if (menu.type === "node") props.onCreateGenerationCopy(menu.nodeId);
            }}
            onDuplicate={() => {
                if (menu.type === "node") props.onDuplicate(menu.nodeId);
            }}
            onDelete={() => {
                if (menu.type === "node") props.onDeleteNode(menu.nodeId);
                else if (menu.type === "connection") props.onDeleteConnection(menu.connectionId);
            }}
            onSaveAsset={() => {
                if (node) props.onSaveAsset(node);
            }}
            onViewMedia={() => {
                if (node) props.onViewMedia(node);
            }}
            onNodeInfo={
                props.onInfoNode && node
                    ? () => props.onInfoNode?.(node)
                    : undefined
            }
            onEditText={() => {
                if (node) props.onEditText(node);
            }}
            onOpenDrawing={() => {
                if (node) props.onOpenDrawing(node);
            }}
            onGenerateImage={() => {
                if (node) props.onGenerateImage(node);
            }}
            onCopyContent={() => props.onCopyContent(node)}
            onCopyMediaUrl={() => props.onCopyMediaUrl(node)}
            onUploadToArkPrivateAsset={() => {
                if (node?.type === CanvasNodeType.Image) props.onUploadToArkPrivateAsset(node);
            }}
            onSetAssetCategory={
                props.onSetAssetCategory && menu.type === "node"
                    ? (category) => props.onSetAssetCategory?.(menu.nodeId, category)
                    : undefined
            }
            onToggleFrame={() => {
                if (node && isFrameNode(node)) props.onToggleFrame(node);
            }}
            onUnpackFolder={
                props.onUnpackFolder && node
                    ? () => props.onUnpackFolder?.(node.id)
                    : undefined
            }
            onSpreadSelection={props.onSpreadSelection}
            onPackSelectionToFolder={props.onPackSelectionToFolder}
            onCopySelection={props.onCopySelection}
            onDeleteSelection={props.onDeleteSelection}
            onBatchDownloadSelection={handleBatchDownloadSelection}
            bindableAssetCount={bindableNodes.length}
            storyboardTargets={storyboardTargets}
            onBindAssetsToStoryboardShots={
                props.onBindStoryboardRows
                    ? (scriptNodeId, rowIds) => {
                          if (!bindableNodes.length || !rowIds.length) return;
                          const targetScript = storyboardTargets.find((item) => item.scriptNodeId === scriptNodeId);
                          const rowSet = new Set(rowIds);
                          const matchedShots = (targetScript?.shots || []).filter((shot) => rowSet.has(shot.rowId));
                          props.onBindStoryboardRows?.(scriptNodeId, (rows) => applyAssetsToStoryboardRows(rows, rowIds, bindableNodes).rows);
                          if (matchedShots.length === 1) {
                              message.success(`已将 ${bindableNodes.length} 个素材关联到第 ${matchedShots[0].shotNumber} 镜`);
                          } else {
                              message.success(`已将 ${bindableNodes.length} 个素材关联到 ${matchedShots.length || rowIds.length} 个镜头`);
                          }
                      }
                    : undefined
            }
            extractingAudio={props.extractingAudio}
            extractingAudioNode={props.extractingAudioNode}
            trimmingVideo={props.trimmingVideo}
            onExtractAudio={
                props.onExtractAudioFromVideo
                    ? () => {
                          if (node?.type === CanvasNodeType.Video) props.onExtractAudioFromVideo?.(node);
                      }
                    : undefined
            }
            onExtractAudioNode={
                props.onExtractAudioNodeFromVideo
                    ? () => {
                          if (node?.type === CanvasNodeType.Video) props.onExtractAudioNodeFromVideo?.(node);
                      }
                    : undefined
            }
        />
    );
}
