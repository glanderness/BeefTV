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
import { clearResourceMemoryCache, peekCachedResourceObjectUrl } from "../src/services/resource-blob-cache";
import { resolveResourceVideoPlayback } from "../src/services/resource-video-playback";

const originalAdapter = apiClient.defaults.adapter;

afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
    clearMediaTicketCache();
    clearResourceMemoryCache();
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

test("peekCachedResourceObjectUrl stays strictly memory-cache-only in desktop mode so viewport lazy-loading remains active", () => {
    setDirectMediaAssetsEnabled(true);
    clearResourceMemoryCache();
    expect(peekCachedResourceObjectUrl("resource:img-lazy-1", 512)).toBe("");
});

test("setCanvasMemoryMode strips safeMode and memoryMode query params via history.replaceState", () => {
    const originalWindow = globalThis.window;
    let replacedUrl = "";
    Object.assign(globalThis, {
        window: {
            location: { href: "http://wails.localhost/?safeMode=1&memoryMode=thumbnail-only&keep=1#/canvas/c-1" },
            history: {
                state: { idx: 1 },
                replaceState: (_state: unknown, _title: string, url: string) => {
                    replacedUrl = url;
                },
            },
            localStorage: {
                setItem: () => undefined,
                getItem: () => null,
            },
        },
    });
    try {
        setCanvasMemoryMode("normal");
        expect(replacedUrl).toBe("/?keep=1#/canvas/c-1");
    } finally {
        Object.assign(globalThis, { window: originalWindow });
    }
});

test("loopback media ticket streams videos without downloading blobs, caches within TTL, and refreshes after invalidation or expiry", async () => {
    configureApiRuntime("http://127.0.0.1:43210/api", "desktop-secret");
    setDirectMediaAssetsEnabled(true);
    let ticketCalls = 0;
    let fileBlobDownloads = 0;
    let nextExpiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
    apiClient.defaults.adapter = async (config) => {
        if (config.url?.includes("/file")) {
            fileBlobDownloads += 1;
            throw new Error("video playback must not download raw blob via /file when loopback tickets are enabled");
        }
        if (config.url === "/resources/vid-1/media-ticket") {
            ticketCalls += 1;
            const variant = JSON.parse(String(config.data || "{}")).variant || "original";
            return {
                data: {
                    code: 0,
                    data: {
                        ticket: `tok-${ticketCalls}`,
                        path: `/media/tok-${ticketCalls}/vid-1.mp4`,
                        expiresAt: nextExpiresAt,
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
    expect(typeof first === "object" && "url" in first).toBe(true);
    if (typeof first === "object" && "url" in first) {
        expect(first.url).toBe("http://127.0.0.1:43210/media/tok-1/vid-1.mp4");
        expect(first.compatible).toBe(false);
        expect(first.mode).toBe("loopback-ticket");
        expect(typeof first.expiresAtMs).toBe("number");
    }
    expect(fileBlobDownloads).toBe(0);

    // Second call reuses the cached ticket without another POST.
    const second = await resolveResourceMediaStream("vid-1", "original");
    expect(second.url).toBe("http://127.0.0.1:43210/media/tok-1/vid-1.mp4");
    expect(ticketCalls).toBe(1);

    // Invalidating the ticket forces a fresh ticket on next request.
    invalidateResourceMediaTicket("vid-1");
    const refreshed = await resolveResourceMediaStream("vid-1", "original");
    expect(refreshed.url).toBe("http://127.0.0.1:43210/media/tok-2/vid-1.mp4");
    expect(ticketCalls).toBe(2);

    // A ticket within the refresh margin triggers automatic re-issuance on next resolve.
    invalidateResourceMediaTicket("vid-1");
    nextExpiresAt = new Date(Date.now() + 30_000).toISOString();
    const nearExpiry = await resolveResourceMediaStream("vid-1", "original");
    expect(nearExpiry.url).toBe("http://127.0.0.1:43210/media/tok-3/vid-1.mp4");
    nextExpiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
    const autoRenewed = await resolveResourceMediaStream("vid-1", "original");
    expect(autoRenewed.url).toBe("http://127.0.0.1:43210/media/tok-4/vid-1.mp4");
    expect(ticketCalls).toBe(4);
    expect(fileBlobDownloads).toBe(0);
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
