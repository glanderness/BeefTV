import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { InternalAxiosRequestConfig } from "axios";

import { installLocalForageStoreFactoryForTests } from "@/lib/localforage-storage";
import { apiClient } from "@/services/api/request";
import {
    resetCanvasOperationJournalMemory,
    setCanvasJournalStorageTimeoutForTest,
} from "@/services/canvas-operation-journal";
import {
    resetLocalCanvasBackendSaveState,
    syncLocalCanvasProjectToBackend,
} from "@/services/local-workspace-repository";
import {
    flushCanvasStorePersistence,
    hasActiveCanvasStorePersistence,
    setCanvasStorePersistenceTimeoutsForTest,
    withCanvasStorePersistenceLock,
    withCanvasStorePersistenceSuppressed,
} from "@/stores/canvas/canvas-store-persistence";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { projectSyncProgress, useSyncProgressStore } from "@/stores/use-sync-progress-store";

function makeMemoryForage(options: { hangSetItem?: () => boolean } = {}) {
    const data = new Map<string, unknown>();
    return {
        ready: async () => undefined,
        getItem: async <T>(key: string) => (data.has(key) ? (data.get(key) as T) : null),
        setItem: async <T>(key: string, value: T) => {
            if (options.hangSetItem?.()) {
                return new Promise<T>(() => {});
            }
            data.set(key, value);
            return value;
        },
        removeItem: async (key: string) => {
            data.delete(key);
        },
        keys: async () => [...data.keys()],
        clear: async () => {
            data.clear();
        },
        length: async () => data.size,
        iterate: async <T, U>(iteratee: (value: T, key: string, iterationNumber: number) => U) => {
            let idx = 1;
            for (const [key, value] of data.entries()) {
                const res = iteratee(value as T, key, idx++);
                if (res !== undefined) return res;
            }
            return undefined as unknown as U;
        },
    } as unknown as LocalForage;
}

