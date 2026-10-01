import { describe, expect, spyOn, test } from "bun:test";
import axios from "axios";

import * as imageUtils from "@/lib/image-utils";
import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import * as userScopeGuard from "@/lib/user-scope-guard";
import { UserScopeAbandonedError } from "@/lib/user-scope-guard";
import { apiClient, http } from "@/services/api/request";
import { getResource, uploadResourceFile } from "@/services/api/resources";
import { uploadImage } from "@/services/image-storage";
import * as blobCache from "@/services/resource-blob-cache";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function envelope(resource: { id: string }) {
    return { code: 0, msg: "", data: { resource: { id: resource.id, kind: "image", status: "ready", publicUrl: "", size: 1, mimeType: "image/png" } } };
}

async function withAdapter<T>(adapter: NonNullable<typeof apiClient.defaults.adapter>, run: () => Promise<T>) {
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
        return await run();
    } finally {
        apiClient.defaults.adapter = previous;
    }
}

describe("HTTP expectedScope dispatch", () => {
    test("does not return an in-flight result after A to B to A", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = userScopeGuard.captureUserScope();
        const entered = deferred();
        const gate = deferred();
        try {
            await withAdapter(async (config) => {
                entered.resolve();
                await gate.promise;
                return { data: { code: 0, data: { assets: [] }, msg: "" }, status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                const pending = http.get("/assets", { expectedScope });
                await entered.promise;
                setActiveUserScope("owner-b");
                setActiveUserScope("owner-a");
                gate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
            });
        } finally { restore(); }
    });

    test("checks captured scope at send before a new request is constructed", async () => {
        const restore = switchScope("owner-a");
        const expected = userScopeGuard.captureUserScope();
        setActiveUserScope("owner-b");
        let sent = 0;
        try {
            await withAdapter(async () => {
                sent += 1;
                return { data: { code: 0, data: { ok: true }, msg: "" }, status: 200, statusText: "OK", headers: {}, config: {} as never };
            }, async () => {
                await expect(http.post("/resources", {}, { expectedScope: expected })).rejects.toBeInstanceOf(UserScopeAbandonedError);
            });
            expect(sent).toBe(0);
        } finally {
            restore();
        }
    });
});

describe("resource upload scope", () => {
    test("in-flight multipart may finish, but the response does not write the new account cache or start the next request", async () => {
        const restore = switchScope("owner-a");
        const entered = deferred();
        const gate = deferred();
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                urls.push(String(config.url || ""));
                entered.resolve();
                await gate.promise;
                return { data: envelope({ id: "res-inflight" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                const pending = uploadResourceFile(new Blob(["x"], { type: "image/png" }), "image", { fileName: "x.png" });
                await entered.promise;
                setActiveUserScope("owner-b");
                gate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(urls).toEqual(["/resources"]);
                let followUp = 0;
                apiClient.defaults.adapter = async (config) => {
                    followUp += 1;
                    throw new axios.AxiosError("missing", "ERR_BAD_REQUEST", config, undefined, {
                        data: { code: 404, data: null, msg: "not found" },
                        status: 404,
                        statusText: "Error",
                        headers: {},
                        config,
                    });
                };
                await expect(getResource("res-inflight")).rejects.toBeTruthy();
                expect(followUp).toBe(1);
            });
        } finally {
            restore();
        }
    });

    test("chunk PUT after an account change is abandoned and does not start complete", async () => {
        const restore = switchScope("owner-a");
        const entered = deferred();
        const sessionGate = deferred();
        const urls: string[] = [];
        const size = 51 * 1024 * 1024;
        try {
            await withAdapter(async (config) => {
                urls.push(String(config.url || ""));
                if (config.url === "/resources/uploads") {
                    entered.resolve();
                    await sessionGate.promise;
                    return { data: { code: 0, data: { uploadId: "session", chunkSize: 32 * 1024 * 1024, chunkCount: 2 }, msg: "" }, status: 200, statusText: "OK", headers: {}, config };
                }
                throw new Error(`unexpected ${config.url}`);
            }, async () => {
                const pending = uploadResourceFile(new Blob([new Uint8Array(size)]), "video", { fileName: "clip.mp4" });
                await entered.promise;
                setActiveUserScope("owner-b");
                sessionGate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(urls).toEqual(["/resources/uploads"]);
            });
        } finally {
            restore();
        }
    });

    test("429 wait then account change abandons before the retry request", async () => {
        const restore = switchScope("owner-a");
        const waitStarted = deferred();
        const waitGate = deferred();
        const wait = spyOn(userScopeGuard.userScopeRetryWait, "delay").mockImplementation(() => {
            waitStarted.resolve();
            return waitGate.promise;
        });
        const urls: string[] = [];
        const size = 51 * 1024 * 1024;
        try {
            await withAdapter(async (config) => {
                urls.push(String(config.url || ""));
                if (config.url === "/resources/uploads") {
                    throw new axios.AxiosError("rate limited", "ERR_BAD_REQUEST", config, undefined, {
                        data: { code: 429, data: null, msg: "请求过于频繁，请稍后重试" },
                        status: 429,
                        statusText: "Error",
                        headers: { "retry-after": "1" },
                        config,
                    });
                }
                throw new Error(`unexpected ${config.url}`);
            }, async () => {
                const pending = uploadResourceFile(new Blob([new Uint8Array(size)]), "video", { fileName: "clip.mp4" });
                await waitStarted.promise;
                expect(urls).toEqual(["/resources/uploads"]);
                setActiveUserScope("owner-b");
                waitGate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(urls).toEqual(["/resources/uploads"]);
            });
        } finally {
            wait.mockRestore();
            restore();
        }
    });
});

