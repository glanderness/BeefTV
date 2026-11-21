import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { GenerationTask } from "@/services/api/task-center";

let activeScope = "user-a";

mock.module("@/lib/user-scope", () => ({
    getActiveUserScope: () => activeScope,
}));

const { createProviderNeutralGenerationTaskEffectStore, resetGenerationTaskEffectStoreForTest } = await import(
    "@/services/provider-neutral-generation-effects"
);
const { createGenerationTaskMaterializer } = await import("@/services/generation-task-materializer");

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
    beforeEach(() => {
        activeScope = "user-a";
        resetGenerationTaskEffectStoreForTest();
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

    it("isolates completed and in-flight effects across user scopes", async () => {
        const effects = createProviderNeutralGenerationTaskEffectStore();
        const calls: string[] = [];
        const materializer = createGenerationTaskMaterializer({
            effects,
            async materializeOutput({ task }) {
                calls.push(`${activeScope}:${task.id}`);
                return { materializedAssetId: `asset-${activeScope}` };
            },
        });

        activeScope = "user-a";
        const resA = await materializer.materialize(makeTask("task-shared-id"));
        activeScope = "user-b";
        const resB = await materializer.materialize(makeTask("task-shared-id"));

        expect(calls).toEqual(["user-a:task-shared-id", "user-b:task-shared-id"]);
        expect(resA.outputs?.[0]?.materializedAssetId).toBe("asset-user-a");
        expect(resB.outputs?.[0]?.materializedAssetId).toBe("asset-user-b");
    });
});
