import { canonicalize } from "json-canonicalize";
import type { AssistantGenerationProposal } from "@/services/api/agent-assistant";
import type { Skill } from "@/services/api/skills";
import type { Asset } from "@/stores/use-asset-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { normalizeCanvasMediaNodeSemanticsList } from "@/lib/canvas/canvas-node-semantics";
import { resetInterruptedGeneration } from "@/lib/canvas/canvas-project-generation";
import { ownedResourceIdFromMediaRef } from "@/services/api/resources";

/** Use the editor's load normalization on both documents. Never discard prompts or unknown metadata. */
export function proposalCanvasContent(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return canonicalize({
        nodes: normalizeCanvasMediaNodeSemanticsList(resetInterruptedGeneration(nodes)).map(({ createdAt: _created, updatedAt: _updated, ...node }) => {
            const metadata = { ...node.metadata };
            // A trusted resource URL and its storage key identify the same immutable resource.
            // Do not collapse arbitrary URLs or data/blob URLs: those may contain different input.
            const resource = ownedResourceIdFromMediaRef(undefined, metadata.content);
            if (resource && (!metadata.storageKey || metadata.storageKey === `resource:${resource}`)) {
                metadata.storageKey = `resource:${resource}`;
                delete metadata.content;
            }
            return { ...node, metadata };
        }),
        connections: connections || [],
    });
}

export type ConfirmedGenerationInputs = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    config: AiConfig;
    assets: Asset[];
    skills: Skill[];
};

export type ProposalSourceState = ConfirmedGenerationInputs & {
    canvasId: string;
    canvasRevision: number;
    modelConfigRevision: number;
    hasUnconfirmedEdits: boolean;
    unconfirmedReason?: "canvas-dirty" | "model-dirty" | "model-status";
};

export const STALE_PROPOSAL_MESSAGE = "画布内容或生成设置已变化。请保存修改，并让助手重新提出生成方案后再确认。";

export type AssistantProposalChangeReason = "missing-source" | "unsaved" | "canvas-dirty" | "model-dirty" | "model-status" | "version-changed" | "saved-content-mismatch" | "changed-during-confirmation";

const proposalChangeMessages: Record<AssistantProposalChangeReason, string> = {
    "missing-source": "这条生成方案无法核对当前内容，请让助手重新提出方案。",
    unsaved: "画布修改或生成设置尚未保存，请保存完成后再确认生成。",
    "canvas-dirty": "画布修改尚未保存，请保存完成后再确认生成。",
    "model-dirty": "生成设置尚未保存，请保存完成后再确认生成。",
    "model-status": "生成设置还没保存完成，请检查设置的保存状态后再确认生成。",
    "version-changed": "画布或生成设置已更新，请让助手重新提出生成方案。",
    "saved-content-mismatch": "无法确认当前画布与已保存内容一致，请重新打开画布后再确认生成。",
    "changed-during-confirmation": "确认期间画布或生成设置发生变化，请检查当前内容后重新确认。",
};

export class AssistantProposalChangedError extends Error {
    constructor(readonly reason: AssistantProposalChangeReason) {
        super(proposalChangeMessages[reason]);
        this.name = "AssistantProposalChangedError";
    }
}

/** Check both durable revisions and unsaved editor state before freezing the existing generation inputs. */
export async function prepareAssistantProposalSnapshot(
    proposal: AssistantGenerationProposal,
    readCurrent: () => ProposalSourceState,
    readPersisted: () => Promise<Pick<ProposalSourceState, "canvasId" | "canvasRevision" | "modelConfigRevision" | "nodes" | "connections">>,
): Promise<ConfirmedGenerationInputs> {
    const expected = proposal.source;
    if (!expected || !expected.canvasId || !Number.isSafeInteger(expected.canvasRevision) || expected.canvasRevision < 0 ||
        !Number.isSafeInteger(expected.modelConfigRevision) || expected.modelConfigRevision < 0) {
        throw new AssistantProposalChangedError("missing-source");
    }
    const snapshot = structuredClone(readCurrent());
    const matches = (state: Pick<ProposalSourceState, "canvasId" | "canvasRevision" | "modelConfigRevision">) =>
        state.canvasId === expected.canvasId && state.canvasRevision === expected.canvasRevision && state.modelConfigRevision === expected.modelConfigRevision;
    if (snapshot.hasUnconfirmedEdits) throw new AssistantProposalChangedError(snapshot.unconfirmedReason ?? "unsaved");
    if (!matches(snapshot)) throw new AssistantProposalChangedError("version-changed");
    const persisted = await readPersisted();
    if (!matches(persisted)) throw new AssistantProposalChangedError("version-changed");
    if (proposalCanvasContent(snapshot.nodes, snapshot.connections) !== proposalCanvasContent(persisted.nodes, persisted.connections))
        throw new AssistantProposalChangedError("saved-content-mismatch");
    if (canonicalize(snapshot) !== canonicalize(readCurrent())) throw new AssistantProposalChangedError("changed-during-confirmation");
    return { nodes: snapshot.nodes, connections: snapshot.connections, config: snapshot.config, assets: snapshot.assets, skills: snapshot.skills };
}
