import { App } from "antd";
import { CanvasDeleteConfirmation } from "./canvas-delete-confirmation";

import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { deleteWorkspaceCanvasProjects } from "@/services/workspace-project-repository";

export function CanvasDeleteProjectsDialog() {
    const { message } = App.useApp();
    const ids = useCanvasUiStore((state) => state.deleteProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const removeSelectedIds = useCanvasUiStore((state) => state.removeSelectedProjectIds);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const deletionLabel = "本地画布";
    const confirm = async () => {
        const selected = [...useCanvasUiStore.getState().deleteProjectIds];
        if (!selected.length) return;
        await deleteWorkspaceCanvasProjects(selected);
        void cleanupImages().catch((error) => {
            console.warn("画布删除后的本地媒体清理已跳过", error);
        });
        removeSelectedIds(selected);
        message.success(`已删除 ${selected.length} 个${deletionLabel}`);
    };
    if (!ids.length) return null;
    return <CanvasDeleteConfirmation title={`删除${deletionLabel}？`}
        description={`将删除 ${ids.length} 个${deletionLabel}，里面的节点和连线也会一起移除。`}
        onCancel={() => setDeleteIds([])} onConfirm={confirm} />;
}
