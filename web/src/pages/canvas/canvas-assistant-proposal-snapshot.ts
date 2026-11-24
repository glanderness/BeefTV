import { canonicalize } from "json-canonicalize";
import type { AssistantGenerationProposal } from "@/services/api/agent-assistant";
import type { Skill } from "@/services/api/skills";
import type { Asset } from "@/stores/use-asset-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { normalizeCanvasMediaNodeSemanticsList } from "@/lib/canvas/canvas-node-semantics";
import { resetInterruptedGeneration } from "@/lib/canvas/canvas-project-generation";
import { ownedResourceIdFromMediaRef } from "@/services/api/resources";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";

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
    /** The editor has canvas changes the server has not confirmed yet (usually an autosave in flight). */
    canvasHasUnconfirmedEdits: boolean;
    /** Generation settings are edited but not saved, or still saving. */
    modelConfigHasUnconfirmedEdits: boolean;
};

export type AssistantProposalBlockedReason =
    | "invalid_source"
    | "canvas_saving"
    | "settings_unsaved"
    | "canvas_changed"
    | "settings_changed"
    | "content_mismatch";

/** What the user reads on the proposal card: what happened, then what to do next. */
export const ASSISTANT_PROPOSAL_BLOCKED_TEXT: Record<AssistantProposalBlockedReason, string> = {
    invalid_source: "这项方案缺少核对信息。请让助手重新提出方案。",
    canvas_saving: "画布还在保存。稍等几秒再点生成。",
    settings_unsaved: "生成设置还没保存。保存后再点生成。",
    canvas_changed: "画布在提出方案后改过。请让助手重新提出方案。",
    settings_changed: "生成设置在提出方案后改过。请让助手重新提出方案。",
    content_mismatch: "画布显示的内容和已保存的不一致。请重新打开这个画布，再让助手重新提出方案。",
};

export class AssistantProposalBlockedError extends Error {
    readonly reason: AssistantProposalBlockedReason;
    constructor(reason: AssistantProposalBlockedReason) {
        super(ASSISTANT_PROPOSAL_BLOCKED_TEXT[reason]);
        this.name = "AssistantProposalBlockedError";
        this.reason = reason;
    }
}

