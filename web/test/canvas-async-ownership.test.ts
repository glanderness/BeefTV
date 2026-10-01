import { describe, expect, test } from "bun:test";

import { CANVAS_OWNER_CHANGED_PROPOSAL_MESSAGE, executeAssistantProposal } from "@/pages/canvas/canvas-assistant-proposal-execution";
import { rebaseInsertedCanvasNode, runOwnedCanvasHistoryInsert } from "@/pages/canvas/canvas-generation-orchestration";
import { captureCanvasOwnerEpoch, canvasOwnerEpochMatches, readOwnedCanvasNodes, runOwnedCanvasPageCommit } from "@/pages/canvas/canvas-owner-epoch";
import { applyArchivedCanvasNodeAssets, commitOwnedCanvasAssetHandoff, rebaseCreatedCanvasNodes } from "@/pages/canvas/canvas-resource-handoff-commit";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function node(id: string, metadata: Partial<NonNullable<CanvasNodeData["metadata"]>> = {}): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x: 0, y: 0 },
        width: 720,
        height: 405,
        metadata,
    };
}

function historyTask(): GenerationTask {
    return {
        id: "task-history",
        type: "canvas_image",
        status: "succeeded",
        prompt: "历史图片",
        resultJson: JSON.stringify({ mode: "image", images: [{ dataUrl: "data:image/png;base64,abc", storageKey: "resource:history" }] }),
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
    } as GenerationTask;
}

async function applyHistoryNode(nodes: CanvasNodeData[], task: GenerationTask, targetNodeId: string) {
    const current = nodes.find((item) => item.id === targetNodeId) || nodes[0];
    if (!current) return { nodes, updated: false, nodeId: "", node: null };
    const next = {
        ...current,
        metadata: {
            ...current.metadata,
            content: "/api/resources/history/file",
            storageKey: "resource:history",
            status: "success" as const,
            taskId: task.id,
        },
    };
    return { nodes: [next], updated: true, nodeId: next.id, node: next };
}

describe("history insert ownership", () => {
    test("rebases onto edits made while the resource is loading, then skips page commit after a canvas switch", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveCanvasId = "canvas-a";
        let liveNodes = [node("draft", { content: "before" })];
        let pageNodes = liveNodes;
        const persisted: CanvasNodeData[][] = [];
        const ensureGate = deferred();
        const persistStarted = deferred<CanvasNodeData[]>();
        const persistGate = deferred();

        const pending = runOwnedCanvasHistoryInsert({
            owner,
            getLiveCanvasId: () => liveCanvasId,
            getLiveUserScope: () => "user-a",
            task: historyTask(),
            projectId: "canvas-a",
            domainProjectId: "project-1",
            center: { x: 100, y: 80 },
            nodes: liveNodes,
            assets: [],
            readLiveNodes: () => readOwnedCanvasNodes({
                owner,
                liveCanvasId,
                liveUserScope: "user-a",
                pageNodes: liveNodes,
                storedNodes: [node("stored-original")],
            }),
            persist: async (nextNodes: CanvasNodeData[]) => {
                persistStarted.resolve(nextNodes);
                await persistGate.promise;
                persisted.push(nextNodes);
            },
            ensureAsset: async () => {
                await ensureGate.promise;
                return { assetId: "asset-history" };
            },
            applyResult: applyHistoryNode,
            onCommit: (inserted: CanvasNodeData) => {
                pageNodes = rebaseInsertedCanvasNode(pageNodes, inserted);
            },
        });
        liveNodes = [node("draft", { content: "edited-during-io" }), node("extra-draft")];
        pageNodes = liveNodes;
        ensureGate.resolve();
        const snapshot = await persistStarted.promise;
        liveCanvasId = "canvas-b";
        persistGate.resolve();
        expect(await pending).toBe("abandoned");
        expect(snapshot.slice(0, 2).map((item) => `${item.id}:${item.metadata?.content || ""}`)).toEqual([
            "draft:edited-during-io",
            "extra-draft:",
        ]);
        expect(snapshot.at(-1)?.metadata?.assetId).toBe("asset-history");
        expect(persisted).toEqual([snapshot]);
        expect(pageNodes.map((item) => item.id)).toEqual(["draft", "extra-draft"]);
        expect(canvasOwnerEpochMatches(owner, liveCanvasId, "user-a")).toBe(false);
    });

    test("commits a functional rebase after persist so later page edits survive", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveNodes = [node("keep")];
        let pageNodes = liveNodes;
        const persistGate = deferred();
        const pending = runOwnedCanvasHistoryInsert({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => "user-a",
            task: historyTask(),
            projectId: "canvas-a",
            center: { x: 10, y: 10 },
            nodes: liveNodes,
            assets: [],
            readLiveNodes: () => liveNodes,
            persist: async () => {
                await persistGate.promise;
            },
            ensureAsset: async () => ({ assetId: "asset-history" }),
            applyResult: applyHistoryNode,
            onCommit: (inserted) => {
                pageNodes = rebaseInsertedCanvasNode(pageNodes, inserted);
            },
        });
        pageNodes = [...pageNodes, node("typed-during-persist")];
        persistGate.resolve();
        expect(await pending).toBe("committed");
        expect(pageNodes.map((item) => item.id)).toEqual(["keep", "typed-during-persist", pageNodes.at(-1)!.id]);
        expect(pageNodes.at(-1)?.metadata?.assetId).toBe("asset-history");
    });
});

