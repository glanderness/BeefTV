import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { GenerationTask } from "@/services/api/task-center";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { insertOrReturnGenerationAsset, type GenerationAssetRecord } from "@/services/generation-asset-repository";
import { createGenerationTaskMaterializer, createIdempotentMaterializeOutput } from "@/services/generation-task-materializer";
import { createProviderNeutralGenerationTaskEffectStore } from "@/services/provider-neutral-generation-effects";

function makeTask(id = "task-1"): GenerationTask {
    return {
        id,
        type: "image",
        status: "succeeded",
        prompt: "prompt",
        attempts: 1,
        resultState: "MATERIALIZING",
        outputs: [{ outputIndex: 0, mediaType: "image", url: "https://example.com/1.png" }],
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
    };
}

describe("in-process generation task effect store & materializer", () => {
    let previousScope = "";

    beforeEach(() => {
        previousScope = getActiveUserScope();
        setActiveUserScope("user-a");
    });

    afterEach(() => {
        setActiveUserScope(previousScope);
    });

    it("serializes concurrent claims for the same effect key and shares the completed result without polling or Web Locks", async () => {
        const effects = createProviderNeutralGenerationTaskEffectStore();
        let materializeCalls = 0;
        let finishMaterialize!: (assetId: string) => void;
        const gate = new Promise<string>((resolve) => {
            finishMaterialize = resolve;
        });

        const materializer = createGenerationTaskMaterializer({
            effects,
            async materializeOutput() {
                materializeCalls += 1;
                return { materializedAssetId: await gate };
            },
        });

        const first = materializer.materialize(makeTask("task-concurrent"));
        const second = materializer.materialize(makeTask("task-concurrent"));
        await Promise.resolve();
        expect(materializeCalls).toBe(1);

        finishMaterialize("asset-shared");
        const [r1, r2] = await Promise.all([first, second]);
        expect(materializeCalls).toBe(1);
        expect(r1.outputs?.[0]?.materializedAssetId).toBe("asset-shared");
        expect(r2.outputs?.[0]?.materializedAssetId).toBe("asset-shared");
        expect(r1.resultState).toBe("READY");
        expect(r2.resultState).toBe("READY");
    });

    it("hands off immediately to a queued caller when the first claim releases on failure", async () => {
        const effects = createProviderNeutralGenerationTaskEffectStore();
        let attempts = 0;
        let failFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            failFirst = resolve;
        });

        const materializer = createGenerationTaskMaterializer({
            effects,
            async materializeOutput() {
                attempts += 1;
                if (attempts === 1) {
                    await firstGate;
                    throw new Error("transient failure");
                }
                return { materializedAssetId: "asset-recovered" };
            },
        });

        const first = materializer.materialize(makeTask("task-retry"));
        const second = materializer.materialize(makeTask("task-retry"));
        failFirst();

        await expect(first).rejects.toThrow("transient failure");
        const recovered = await second;
        expect(attempts).toBe(2);
        expect(recovered.outputs?.[0]?.materializedAssetId).toBe("asset-recovered");
    });

    it("releases the slot when the owner aborts and lets a queued waiter take over", async () => {
        const effects = createProviderNeutralGenerationTaskEffectStore();
        let attempts = 0;
        const ownerAbort = new AbortController();

        const materializer = createGenerationTaskMaterializer({
            effects,
            async materializeOutput({ signal }) {
                attempts += 1;
                if (attempts === 1) {
                    return new Promise((_, reject) => {
                        signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")), { once: true });
                    });
                }
                return { materializedAssetId: "asset-after-owner-abort" };
            },
        });

        const owner = materializer.materialize(makeTask("task-owner-abort"), ownerAbort.signal);
        const waiter = materializer.materialize(makeTask("task-owner-abort"));
        await Promise.resolve();
        ownerAbort.abort();

        await expect(owner).rejects.toMatchObject({ name: "AbortError" });
        const recovered = await waiter;
        expect(attempts).toBe(2);
        expect(recovered.outputs?.[0]?.materializedAssetId).toBe("asset-after-owner-abort");
    });

    it("aborts a waiting caller cleanly without blocking later callers", async () => {
        const effects = createProviderNeutralGenerationTaskEffectStore();
        let finishFirst!: () => void;
        const gate = new Promise<void>((resolve) => {
            finishFirst = resolve;
        });

        const materializer = createGenerationTaskMaterializer({
            effects,
            async materializeOutput() {
                await gate;
                return { materializedAssetId: "asset-ok" };
            },
        });

        const first = materializer.materialize(makeTask("task-abort-waiter"));
        const waiterAbort = new AbortController();
        const waiter = materializer.materialize(makeTask("task-abort-waiter"), waiterAbort.signal);
        waiterAbort.abort();

        await expect(waiter).rejects.toMatchObject({ name: "AbortError" });
        finishFirst();
        const completed = await first;
        expect(completed.outputs?.[0]?.materializedAssetId).toBe("asset-ok");
    });

    it("isolates completed and in-flight effects across user scopes and across store instances", async () => {
        const storeA = createProviderNeutralGenerationTaskEffectStore();
        const storeB = createProviderNeutralGenerationTaskEffectStore();
        const calls: string[] = [];
        const makeMaterializer = (effects: ReturnType<typeof createProviderNeutralGenerationTaskEffectStore>) =>
            createGenerationTaskMaterializer({
                effects,
                async materializeOutput({ task }) {
                    calls.push(`${getActiveUserScope()}:${task.id}`);
                    return { materializedAssetId: `asset-${getActiveUserScope()}` };
                },
            });

        const mA = makeMaterializer(storeA);
        const mB = makeMaterializer(storeB);

        setActiveUserScope("user-a");
        const resA = await mA.materialize(makeTask("task-shared-id"));
        setActiveUserScope("user-b");
        const resB = await mA.materialize(makeTask("task-shared-id"));
        setActiveUserScope("user-a");
        const resIsolatedStore = await mB.materialize(makeTask("task-shared-id"));

        expect(calls).toEqual(["user-a:task-shared-id", "user-b:task-shared-id", "user-a:task-shared-id"]);
        expect(resA.outputs?.[0]?.materializedAssetId).toBe("asset-user-a");
        expect(resB.outputs?.[0]?.materializedAssetId).toBe("asset-user-b");
        expect(resIsolatedStore.outputs?.[0]?.materializedAssetId).toBe("asset-user-a");
    });

    it("keeps cross-reload materialization idempotent via durable asset generationEffectKey when memory store resets", async () => {
        let durableAssets: GenerationAssetRecord[] = [];
        let liveAssets: GenerationAssetRecord[] = [];
        let persistCount = 0;

        const makeReloadedMaterializer = () =>
            createGenerationTaskMaterializer({
                effects: createProviderNeutralGenerationTaskEffectStore(),
                materializeOutput: createIdempotentMaterializeOutput({
                    insertOrReturnAsset: ({ task, effectKey, signal }) =>
                        insertOrReturnGenerationAsset({
                            storageScope: getActiveUserScope(),
                            effectKey,
                            assetId: `asset:${task.id}:0`,
                            signal,
                            createAsset: () => ({ id: `asset:${task.id}:0`, metadata: { generationEffectKey: effectKey } }),
                            updateAssets: (updater) => {
                                liveAssets = updater(liveAssets);
                            },
                            readAssets: () => liveAssets,
                            readPersistedAssets: async () => durableAssets,
                            persistAssets: async (next) => {
                                persistCount += 1;
                                durableAssets = next;
                            },
                        }),
                }),
            });

        const firstRun = await makeReloadedMaterializer().materialize(makeTask("task-reload"));
        const secondRunAfterReload = await makeReloadedMaterializer().materialize(makeTask("task-reload"));

        expect(firstRun.outputs?.[0]?.materializedAssetId).toBe("asset:task-reload:0");
        expect(secondRunAfterReload.outputs?.[0]?.materializedAssetId).toBe("asset:task-reload:0");
        expect(durableAssets).toHaveLength(1);
        expect(persistCount).toBe(1);
    });
});
