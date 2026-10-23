import { assertUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { flushCanvasStorePersistence } from "@/stores/canvas/use-canvas-store";
import { hasUnconfirmedCanvasEdits, syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";

export async function saveCanvasForAssistant(canvasId: string, scope: CapturedUserScope) {
    await flushCanvasStorePersistence();
    assertUserScope(scope);
    await syncLocalCanvasProjectToBackend(canvasId, scope);
    assertUserScope(scope);
    if (hasUnconfirmedCanvasEdits(canvasId)) throw new Error("画布还有未保存的修改，请保存成功后再发送消息。");
}