describe("handoff ownership", () => {
    test("keeps concurrent drafts, persists before consuming the URL, and stays retryable after a failed persist", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        const created = [node("created", { assetId: "asset-1" })];
        let liveNodes = [node("existing"), ...created];
        let pageNodes = liveNodes;
        let searchParams = new URLSearchParams({ mode: "handoff", asset: "asset-1" });
        let attemptKey = "canvas-a:asset-1:image";
        const persistGate = deferred();
        const first = commitOwnedCanvasAssetHandoff({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => "user-a",
            searchParams,
            createdNodes: created,
            readLiveNodes: () => liveNodes,
            persist: async () => {
                await persistGate.promise;
            },
            applyCreated: (nodes) => {
                pageNodes = rebaseCreatedCanvasNodes(pageNodes, nodes);
            },
            consumeUrl: (next) => {
                searchParams = next;
            },
            resetAttempt: () => {
                attemptKey = "";
            },
        });
        liveNodes = [...liveNodes, node("draft-during-load")];
        pageNodes = liveNodes;
        persistGate.reject(new Error("sqlite unavailable"));
        expect(await first).toBe("failed");
        expect(searchParams.get("mode")).toBe("handoff");
        expect(searchParams.get("asset")).toBe("asset-1");
        expect(attemptKey).toBe("");

        const persisted: CanvasNodeData[][] = [];
        const retry = await commitOwnedCanvasAssetHandoff({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => "user-a",
            searchParams,
            createdNodes: created,
            readLiveNodes: () => liveNodes,
            persist: async (nodes) => {
                persisted.push(nodes);
            },
            applyCreated: (nodes) => {
                pageNodes = rebaseCreatedCanvasNodes(pageNodes, nodes);
            },
            consumeUrl: (next) => {
                searchParams = next;
            },
            resetAttempt: () => {
                attemptKey = "";
            },
        });
        expect(retry).toBe("committed");
        expect(searchParams.get("mode")).toBeNull();
        expect(persisted[0].map((item) => item.id)).toEqual(["existing", "draft-during-load", "created"]);
        expect(pageNodes.map((item) => item.id)).toEqual(["existing", "draft-during-load", "created"]);
    });

    test("applyCreated rebases created nodes onto drafts typed during persist", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        const created = [node("created", { assetId: "asset-1" })];
        let pageNodes = [node("existing"), ...created];
        const persistGate = deferred();
        const pending = commitOwnedCanvasAssetHandoff({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => "user-a",
            searchParams: new URLSearchParams({ mode: "handoff", asset: "asset-1" }),
            createdNodes: created,
            readLiveNodes: () => pageNodes,
            persist: async () => {
                await persistGate.promise;
            },
            applyCreated: (nodes) => {
                pageNodes = rebaseCreatedCanvasNodes(pageNodes, nodes);
            },
            consumeUrl: () => {},
            resetAttempt: () => {},
        });
        pageNodes = [...pageNodes, node("typed-during-persist")];
        persistGate.resolve();
        expect(await pending).toBe("committed");
        expect(pageNodes.map((item) => item.id)).toEqual(["existing", "typed-during-persist", "created"]);
    });

    test("persists the original canvas after a switch and does not consume the new canvas URL", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        const created = [node("created", { assetId: "asset-1" })];
        let liveCanvasId = "canvas-a";
        const searchParams = new URLSearchParams({ mode: "handoff", asset: "asset-1" });
        const insertGate = deferred();
        const persisted: string[][] = [];
        const pending = (async () => {
            await insertGate.promise;
            return commitOwnedCanvasAssetHandoff({
                owner,
                getLiveCanvasId: () => liveCanvasId,
                getLiveUserScope: () => "user-a",
                searchParams,
                createdNodes: created,
                readLiveNodes: () => readOwnedCanvasNodes({
                    owner,
                    liveCanvasId,
                    liveUserScope: "user-a",
                    pageNodes: [node("new-canvas")],
                    storedNodes: [node("original"), ...created],
                }),
                persist: async (nodes) => {
                    persisted.push(nodes.map((item) => item.id));
                },
                applyCreated: () => {
                    throw new Error("must not mutate the new canvas");
                },
                consumeUrl: () => {
                    throw new Error("must not consume the new canvas URL");
                },
                resetAttempt: () => {},
            });
        })();
        liveCanvasId = "canvas-b";
        insertGate.resolve();
        expect(await pending).toBe("abandoned");
        expect(persisted).toEqual([["original", "created"]]);
        expect(searchParams.get("mode")).toBe("handoff");
    });
});

