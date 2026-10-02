import { useCallback, useRef, useState } from "react";

import type { AssistantGenerationProposal } from "@/services/api/agent-assistant";
import type { Skill } from "@/services/api/skills";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

import { executeAssistantProposal } from "./canvas-assistant-proposal-execution";
import { prepareAssistantProposalSnapshot } from "./canvas-assistant-proposal-snapshot";
import { readAssistantProposalSourceState, readPersistedAssistantProposalSource } from "./canvas-assistant-proposal-source";
import { useCanvasOwnerLifetime } from "./canvas-owner-epoch";
import type { CanvasNodeGenerationOptions } from "./use-canvas-generation-executor";

type GenerateNode = (nodeId: string, mode: "image" | "video", prompt: string, options?: CanvasNodeGenerationOptions) => Promise<unknown>;

type UseCanvasAssistantProposalOptions = {
    projectId: string;
    addedSkills: Skill[];
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    handledProposals: ReadonlySet<string>;
    markProposalHandled: (proposalId: string) => void;
    handleGenerateNode: GenerateNode;
};

export function useCanvasAssistantProposal({
    projectId,
    addedSkills,
    nodesRef,
    connectionsRef,
    handledProposals,
    markProposalHandled,
    handleGenerateNode,
}: UseCanvasAssistantProposalOptions) {
    const claimsRef = useRef(new Set<string>());
    const [assistantProposalFeedback, setAssistantProposalFeedback] = useState<Record<string, string>>({});
    const handledRef = useRef(handledProposals);
    handledRef.current = handledProposals;
    const markHandledRef = useRef(markProposalHandled);
    markHandledRef.current = markProposalHandled;
    const handleGenerateNodeRef = useRef(handleGenerateNode);
    handleGenerateNodeRef.current = handleGenerateNode;
    const addedSkillsRef = useRef(addedSkills);
    addedSkillsRef.current = addedSkills;
    const projectIdRef = useRef(projectId);
    projectIdRef.current = projectId;
    const { lifetime } = useCanvasOwnerLifetime(projectId);

    const runAssistantProposal = useCallback(
        (proposal: AssistantGenerationProposal) => {
            const owner = lifetime.capture(projectId);
            const generateForThisRun = handleGenerateNodeRef.current;
            setAssistantProposalFeedback((current) => ({ ...current, [proposal.proposalId]: "" }));
            void executeAssistantProposal({
                proposal,
                nodes: nodesRef.current,
                claims: claimsRef.current,
                isHandled: handledRef.current.has(proposal.proposalId),
                prepare: () =>
                    prepareAssistantProposalSnapshot(
                        proposal,
                        () => readAssistantProposalSourceState(owner.canvasId, nodesRef.current, connectionsRef.current, addedSkillsRef.current),
                        () => readPersistedAssistantProposalSource(owner.canvasId),
                    ),
                generate: generateForThisRun,
                stillOwns: () => lifetime.matches(owner, projectIdRef.current),
                markHandled: (proposalId) => markHandledRef.current(proposalId),
                notify: (content) => {
                    setAssistantProposalFeedback((current) => ({ ...current, [proposal.proposalId]: content }));
                },
            });
        },
        [connectionsRef, lifetime, nodesRef, projectId],
    );

    return { runAssistantProposal, assistantProposalFeedback };
}
