import { afterEach, expect, test } from "bun:test";

import { setCanvasMemoryMode } from "../src/lib/canvas/canvas-memory-policy";
import { apiClient, configureApiRuntime } from "../src/services/api/request";
import { createDiagnosticEventStore } from "../src/services/diagnostics/diagnostic-event-store";
import {
    clearMediaTicketCache,
    invalidateResourceMediaTicket,
    resolveResourceMediaStream,
    resourcePosterAssetUrl,
    resourcePreviewAssetUrl,
    setDirectMediaAssetsEnabled,
} from "../src/services/media-asset-url";
import { resolveResourceVideoPlayback } from "../src/services/resource-video-playback";

const originalAdapter = apiClient.defaults.adapter;

afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
    clearMediaTicketCache();
    setDirectMediaAssetsEnabled(null);
    setCanvasMemoryMode("normal");
    configureApiRuntime("/api");
});

test("same-origin preview and poster asset URLs snap to discrete tiers and respect canvas memory modes", () => {
    setCanvasMemoryMode("normal");
    expect(resourcePreviewAssetUrl("res-123", 128)).toBe("/api/resources/res-123/asset/preview-256.jpg?variant=preview&w=256&color=preserve");
    expect(resourcePreviewAssetUrl("res-123", 900)).toBe("/api/resources/res-123/asset/preview-1024.jpg?variant=preview&w=1024&color=preserve");
    expect(resourcePosterAssetUrl("res-123")).toBe("/api/resources/res-123/asset/poster.jpg?variant=poster");

    setCanvasMemoryMode("low-memory");
    expect(resourcePreviewAssetUrl("res-123", 2048)).toBe("/api/resources/res-123/asset/preview-512.jpg?variant=preview&w=512&color=preserve");

    setCanvasMemoryMode("thumbnail-only");
    expect(resourcePreviewAssetUrl("res-123", 2048)).toBe("/api/resources/res-123/asset/preview-256.jpg?variant=preview&w=256&color=preserve");
});

test("loopback media ticket streams videos without downloading blobs, caches within TTL, and refreshes after invalidation", async () => {
    configureApiRuntime("http://127.0.0.1:43210/api", "desktop-secret");
    setDirectMediaAssetsEnabled(true);
    let ticketCalls = 0;
    apiClient.defaults.adapter = async (config) => {
        if (config.url === "/resources/vid-1/media-ticket") {
            ticketCalls += 1;
            const variant = JSON.parse(String(config.data || "{}")).variant || "original";
            return {
                data: {
                    code: 0,
                    data: {
                        ticket: `tok-${ticketCalls}`,
                        path: `/media/tok-${ticketCalls}/vid-1.mp4`,
                        expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
                        mimeType: "video/mp4",
                        size: 50_000_000,
                        variant,
                    },
                    msg: "",
                },
                status: 200,
                statusText: "OK",
                headers: {},
                config,
            };
        }
        return {
            data: { code: 0, data: { resource: { id: "vid-1", playbackStatus: "none" } }, msg: "" },
            status: 200,
            statusText: "OK",
            headers: {},
            config,
        };
    };

    const first = await resolveResourceVideoPlayback("resource:vid-1", "", new AbortController().signal);
    expect(first).toEqual({
        url: "http://127.0.0.1:43210/media/tok-1/vid-1.mp4",
        compatible: false,
        mode: "loopback-ticket",
    });

    // Second call reuses the cached ticket without another POST.
    const second = await resolveResourceMediaStream("vid-1", "original");
    expect(second.url).toBe("http://127.0.0.1:43210/media/tok-1/vid-1.mp4");
    expect(ticketCalls).toBe(1);

    // Invalidating the ticket forces a fresh ticket on next request.
    invalidateResourceMediaTicket("vid-1");
    const refreshed = await resolveResourceMediaStream("vid-1", "original");
    expect(refreshed.url).toBe("http://127.0.0.1:43210/media/tok-2/vid-1.mp4");
    expect(ticketCalls).toBe(2);
});

test("diagnostic event store snapshot enforces a hard deadline and degrades to partial in-memory events when IndexedDB stalls", async () => {
    const never = new Promise<string | null>(() => undefined);
    const store = createDiagnosticEventStore({
        storage: () => ({
            getItem: () => never,
            setItem: () => never,
        }),
        sanitize: (event) => event,
        launchId: "launch-deadline-test",
        timeoutMs: 10_000,
        snapshotTimeoutMs: 60,
    });
    store.setScope("user-stall");
    store.record({
        id: "ev-1",
        timestamp: new Date().toISOString(),
        level: "error",
        category: "runtime",
        code: "OOM_WARNING",
        message: "renderer memory pressure",
    });

    const started = Date.now();
    const snapshot = await store.snapshot();
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(400);
    expect(snapshot.events.map((ev) => ev.id)).toEqual(["ev-1"]);
    expect(snapshot.coverage.status).toBe("partial");
    expect(snapshot.coverage.persisted).toBe(false);
});