function makeProject(id: string, title: string, revision = 1): CanvasProject {
    const now = "2026-04-06T00:00:00.000Z";
    return {
        id,
        revision,
        title,
        createdAt: now,
        updatedAt: now,
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
}

describe("canvas local persistence deadlock protection", () => {
    const originalWindow = globalThis.window;
    const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const originalAdapter = apiClient.defaults.adapter;

    beforeEach(async () => {
        resetLocalCanvasBackendSaveState();
        resetCanvasOperationJournalMemory();
        useSyncProgressStore.getState().clearAll();
        withCanvasStorePersistenceSuppressed(() => {
            useCanvasStore.setState({ projects: [] });
        });
        setCanvasStorePersistenceTimeoutsForTest({ lockTimeoutMs: 30, ioTimeoutMs: 60 });
        setCanvasJournalStorageTimeoutForTest(40);
        await flushCanvasStorePersistence().catch(() => undefined);
    });

    afterEach(async () => {
        setCanvasStorePersistenceTimeoutsForTest(null);
        setCanvasJournalStorageTimeoutForTest(null);
        installLocalForageStoreFactoryForTests();
        apiClient.defaults.adapter = originalAdapter;
        if (originalWindow === undefined) {
            delete (globalThis as Record<string, unknown>).window;
        } else {
            globalThis.window = originalWindow;
        }
        if (originalNavigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
        } else {
            delete (globalThis as Record<string, unknown>).navigator;
        }
        resetLocalCanvasBackendSaveState();
        resetCanvasOperationJournalMemory();
        useSyncProgressStore.getState().clearAll();
        withCanvasStorePersistenceSuppressed(() => {
            useCanvasStore.setState({ projects: [] });
        });
        await flushCanvasStorePersistence().catch(() => undefined);
    });

    test("hung navigator.locks falls back via timeout without deadlocking or double-running late callbacks", async () => {
        let lateCallback: (() => Promise<unknown>) | null = null;
        let abortCount = 0;
        (globalThis as Record<string, unknown>).window = {
            location: { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" },
        };
        Object.defineProperty(globalThis, "navigator", {
            configurable: true,
            value: {
                locks: {
                    request: (_name: string, options: { signal?: AbortSignal }, cb: () => Promise<unknown>) => {
                        lateCallback = cb;
                        options?.signal?.addEventListener("abort", () => {
                            abortCount += 1;
                        });
                        // Deliberately ignore abort signal and hang forever (simulating WebView lock stall).
                        return new Promise(() => {});
                    },
                },
            },
        });
        installLocalForageStoreFactoryForTests(() => makeMemoryForage());

        let runs = 0;
        const result = await withCanvasStorePersistenceLock("guest", async () => {
            runs += 1;
            return "written";
        });
        expect(result).toBe("written");
        expect(runs).toBe(1);
        expect(abortCount).toBe(1);
        expect(hasActiveCanvasStorePersistence()).toBe(false);

        // Even if the hung browser lock later wakes up and invokes the callback, it must not re-run.
        await lateCallback?.();
        expect(runs).toBe(1);

        // flushCanvasStorePersistence() also resolves via fallback when navigator.locks hangs.
        useCanvasStore.setState({ projects: [makeProject("c-hung-lock-flush", "锁超时降级写入")] });
        await expect(flushCanvasStorePersistence()).resolves.toBeUndefined();
        expect(hasActiveCanvasStorePersistence()).toBe(false);

        // Strict cross-realm callers still fail closed on lock timeout instead of bypassing the lock.
        await expect(
            withCanvasStorePersistenceLock("guest", async () => "must-not-run", { requireCrossRealmLock: true }),
        ).rejects.toThrow("超时");
    });

    test("hung IndexedDB storage rejects flush within timeout and clears queue tail so subsequent flushes recover", async () => {
        let hang = true;
        const backing = makeMemoryForage({ hangSetItem: () => hang });
        (globalThis as Record<string, unknown>).window = {
            location: { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" },
        };
        installLocalForageStoreFactoryForTests(() => backing);

        useCanvasStore.setState({ projects: [makeProject("c-hang-flush", "测试画布")] });
        await expect(flushCanvasStorePersistence()).rejects.toThrow("超时");
        expect(hasActiveCanvasStorePersistence()).toBe(false);

        // Once IndexedDB recovers, the retained queue flushes cleanly without permanent deadlock.
        hang = false;
        await expect(flushCanvasStorePersistence()).resolves.toBeUndefined();
        expect(hasActiveCanvasStorePersistence()).toBe(false);
    });

    test("hung journal write during backend save transitions sync progress out of saving into error and recovers on retry", async () => {
        let hangJournalWrite = true;
        const backing = makeMemoryForage({ hangSetItem: () => hangJournalWrite });
        (globalThis as Record<string, unknown>).window = {
            location: { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" },
        };
        installLocalForageStoreFactoryForTests(() => backing);
        apiClient.defaults.adapter = async (config: InternalAxiosRequestConfig) => ({
            data: {
                code: 0,
                data: {
                    op: "canvas.document.commit",
                    opId: "op-1",
                    replayed: false,
                    caller: "manual",
                    revision: 2,
                    result: {
                        canvasId: "c-stuck-save",
                        title: "正常保存",
                        revision: 2,
                        updatedAt: "2026-04-06T00:01:00.000Z",
                    },
                },
                msg: "ok",
            },
            status: 200,
            statusText: "OK",
            headers: {},
            config,
        });

        useCanvasStore.setState({ projects: [makeProject("c-stuck-save", "正常保存", 1)] });

        const firstSave = syncLocalCanvasProjectToBackend("c-stuck-save");
        expect(projectSyncProgress("c-stuck-save")?.phase).toBe("saving");
        await expect(firstSave).rejects.toThrow("画布提交日记写入超时");
        // Must leave "saving" so project cards never stay stuck on "本地保存中 · 正在写入本地结构...".
        expect(projectSyncProgress("c-stuck-save")?.phase).toBe("error");

        // Projection lock & save tail must be released so the next save succeeds cleanly.
        hangJournalWrite = false;
        await expect(syncLocalCanvasProjectToBackend("c-stuck-save")).resolves.toBeUndefined();
        expect(projectSyncProgress("c-stuck-save")?.phase).toBe("done");
    });
});
