import { expect, test } from "bun:test";
import { waitForAssistant } from "@/pages/canvas/assistant-readiness";
import {
    createCanvasRun,
    isAssistantTransientReason,
    resolveAssistantStatusPollError,
    shouldAutoLoadHistory,
    shouldSuppressAssistantHistoryError,
} from "@/pages/canvas/canvas-assistant-recovery";

test("preparing can become ready before any chat is dispatched", async () => {
    let reads = 0;
    const status = await waitForAssistant(new AbortController().signal, async () => ++reads === 1 ? { available: false, reason: "host_starting" } : { available: true }, undefined, 1);
    expect(status.available).toBe(true);
    expect(reads).toBe(2);
});
test("host_busy is treated as transient and waits for readiness instead of failing", async () => {
    let reads = 0;
    const status = await waitForAssistant(new AbortController().signal, async () => {
        reads += 1;
        if (reads === 1) return { available: false, reason: "host_busy" };
        if (reads === 2) return { available: false, reason: "host_starting" };
        return { available: true };
    }, undefined, 1);
    expect(status.available).toBe(true);
    expect(reads).toBe(3);
});
test("default wait budget survives cold startups longer than 10 seconds", async () => {
    let reads = 0;
    const status = await waitForAssistant(new AbortController().signal, async () => {
        reads += 1;
        return reads <= 25 ? { available: false, reason: "host_starting" } : { available: true };
    }, undefined, 1);
    expect(status.available).toBe(true);
    expect(reads).toBe(26);
});
test("configuration errors fail immediately instead of polling forever", async () => {
    let reads = 0;
    await expect(waitForAssistant(new AbortController().signal, async () => { reads++; return { available: false, reason: "credential_missing" }; }, undefined, 1)).rejects.toThrow();
    expect(reads).toBe(1);
});
test("stop while preparing prevents dispatch", async () => {
    const controller = new AbortController();
    const pending = waitForAssistant(controller.signal, async () => ({ available: false, reason: "host_starting" }));
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
});
test("single transient poll failure preserves available, host_starting, and host_busy; second failure or explicit reason degrades", () => {
    expect(isAssistantTransientReason("host_starting")).toBe(true);
    expect(isAssistantTransientReason("host_busy")).toBe(true);
    expect(isAssistantTransientReason("host_unreachable")).toBe(false);

    for (const prev of [
        { available: true },
        { available: false, reason: "host_starting" as const },
        { available: false, reason: "host_busy" as const },
    ]) {
        expect(resolveAssistantStatusPollError(prev, undefined, 1)).toEqual(prev);
        expect(resolveAssistantStatusPollError(prev, undefined, 2)).toEqual({ available: false });
        expect(resolveAssistantStatusPollError(prev, "host_unreachable", 1)).toEqual({ available: false, reason: "host_unreachable" });
    }
    expect(resolveAssistantStatusPollError(null, undefined, 1)).toEqual({ available: false });
});
test("host_busy allows history auto-reload and suppresses transient empty-history error banner", () => {
    const erroredRun = { ...createCanvasRun(), historyError: "没能读取对话。请重新读取。", historyHostUnavailable: true };
    expect(shouldAutoLoadHistory(erroredRun, { available: false, reason: "host_busy" })).toBe(true);
    expect(shouldSuppressAssistantHistoryError({ available: false, reason: "host_busy" }, erroredRun)).toBe(true);
    expect(shouldSuppressAssistantHistoryError({ available: false, reason: "host_starting" }, erroredRun)).toBe(true);
    expect(shouldSuppressAssistantHistoryError({ available: false, reason: "host_unreachable" }, erroredRun)).toBe(false);
});
test("cold-start unknown or host_starting status defers history auto-load until host responds", () => {
    expect(shouldAutoLoadHistory(createCanvasRun(), null)).toBe(false);
    expect(shouldAutoLoadHistory(createCanvasRun(), { available: false, reason: "host_starting" })).toBe(false);
    expect(shouldAutoLoadHistory(createCanvasRun(), { available: true })).toBe(true);
    expect(shouldAutoLoadHistory(createCanvasRun(), { available: false, reason: "model_not_configured" })).toBe(true);
    expect(shouldAutoLoadHistory(createCanvasRun(), { available: false, reason: "host_unreachable" })).toBe(true);
    expect(shouldAutoLoadHistory(createCanvasRun(), { available: false })).toBe(true);
});