describe("archive and reload ownership", () => {
    test("does not stamp copied node ids on a different canvas after archive IO", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveCanvasId = "canvas-a";
        const copied = node("shared-id", { content: "same", assetId: "old" });
        let pageNodes = [copied];
        const archiveGate = deferred<{ assetId: string }[]>();
        const pending = runOwnedCanvasPageCommit({
            owner,
            getLiveCanvasId: () => liveCanvasId,
            getLiveUserScope: () => "user-a",
            work: () => archiveGate.promise,
            onCommit: (results) => {
                pageNodes = applyArchivedCanvasNodeAssets(pageNodes, new Map([
                    ["shared-id", { assetId: results[0].assetId, content: "same", previousAssetId: "old" }],
                ]));
            },
        });
        liveCanvasId = "canvas-b";
        pageNodes = [copied];
        archiveGate.resolve([{ assetId: "archived" }]);
        expect(await pending).toBe("abandoned");
        expect(pageNodes[0]?.metadata?.assetId).toBe("old");
    });
});

describe("assistant proposal ownership", () => {
    test("refuses generate after a canvas switch during prepare and never uses a later executor", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveCanvasId = "canvas-a";
        const prepareGate = deferred();
        const image = node("node-1", { prompt: "test image" });
        const proposal = { proposalId: "proposal-1", kind: "image" as const, nodeIds: [image.id], model: "Confirmed", modelKey: "channel::confirmed" };
        const capturedCalls: string[] = [];
        const liveCalls: string[] = [];
        const notices: string[] = [];
        const capturedGenerate = async () => {
            capturedCalls.push("captured");
        };
        let liveGenerate = capturedGenerate;
        const pending = executeAssistantProposal({
            proposal,
            nodes: [image],
            claims: new Set(),
            isHandled: false,
            prepare: async () => {
                await prepareGate.promise;
                return { nodes: [image], connections: [], config: defaultConfig, assets: [], skills: [] };
            },
            generate: (...args) => liveGenerate(...args),
            stillOwns: () => canvasOwnerEpochMatches(owner, liveCanvasId, "user-a"),
            markHandled: () => {},
            notify: (content) => {
                notices.push(content);
            },
        });
        liveCanvasId = "canvas-b";
        liveGenerate = async () => {
            liveCalls.push("live");
        };
        prepareGate.resolve();
        await pending;
        expect(capturedCalls).toEqual([]);
        expect(liveCalls).toEqual([]);
        expect(notices).toEqual([CANVAS_OWNER_CHANGED_PROPOSAL_MESSAGE]);
    });

    test("prepare failures after a canvas switch are not mapped to the generic retry copy", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveCanvasId = "canvas-a";
        const prepareGate = deferred();
        const image = node("node-1", { prompt: "test image" });
        const proposal = { proposalId: "proposal-2", kind: "image" as const, nodeIds: [image.id], model: "Confirmed", modelKey: "channel::confirmed" };
        const notices: string[] = [];
        let submissions = 0;
        const pending = executeAssistantProposal({
            proposal,
            nodes: [image],
            claims: new Set(),
            isHandled: false,
            prepare: async () => {
                await prepareGate.promise;
                throw new Error("offline");
            },
            generate: async () => {
                submissions += 1;
            },
            stillOwns: () => canvasOwnerEpochMatches(owner, liveCanvasId, "user-a"),
            markHandled: () => {},
            notify: (content) => {
                notices.push(content);
            },
        });
        liveCanvasId = "canvas-b";
        prepareGate.resolve();
        await pending;
        expect(submissions).toBe(0);
        expect(notices).toEqual([CANVAS_OWNER_CHANGED_PROPOSAL_MESSAGE]);
    });
});