describe("uploadImage delayed promises", () => {
    test("account change during fetch does not upload or write caches", async () => {
        const restore = switchScope("owner-a");
        const fetchGate = deferred<Response>();
        const previousFetch = globalThis.fetch;
        const native = spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true);
        const decode = spyOn(imageUtils, "readImageMeta");
        const prime = spyOn(blobCache, "primeResourceBlobCache");
        let uploaded = 0;
        globalThis.fetch = (async () => fetchGate.promise) as typeof fetch;
        try {
            await withAdapter(async () => {
                uploaded += 1;
                return { data: envelope({ id: "res-fetch" }), status: 200, statusText: "OK", headers: {}, config: {} as never };
            }, async () => {
                const pending = uploadImage("https://cdn.example/a.png");
                setActiveUserScope("owner-b");
                fetchGate.resolve(new Response(new Blob(["img"], { type: "image/png" })));
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(uploaded).toBe(0);
                expect(decode).not.toHaveBeenCalled();
                expect(prime).not.toHaveBeenCalled();
            });
        } finally {
            globalThis.fetch = previousFetch;
            decode.mockRestore();
            prime.mockRestore();
            native.mockRestore();
            restore();
        }
    });

    test("account change during decode does not upload or fall back into the new account cache", async () => {
        const restore = switchScope("owner-a");
        const decodeGate = deferred<{ width: number; height: number; mimeType: string }>();
        const native = spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true);
        const decode = spyOn(imageUtils, "readImageMeta").mockImplementation(() => decodeGate.promise);
        const prime = spyOn(blobCache, "primeResourceBlobCache");
        let uploaded = 0;
        try {
            await withAdapter(async () => {
                uploaded += 1;
                return { data: envelope({ id: "res-decode" }), status: 200, statusText: "OK", headers: {}, config: {} as never };
            }, async () => {
                const pending = uploadImage(new Blob(["img"], { type: "image/png" }));
                await Promise.resolve();
                setActiveUserScope("owner-b");
                decodeGate.resolve({ width: 8, height: 8, mimeType: "image/png" });
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(uploaded).toBe(0);
                expect(prime).not.toHaveBeenCalled();
            });
        } finally {
            decode.mockRestore();
            prime.mockRestore();
            native.mockRestore();
            restore();
        }
    });

    test("successful upload that completes after an account change does not prime the new account cache", async () => {
        const restore = switchScope("owner-a");
        const uploadGate = deferred();
        const native = spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true);
        const decode = spyOn(imageUtils, "readImageMeta").mockResolvedValue({ width: 8, height: 8, mimeType: "image/png" });
        const prime = spyOn(blobCache, "primeResourceBlobCache").mockResolvedValue("");
        try {
            await withAdapter(async (config) => {
                await uploadGate.promise;
                return { data: envelope({ id: "res-cache" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                const pending = uploadImage(new Blob(["img"], { type: "image/png" }));
                setActiveUserScope("owner-b");
                uploadGate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(prime).not.toHaveBeenCalled();
            });
        } finally {
            decode.mockRestore();
            prime.mockRestore();
            native.mockRestore();
            restore();
        }
    });
});
