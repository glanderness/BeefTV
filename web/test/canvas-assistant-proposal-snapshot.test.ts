import { expect, test } from "bun:test";
import { prepareAssistantProposalSnapshot, type ProposalSourceState } from "@/pages/canvas/canvas-assistant-proposal-snapshot";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { executeAssistantProposal } from "@/pages/canvas/canvas-assistant-proposal-execution";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType } from "@/types/canvas";
import { normalizeCanvasMediaNodeSemanticsList } from "@/lib/canvas/canvas-node-semantics";
import { normalizeCanvasNodeTimestamps } from "@/lib/canvas/canvas-node-timestamps";
import { resetInterruptedGeneration } from "@/lib/canvas/canvas-project-generation";
import { resourceFileUrl } from "@/services/api/resources";

const proposal = { proposalId: "p", kind: "image" as const, model: "m", modelKey: "c::m", nodeIds: ["n"],
    source: { canvasId: "canvas", canvasRevision: 4, modelConfigRevision: 2 } };
function fixture(): ProposalSourceState {
    return structuredClone({ ...proposal.source, hasUnconfirmedEdits: false,
        nodes: [{ id: "n", title: "Image", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { prompt: "original" } },
            { id: "ref", title: "Reference", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "resource:r1" } }],
        connections: [{ id: "edge", fromNodeId: "ref", toNodeId: "n" }], config: defaultConfig, assets: [], skills: [] });
}

test("normal freshly loaded React nodes pass against raw server nodes", async () => {
    const persisted = fixture();
    const live = fixture();
    live.nodes = normalizeCanvasMediaNodeSemanticsList(normalizeCanvasNodeTimestamps(resetInterruptedGeneration(live.nodes), {
        createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:01:00Z",
    }));
    live.nodes[1].metadata!.content = resourceFileUrl("r1");
    live.nodes[0].metadata!.resultOrigin = undefined;
    const result = await prepareAssistantProposalSnapshot(proposal, () => live, async () => persisted);
    expect(result.nodes[0].metadata?.prompt).toBe("original");
});

const mutations: [string, (state: ProposalSourceState) => void][] = [
    ["prompt before persistence", s => { s.nodes[0].metadata!.prompt = "changed"; }],
    ["reference resource", s => { s.nodes[1].metadata!.storageKey = "resource:r2"; }],
    ["reference remote URL", s => { s.nodes[1].metadata!.content = "https://example.test/changed.png"; }],
    ["reference connection", s => { s.connections = []; }],
    ["saved canvas revision", s => { s.canvasRevision++; }],
    ["global settings with unchanged model", s => { s.modelConfigRevision++; }],
    ["unsaved settings", s => { s.hasUnconfirmedEdits = true; }],
    ["different canvas", s => { s.canvasId = "other"; }],
];
for (const [label, change] of mutations) test(`F02 rejects ${label} before any task is submitted`, async () => {
    const persisted = fixture();
    const live = fixture();
    change(live);
    let submissions = 0;
    let handled = 0;
    const claims = new Set<string>();
    const notices: string[] = [];
    await executeAssistantProposal({ proposal, nodes: live.nodes, claims, isHandled: false,
        prepare: () => prepareAssistantProposalSnapshot(proposal, () => live, async () => persisted),
        generate: async () => { submissions++; }, markHandled: () => { handled++; }, notify: text => { notices.push(text); } });
    expect(submissions).toBe(0);
    expect(handled).toBe(0);
    expect(claims.size).toBe(0);
    expect(notices).toHaveLength(1);
});

test("a remote save while the editor is stale rejects confirmation", async () => {
    const live = fixture();
    const server = fixture();
    server.canvasRevision++;
    await expect(prepareAssistantProposalSnapshot(proposal, () => live, async () => server)).rejects.toThrow();
});

for (const [label, change] of [
    ["prompt", (s: ProposalSourceState) => { s.nodes[0].metadata!.prompt = "new"; }],
    ["global parameters", (s: ProposalSourceState) => { s.config.canvasImageCount = "4"; }],
] as const) test(`editing ${label} while the server read is pending rejects`, async () => {
    const live = fixture();
    await expect(prepareAssistantProposalSnapshot(proposal, () => live, async () => {
        const persisted = fixture(); change(live); return persisted;
    })).rejects.toThrow();
});

test("confirmed inputs remain unchanged after subsequent live edits", async () => {
    const live = fixture();
    const savedCount = live.config.canvasImageCount;
    const confirmed = await prepareAssistantProposalSnapshot(proposal, () => live, async () => fixture());
    live.nodes[0].metadata!.prompt = "later";
    live.nodes[1].metadata!.storageKey = "resource:later";
    live.connections.length = 0;
    live.config.canvasImageCount = "4";
    expect(confirmed.nodes[0].metadata!.prompt).toBe("original");
    expect(confirmed.nodes[1].metadata!.storageKey).toBe("resource:r1");
    expect(confirmed.connections).toHaveLength(1);
    expect(confirmed.config.canvasImageCount).toBe(savedCount);
});

test("old history and malformed source cannot invent a current baseline", async () => {
    for (const source of [undefined, null, {}, { ...proposal.source, canvasRevision: "4" }, { ...proposal.source, modelConfigRevision: -1 }]) {
        await expect(prepareAssistantProposalSnapshot({ ...proposal, source } as typeof proposal, fixture, async () => fixture())).rejects.toThrow();
    }
});

test("failed durable read cannot execute with local fallback", async () => {
    await expect(prepareAssistantProposalSnapshot(proposal, fixture, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
});

test("the generation boundary receives the confirmed prompt and reference after live mutation", async () => {
    const live = fixture();
    let submitted = false;
    await executeAssistantProposal({ proposal, nodes: live.nodes, claims: new Set(), isHandled: false,
        prepare: async () => {
            const frozen = await prepareAssistantProposalSnapshot(proposal, () => live, async () => fixture());
            live.nodes[0].metadata!.prompt = "later prompt";
            live.nodes[1].metadata!.storageKey = "resource:later";
            live.config.canvasImageCount = "4";
            return frozen;
        },
        generate: async (id, _mode, prompt, options) => {
            const frozen = options!.confirmedInputs!;
            const context = buildNodeGenerationContext(id, frozen.nodes, frozen.connections, prompt, frozen.assets);
            expect(prompt).toBe("original");
            expect(frozen.nodes[1].metadata!.storageKey).toBe("resource:r1");
            expect(context.prompt).toContain("original");
            expect(frozen.config.canvasImageCount).toBe(defaultConfig.canvasImageCount);
            submitted = true;
        }, markHandled: () => {}, notify: () => {} });
    expect(submitted).toBe(true);
});
