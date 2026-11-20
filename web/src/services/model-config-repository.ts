import { getLocalModelConfig, saveLocalModelConfig, type LocalModelConfigPayload } from "@/services/api/workspace";
import type { AiConfig } from "@/stores/use-config-store";

export type ModelConfigPersistenceState = {
    status: "idle" | "hydrating" | "saving" | "saved" | "error";
    revision: number;
    dirty: boolean;
    error: string;
};

type ModelConfigRepositoryDependencies = {
    read: () => Promise<LocalModelConfigPayload>;
    write: (config: AiConfig, expectedRevision: number) => Promise<{ saved: boolean; revision: number }>;
};

type PendingMutation<T = unknown> = {
    mutator: (base: AiConfig) => { config: AiConfig; result: T };
    resolve: (value: { config: AiConfig; result: T }) => void;
    reject: (error: Error) => void;
};

export function createModelConfigRepository(dependencies: ModelConfigRepositoryDependencies) {
    let state: ModelConfigPersistenceState = { status: "idle", revision: 0, dirty: false, error: "" };
    let canonicalReady = false;
    let hasFailedHydration = false;
    let canonicalConfig: AiConfig | null = null;
    let pendingReplace: AiConfig | null = null;
    const pendingMutations: PendingMutation[] = [];
    let generation = 0;
    let draining = false;
    let drainPromise: Promise<void> | null = null;
    let inFlightHydration: Promise<void> | null = null;
    let resolveHydrationWaiters: (() => void) | null = null;
    let hydrationWait = new Promise<void>((resolve) => {
        resolveHydrationWaiters = resolve;
    });
    const listeners = new Set<(next: ModelConfigPersistenceState) => void>();

    const hasPendingWork = () => pendingReplace !== null || pendingMutations.length > 0;

    const publish = (patch: Partial<ModelConfigPersistenceState>) => {
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener(state));
    };

    const wakeHydrationWaiters = (resetCycle: boolean) => {
        const wake = resolveHydrationWaiters;
        if (resetCycle) {
            hydrationWait = new Promise<void>((resolve) => {
                resolveHydrationWaiters = resolve;
            });
        } else {
            resolveHydrationWaiters = null;
        }
        wake?.();
    };

    const hydrate = async (): Promise<LocalModelConfigPayload & { supersededByLocalEdit: boolean }> => {
        // 先等正在进行的保存结束，读取和保存不交错改写状态。
        if (drainPromise) await drainPromise.catch(() => undefined);
        const pendingReplaceBeforeRead = pendingReplace !== null;
        const startGeneration = generation;
        let finishInFlight!: () => void;
        const currentHydration = new Promise<void>((resolve) => {
            finishInFlight = resolve;
        });
        inFlightHydration = currentHydration;
        publish({ status: "hydrating", error: "" });
        try {
            const result = await dependencies.read();
            // 全量快照 commit（刷新前保存失败的，或读取期间新改的）优先保留本地快照；
            // 纯增量 mutate 在读取期间入队尚未执行，应叠加在最新读回的 result.config 之上避免丢服务端新增渠道。
            const editedDuringRead = generation !== startGeneration;
            if (pendingReplace === null) {
                canonicalConfig = result.config;
            } else if (canonicalConfig === null) {
                canonicalConfig = result.config;
            }
            const unsaved = hasPendingWork();
            state = { status: "idle", revision: result.revision, dirty: unsaved, error: "" };
            canonicalReady = true;
            hasFailedHydration = false;
            wakeHydrationWaiters(false);
            return { ...result, supersededByLocalEdit: pendingReplaceBeforeRead || editedDuringRead };
        } catch (error) {
            const message = error instanceof Error ? error.message : "读取模型配置失败";
            canonicalReady = false;
            hasFailedHydration = true;
            if (!resolveHydrationWaiters) {
                hydrationWait = new Promise<void>((resolve) => {
                    resolveHydrationWaiters = resolve;
                });
            }
            const orphaned = pendingMutations.splice(0, pendingMutations.length);
            publish({ status: "error", dirty: hasPendingWork(), error: message });
            wakeHydrationWaiters(true);
            for (const entry of orphaned) {
                entry.reject(new Error(message));
            }
            throw error;
        } finally {
            if (inFlightHydration === currentHydration) {
                inFlightHydration = null;
            }
            finishInFlight();
            if (canonicalReady && hasPendingWork()) void scheduleDrain();
        }
    };

    const runDrain = async () => {
        const writeOnce = async (config: AiConfig, revision: number) => {
            const result = await dependencies.write(config, revision);
            if (!result.saved || !Number.isSafeInteger(result.revision) || result.revision < revision) {
                throw new Error("模型配置保存未得到确认，请重试");
            }
            return result;
        };

        while (canonicalReady && hasPendingWork()) {
            const replaceAtStart = pendingReplace;
            const mutationsAtStart = pendingMutations.slice();
            let working = replaceAtStart ?? canonicalConfig;
            if (!working) break;

            const appliedMutations: Array<{ entry: PendingMutation; result: unknown }> = [];
            let syncFailed = false;
            for (const entry of mutationsAtStart) {
                try {
                    const out = entry.mutator(working);
                    working = out.config;
                    appliedMutations.push({ entry, result: out.result });
                } catch (err) {
                    const idx = pendingMutations.indexOf(entry);
                    if (idx >= 0) pendingMutations.splice(idx, 1);
                    entry.reject(err instanceof Error ? err : new Error(String(err)));
                    syncFailed = true;
                }
            }
            if (syncFailed && !hasPendingWork()) {
                state = { ...state, dirty: false };
                draining = false;
                drainPromise = null;
                break;
            }
            if (replaceAtStart === null && appliedMutations.length === 0) {
                continue;
            }

            const savingGeneration = generation;
            publish({ status: "saving", dirty: true, error: "" });
            try {
                const res = await writeOnce(working, state.revision);
                const replaceChangedDuringWrite = pendingReplace !== replaceAtStart && pendingReplace !== null;
                if (replaceChangedDuringWrite) {
                    // A full-snapshot commit arrived while appliedMutations were in-flight (its snapshot
                    // predates appliedMutations resolving). Advance revision and re-apply appliedMutations
                    // on top of the new pendingReplace in the next loop iteration so neither side is lost.
                    state = { status: "saving", revision: res.revision, dirty: true, error: "" };
                    canonicalConfig = working;
                    continue;
                }
                if (pendingReplace === replaceAtStart) {
                    pendingReplace = null;
                }
                for (const { entry } of appliedMutations) {
                    const idx = pendingMutations.indexOf(entry);
                    if (idx >= 0) pendingMutations.splice(idx, 1);
                }
                canonicalConfig = working;
                const moreWork = hasPendingWork();
                const stillDirty = generation !== savingGeneration || moreWork;
                state = { status: "saved", revision: res.revision, dirty: stillDirty, error: "" };
                if (!moreWork) {
                    draining = false;
                    drainPromise = null;
                }
                for (const { entry, result } of appliedMutations) {
                    entry.resolve({ config: working, result });
                }
            } catch (err) {
                if (isRevisionConflict(err)) {
                    try {
                        const current = await dependencies.read();
                        state = { ...state, revision: current.revision, status: "saving", dirty: true, error: "" };
                        if (pendingReplace === null) {
                            canonicalConfig = current.config;
                        }
                        continue;
                    } catch (retryError) {
                        err = retryError;
                    }
                }
                const message = err instanceof Error ? err.message : "保存模型配置失败";
                const toReject = pendingMutations.splice(0, pendingMutations.length);
                const keepDirty = hasPendingWork();
                draining = false;
                drainPromise = null;
                publish({ status: "error", dirty: keepDirty, error: message });
                for (const entry of toReject) {
                    entry.reject(new Error(message));
                }
                return;
            }
        }
        draining = false;
        drainPromise = null;
        listeners.forEach((listener) => listener(state));
    };

    const scheduleDrain = (): Promise<void> => {
        if (!canonicalReady) return hydrationWait.then(scheduleDrain);
        if (inFlightHydration) return inFlightHydration.then(scheduleDrain);
        if (!draining) {
            draining = true;
            const current = runDrain().finally(() => {
                if (drainPromise === current) {
                    draining = false;
                    drainPromise = null;
                }
                if (canonicalReady && !inFlightHydration && pendingMutations.length > 0) {
                    void scheduleDrain();
                }
            });
            if (draining) {
                drainPromise = current;
            }
            return current;
        }
        return drainPromise ?? Promise.resolve();
    };

    const commit = (config: AiConfig) => {
        pendingReplace = config;
        canonicalConfig = config;
        generation += 1;
        publish({ dirty: true });
        return scheduleDrain();
    };

    const mutate = async <T>(
        mutator: (base: AiConfig) => { config: AiConfig; result: T },
    ): Promise<{ config: AiConfig; result: T }> => {
        if (!canonicalReady) {
            if (inFlightHydration) {
                await inFlightHydration;
            } else if (!hasFailedHydration) {
                await hydrationWait;
            }
        }
        if (!canonicalReady || (!canonicalConfig && !pendingReplace)) {
            throw new Error(state.error || "读取模型配置失败");
        }
        return new Promise<{ config: AiConfig; result: T }>((resolve, reject) => {
            pendingMutations.push({
                mutator: mutator as (base: AiConfig) => { config: AiConfig; result: unknown },
                resolve: resolve as (value: { config: AiConfig; result: unknown }) => void,
                reject,
            });
            generation += 1;
            publish({ dirty: true });
            void scheduleDrain();
        });
    };

    return {
        hydrate,
        commit,
        mutate,
        flush: scheduleDrain,
        getCanonicalConfig: () => (canonicalReady ? (pendingReplace ?? canonicalConfig) : null),
        getState: () => state,
        subscribe: (listener: (next: ModelConfigPersistenceState) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

function isRevisionConflict(error: unknown) {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { status?: number; response?: { status?: number } };
    return candidate.status === 409 || candidate.response?.status === 409;
}

function omitManagedBeefTVSecrets(config: AiConfig): AiConfig {
    return {
        ...config,
        channels: config.channels.map((channel) => {
            if (channel.id !== "beeftv" || !channel.pinned) return channel;
            return { ...channel, apiKey: "", secretKey: "" };
        }),
    };
}

const repository = createModelConfigRepository({
    read: getLocalModelConfig,
    write: (config, expectedRevision) => saveLocalModelConfig(omitManagedBeefTVSecrets(config), expectedRevision),
});

export const hydrateModelConfig = repository.hydrate;
export const commitModelConfig = repository.commit;
export const mutateModelConfig = repository.mutate;
export const getCanonicalModelConfig = repository.getCanonicalConfig;
export const flushModelConfig = repository.flush;
export const getModelConfigPersistenceState = repository.getState;
export const subscribeModelConfigPersistence = repository.subscribe;
