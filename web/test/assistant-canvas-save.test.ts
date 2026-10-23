import { beforeEach, expect, mock, test } from "bun:test";

let release: () => void;
let rejected = false;
let changedScope = false;
let pending: Promise<void>;
mock.module("@/stores/canvas/use-canvas-store", () => ({ flushCanvasStorePersistence: async () => {} }));
mock.module("@/services/local-workspace-repository", () => ({
    syncLocalCanvasProjectToBackend: async () => { await pending; },
    hasUnconfirmedCanvasEdits: () => rejected,
}));
mock.module("@/lib/user-scope-guard", () => ({ assertUserScope: () => { if (changedScope) throw new Error("scope changed"); } }));
const { saveCanvasForAssistant } = await import("@/services/assistant-canvas-save");
const scope = { userScope: "guest", epoch: 1 };
beforeEach(() => {
    rejected = false; changedScope = false;
    pending = new Promise<void>(resolve => { release = resolve; });
});

test("assistant admission waits for the backend save acknowledgement", async () => {
    let ready = false;
    const save = saveCanvasForAssistant("canvas", scope).then(() => { ready = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(ready).toBe(false);
    release(); await save;
    expect(ready).toBe(true);
});

test("an editor change still unconfirmed after saving blocks assistant admission", async () => {
    rejected = true; release();
    await expect(saveCanvasForAssistant("canvas", scope)).rejects.toThrow("画布还有未保存的修改");
});

test("switching user scope during a save blocks assistant admission", async () => {
    const save = saveCanvasForAssistant("canvas", scope);
    await Promise.resolve(); changedScope = true; release();
    await expect(save).rejects.toThrow("scope changed");
});
