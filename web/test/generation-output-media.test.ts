import { afterEach, expect, spyOn, test } from "bun:test";
import * as fileSaver from "file-saver";
import type { GenerationOutput } from "@/lib/generation-outputs";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { apiClient, configureApiRuntime } from "@/services/api/request";
import { downloadGenerationOutput, readGenerationOutputBlob } from "@/services/generation-output-media";

const originalWindow = globalThis.window;
const originalAdapter = apiClient.defaults.adapter;
const originalFetch = globalThis.fetch;
const originalScope = getActiveUserScope();
afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
    apiClient.defaults.adapter = originalAdapter;
    setActiveUserScope(originalScope);
    configureApiRuntime("/api", "");
});
const output: GenerationOutput = { id: "output:2", outputIndex: 2, mediaType: "audio", storageKey: "resource:owned-sound", dataUrl: "/api/resources/owned-sound/file", mimeType: "audio/wav" };

test("audio and file reads attach the desktop credential through the shared client", async () => {
    configureApiRuntime("http://127.0.0.1:43123/api", "test-desktop-token");
    const blob = new Blob(["audio"], { type: "audio/wav" });
    const controller = new AbortController();
    let requests = 0;
    apiClient.defaults.adapter = async (config) => {
        requests++;
        expect(config.url).toBe("/resources/owned-sound/file?proxy=1");
        expect(config.headers.get("X-Desktop-Token")).toBe("test-desktop-token");
        expect(config.responseType).toBe("blob");
        expect(config.signal).toBe(controller.signal);
        return { data: blob, status: 200, statusText: "OK", headers: {}, config };
    };
    expect(await readGenerationOutputBlob(output, controller.signal)).toBe(blob);
    expect(await readGenerationOutputBlob({ ...output, storageKey: undefined, mediaType: "file" }, controller.signal)).toBe(blob);
    expect(requests).toBe(2);
});

test("auth failures never retry a protected output with bare fetch", async () => {
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return new Response("unexpected"); }) as typeof fetch;
    apiClient.defaults.adapter = async () => { throw new Error("403"); };
    await expect(readGenerationOutputBlob(output)).rejects.toThrow("输出文件读取失败");
    expect(fetched).toBe(false);
});

test("closing preview and changing owner abandon pending output reads", async () => {
    const controller = new AbortController();
    apiClient.defaults.adapter = async (config) => {
        controller.abort();
        return { data: new Blob(["old audio"]), status: 200, statusText: "OK", headers: {}, config };
    };
    await expect(readGenerationOutputBlob(output, controller.signal)).rejects.toBeTruthy();
    apiClient.defaults.adapter = async (config) => {
        setActiveUserScope("different-output-owner");
        return { data: new Blob(["old audio"]), status: 200, statusText: "OK", headers: {}, config };
    };
    await expect(readGenerationOutputBlob(output)).rejects.toMatchObject({ name: "UserScopeAbandonedError" });
});

test("all desktop outputs save owned resources through Wails and preserve cancel", async () => {
    const calls: Array<[string, string]> = [];
    Object.assign(globalThis, { window: { location: { protocol: "wails:" }, go: { main: { DesktopApp: { SaveOwnedMedia: async (name: string, id: string) => { calls.push([name, id]); return ""; } } } } } });
    apiClient.defaults.adapter = async () => { throw new Error("native downloads should not fetch"); };
    for (const mediaType of ["image", "video", "audio", "file"] as const) {
        expect(await downloadGenerationOutput({ ...output, mediaType })).toBe("cancelled");
    }
    expect(calls).toEqual(Array.from({ length: 4 }, () => ["output-3.wav", "owned-sound"]));
});

test("browser download saves authenticated bytes rather than the protected URL", async () => {
    const blob = new Blob(["audio"], { type: "audio/wav" });
    const save = spyOn(fileSaver, "saveAs").mockImplementation(() => undefined);
    Object.assign(globalThis, { window: { location: { protocol: "http:" } } });
    apiClient.defaults.adapter = async (config) => ({ data: blob, status: 200, statusText: "OK", headers: {}, config });
    try {
        expect(await downloadGenerationOutput(output)).toBe("saved");
        expect(save).toHaveBeenCalledWith(blob, "output-3.wav");
    } finally { save.mockRestore(); }
});
