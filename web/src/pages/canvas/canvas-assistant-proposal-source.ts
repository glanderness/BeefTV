import type { Skill } from "@/services/api/skills";
import { getLocalModelConfig } from "@/services/api/workspace";
import { getUnconfirmedCanvasDiagnostic, hasUnconfirmedCanvasEdits, readLocalCanvasProjectFromBackend } from "@/services/local-workspace-repository";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { getModelConfigPersistenceState } from "@/services/model-config-repository";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { effectiveConfigForCustomChannels, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

import type { ProposalSourceState } from "./canvas-assistant-proposal-snapshot";

export function assistantProposalUnconfirmedReason(input: { canvasDirty: boolean; modelConfigDirty: boolean; modelConfigStatus: string }): ProposalSourceState["unconfirmedReason"] {
    if (input.canvasDirty) return "canvas-dirty";
    if (input.modelConfigDirty) return "model-dirty";
    if (!["idle", "saved"].includes(input.modelConfigStatus)) return "model-status";
    return undefined;
}

export function assistantProposalHasUnconfirmedEdits(input: { canvasDirty: boolean; modelConfigDirty: boolean; modelConfigStatus: string }) {
    return assistantProposalUnconfirmedReason(input) !== undefined;
}

export function readAssistantProposalSourceState(projectId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], skills: Skill[]): ProposalSourceState {
    const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
    const persistence = getModelConfigPersistenceState();
    const unconfirmedReason = assistantProposalUnconfirmedReason({
        canvasDirty: hasUnconfirmedCanvasEdits(projectId),
        modelConfigDirty: persistence.dirty,
        modelConfigStatus: persistence.status,
    });
    return {
        canvasId: projectId,
        canvasRevision: project?.revision ?? -1,
        modelConfigRevision: persistence.revision,
        hasUnconfirmedEdits: unconfirmedReason !== undefined,
        unconfirmedReason,
        nodes,
        connections,
        config: effectiveConfigForCustomChannels(useConfigStore.getState().config, useUserStore.getState().features.customChannelsEnabled),
        assets: useAssetStore.getState().assets,
        skills,
    };
}

export async function readPersistedAssistantProposalSource(projectId: string) {
    const [canvas, config] = await Promise.all([readLocalCanvasProjectFromBackend(projectId), getLocalModelConfig()]);
    return {
        canvasId: canvas.id,
        canvasRevision: canvas.revision ?? -1,
        modelConfigRevision: config.revision,
        nodes: canvas.nodes,
        connections: canvas.connections,
    };
}

export function recordAssistantProposalCanvasRejection(projectId: string) {
    try {
        const diagnostic = getUnconfirmedCanvasDiagnostic(projectId);
        if (!diagnostic) return;
        recordDiagnosticEvent({ level: "warning", category: "action", code: `assistant_proposal_canvas_${diagnostic.reason}`,
            message: JSON.stringify(diagnostic) });
    } catch {
        // Diagnostic collection must never replace the original confirmation rejection.
    }
}
