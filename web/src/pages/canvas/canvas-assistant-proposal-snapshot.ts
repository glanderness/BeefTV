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
};

export const STALE_PROPOSAL_MESSAGE = "画布内容或生成设置已变化。请保存修改，并让助手重新提出生成方案后再确认。";

/** Check both durable revisions and unsaved editor state before freezing the existing generation inputs. */
export async function prepareAssistantProposalSnapshot(
    proposal: AssistantGenerationProposal,
    readCurrent: () => ProposalSourceState,
    readPersisted: () => Promise<Pick<ProposalSourceState, "canvasId" | "canvasRevision" | "modelConfigRevision" | "nodes" | "connections">>,
): Promise<ConfirmedGenerationInputs> {
    const expected = proposal.source;
    if (!expected || !expected.canvasId || !Number.isSafeInteger(expected.canvasRevision) || expected.canvasRevision < 0 ||
        !Number.isSafeInteger(expected.modelConfigRevision) || expected.modelConfigRevision < 0) {
        throw new Error(STALE_PROPOSAL_MESSAGE);
    }
    const snapshot = structuredClone(readCurrent());
    const matches = (state: Pick<ProposalSourceState, "canvasId" | "canvasRevision" | "modelConfigRevision">) =>
        state.canvasId === expected.canvasId && state.canvasRevision === expected.canvasRevision && state.modelConfigRevision === expected.modelConfigRevision;
    if (snapshot.hasUnconfirmedEdits || !matches(snapshot)) throw new Error(STALE_PROPOSAL_MESSAGE);
    const persisted = await readPersisted();
    if (!matches(persisted) || proposalCanvasContent(snapshot.nodes, snapshot.connections) !== proposalCanvasContent(persisted.nodes, persisted.connections) ||
        canonicalize(snapshot) !== canonicalize(readCurrent())) {
        throw new Error(STALE_PROPOSAL_MESSAGE);
    }
    return { nodes: snapshot.nodes, connections: snapshot.connections, config: snapshot.config, assets: snapshot.assets, skills: snapshot.skills };
}
