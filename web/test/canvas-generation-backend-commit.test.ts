import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("completed generation effects commit to the desktop canonical repository", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/services/canvas-generation-consumer.ts"), "utf8");
    const durableCommit = source.indexOf("const persisted = await withCanvasStorePersistenceLock(");
    const backendCommit = source.indexOf("await syncLocalCanvasGenerationProjectToBackend(input.projectId, input.effectKey)");
    expect(durableCommit).toBeGreaterThan(-1);
    expect(backendCommit).toBeGreaterThan(durableCommit);
    expect(source.indexOf("return persisted;", backendCommit)).toBeGreaterThan(backendCommit);
});

test("generation backend commit carries its idempotent effect key", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/services/local-workspace-repository.ts"), "utf8");
    expect(source).toContain("effectKey: generationEffectKey");
});