export type PrepareAssistantProposalOptions = {
    /** How long to wait for a pending canvas save before reporting canvas_saving. */
    saveWaitMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type SourceRevisions = Pick<ProposalSourceState, "canvasId" | "canvasRevision" | "modelConfigRevision">;

function comparableChannel(channel: AiConfig["channels"][number]) {
    // GET /workspace/model-config redacts secret values to __BEEFTV_REDACTED__, so we compare
    // secret/header presence (plus header names and non-secret channel fields) rather than raw secret strings.
    const hasApiKey = Boolean(channel.apiKey?.trim() || channel.hasApiKey);
    const hasSecretKey = Boolean(channel.secretKey?.trim() || channel.hasSecretKey);
    const normalizedHeaders = (channel.headers || []).map((header) => ({
        name: header.name,
        hasValue: Boolean(header.value?.trim()),
    }));
    if (channel.id === "beeftv" && channel.pinned) {
        const {
            models: _cm,
            modelProfiles: _cp,
            apiKey: _ak,
            secretKey: _sk,
            credentialRef: _cr,
            hasApiKey: _hak,
            hasSecretKey: _hsk,
            baseUrl: _bu,
            headers: _hd,
            ...channelRest
        } = channel;
        const videoQuotes = Object.fromEntries(
            (channel.modelProfiles || [])
                .filter((item) => item.videoPricing)
                .map((item) => [item.model, item.videoPricing])
                .sort(([a], [b]) => String(a).localeCompare(String(b))),
        );
        return { ...channelRest, videoQuotes };
    }
    const {
        apiKey: _ak,
        secretKey: _sk,
        hasApiKey: _hak,
        hasSecretKey: _hsk,
        headers: _hd,
        ...channelRest
    } = channel;
    return {
        ...channelRest,
        hasApiKey,
        hasSecretKey,
        headers: normalizedHeaders,
    };
}

function comparableConfig(config: AiConfig) {
    // Managed credentials/profiles on pinned beeftv and redacted BYOK secrets
    // returned by GET /workspace/model-config must not trigger false mismatches.
    const { models: _m, imageModels: _im, videoModels: _vm, textModels: _tm, audioModels: _am, apiKey: rootApiKey, ...rest } = config;
    return canonicalize({
        ...rest,
        hasRootApiKey: Boolean(rootApiKey?.trim()),
        channels: config.channels.map(comparableChannel),
    });
}

function proposalGenerationContent(proposal: AssistantGenerationProposal, state: ProposalSourceState) {
    return canonicalize(proposal.nodeIds.map(id => {
        const node = state.nodes.find(item => item.id === id);
        return buildNodeGenerationContext(id, state.nodes, state.connections, node?.metadata?.composerContent ?? node?.metadata?.prompt ?? "", state.assets);
    }));
}

/** A canvas autosave usually settles within a moment, so wait for it instead of failing the first click. */
async function readSettledCurrent(readCurrent: () => ProposalSourceState, options: PrepareAssistantProposalOptions) {
    const { saveWaitMs = 3000, pollMs = 250, sleep = defaultSleep } = options;
    let waited = 0;
    for (;;) {
        const state = structuredClone(readCurrent());
        if (state.modelConfigHasUnconfirmedEdits) throw new AssistantProposalBlockedError("settings_unsaved");
        if (!state.canvasHasUnconfirmedEdits) return state;
        if (waited >= saveWaitMs) throw new AssistantProposalBlockedError("canvas_saving");
        await sleep(pollMs);
        waited += pollMs;
    }
}

/** Check both durable revisions and unsaved editor state before freezing the existing generation inputs. */
export async function prepareAssistantProposalSnapshot(
    proposal: AssistantGenerationProposal,
    readCurrent: () => ProposalSourceState,
    readPersisted: () => Promise<SourceRevisions & Pick<ProposalSourceState, "nodes" | "connections"> & { config?: AiConfig }>,
    options: PrepareAssistantProposalOptions = {},
): Promise<ConfirmedGenerationInputs> {
    const expected = proposal.source;
    if (!expected || !expected.canvasId || !Number.isSafeInteger(expected.canvasRevision) || expected.canvasRevision < 0 ||
        !Number.isSafeInteger(expected.modelConfigRevision) || expected.modelConfigRevision < 0) {
        throw new AssistantProposalBlockedError("invalid_source");
    }
    const checkRevisions = (state: SourceRevisions) => {
        if (state.canvasId !== expected.canvasId || state.canvasRevision !== expected.canvasRevision) throw new AssistantProposalBlockedError("canvas_changed");
        if (state.modelConfigRevision !== expected.modelConfigRevision) throw new AssistantProposalBlockedError("settings_changed");
    };
    const snapshot = await readSettledCurrent(readCurrent, options);
    if (snapshot.canvasId !== expected.canvasId || snapshot.canvasRevision !== expected.canvasRevision) throw new AssistantProposalBlockedError("canvas_changed");
    const persisted = await readPersisted();
    checkRevisions(persisted);
    // A catalog refresh can advance the backend revision without notifying this
    // editor. Accept it only with proof that the actual settings are unchanged.
    if (snapshot.modelConfigRevision > persisted.modelConfigRevision ||
        (snapshot.modelConfigRevision !== persisted.modelConfigRevision && !persisted.config) ||
        (persisted.config && comparableConfig(snapshot.config) !== comparableConfig(persisted.config))) {
        throw new AssistantProposalBlockedError("settings_changed");
    }
    const snapshotContent = proposalCanvasContent(snapshot.nodes, snapshot.connections);
    if (snapshotContent !== proposalCanvasContent(persisted.nodes, persisted.connections)) throw new AssistantProposalBlockedError("content_mismatch");
    const latest = structuredClone(readCurrent());
    if (snapshot.canvasId !== latest.canvasId || snapshot.canvasRevision !== latest.canvasRevision ||
        latest.canvasHasUnconfirmedEdits || snapshotContent !== proposalCanvasContent(latest.nodes, latest.connections)) {
        throw new AssistantProposalBlockedError("canvas_changed");
    }
    if (latest.modelConfigHasUnconfirmedEdits || snapshot.modelConfigRevision !== latest.modelConfigRevision ||
        comparableConfig(snapshot.config) !== comparableConfig(latest.config) || canonicalize(snapshot.skills) !== canonicalize(latest.skills)) {
        throw new AssistantProposalBlockedError("settings_changed");
    }
    if (canonicalize(snapshot.assets) !== canonicalize(latest.assets) &&
        proposalGenerationContent(proposal, snapshot) !== proposalGenerationContent(proposal, latest)) {
        throw new AssistantProposalBlockedError("content_mismatch");
    }
    return { nodes: snapshot.nodes, connections: snapshot.connections, config: snapshot.config, assets: latest.assets, skills: snapshot.skills };
}
