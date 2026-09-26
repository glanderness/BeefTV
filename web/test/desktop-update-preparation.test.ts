import { expect, test } from "bun:test";
import { prepareDesktopEditorsForUpdate, registerDesktopUpdatePreparation } from "../src/services/desktop-update-preparation";

test("restart preparation waits for mounted editor persistence", async () => {
    let complete!: () => void;
    let saved = false;
    let prepared = false;
    const unregister = registerDesktopUpdatePreparation(async () => {
        await new Promise<void>((resolve) => {
            complete = resolve;
        });
        saved = true;
    });
    try {
        const pending = prepareDesktopEditorsForUpdate().then(() => {
            prepared = true;
        });
        await Promise.resolve();
        expect(prepared).toBe(false);
        complete();
        await pending;
        expect(saved).toBe(true);
        expect(prepared).toBe(true);
    } finally {
        unregister();
    }
});

test("failed editor save blocks restart and remains retryable", async () => {
    let fails = true;
    const unregister = registerDesktopUpdatePreparation(async () => {
        if (fails) throw new Error("save failed");
    });
    try {
        await expect(prepareDesktopEditorsForUpdate()).rejects.toThrow("save failed");
        fails = false;
        await prepareDesktopEditorsForUpdate();
    } finally {
        unregister();
    }
});

test("unmounted workspace callbacks no longer block another workspace", async () => {
    const unregister = registerDesktopUpdatePreparation(() => {
        throw new Error("stale workspace");
    });
    unregister();
    await prepareDesktopEditorsForUpdate();
});
