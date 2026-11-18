import { hasBuiltinChannelProfileUpgrade, subscribeBuiltinPresets, syncBuiltinPresetFromModule } from "@/lib/builtin-service-presets";
import { createBeefTVPluginHost } from "@/lib/plugins/plugin-host-runtime";
import { getRegisteredPlugin, listRegisteredPlugins } from "@/lib/plugins/plugin-registry";
import type { BeefTVPluginHost, PluginManifest, PluginManifestV2 } from "@/lib/plugins/plugin-types";
import { disposePluginContributions } from "@/lib/plugins/slot-registry";
import { localWorkspaceConfig } from "@/lib/user-session";
import { reportPluginLoadError, type BackendPlugin } from "@/services/api/plugins";
import { getCanonicalModelConfig, mutateModelConfig } from "@/services/model-config-repository";
import { useConfigStore } from "@/stores/use-config-store";
import {
    isPluginEffectivelyEnabled,
    onPluginStoreLifecycleChange,
    usePluginStore,
} from "@/stores/use-plugin-store";

export type ClientPluginModule = {
    activate?: (host: BeefTVPluginHost) => Promise<(() => void) | void> | (() => void) | void;
    deactivate?: () => Promise<void> | void;
    default?:
        | ((host: BeefTVPluginHost) => Promise<(() => void) | void> | (() => void) | void)
        | {
              activate?: (host: BeefTVPluginHost) => Promise<(() => void) | void> | (() => void) | void;
              deactivate?: () => Promise<void> | void;
          };
};

const activeCleanups = new Map<string, () => void>();
const activatingPromises = new Map<string, Promise<boolean>>();
/** 每个已激活插件加载的入口地址；从文件夹重新安装后地址变了，就要换成新代码。 */
const loadedEntries = new Map<string, string>();

/** 地址使用内容指纹路径段隔离，使入口内部相对静态导入（如 ./presets.js）自动继承当前版本路径，不会命中浏览器旧模块缓存。 */
export function clientEntryFor(pluginId: string, manifest?: PluginManifest | PluginManifestV2): string | undefined {
    const cleanClient = manifest?.client ? manifest.client.replace(/^\.\//, "").replace(/^\/+/, "") : "";
    if (!cleanClient) return undefined;
    const revision = (manifest?.revision || manifest?.version || "").trim();
    if (/^[0-9a-f]{64}$/i.test(revision)) {
        return `/api/plugins/${encodeURIComponent(pluginId)}/files/@rev-${revision.toLowerCase()}/${cleanClient}`;
    }
    return `/api/plugins/${encodeURIComponent(pluginId)}/files/${cleanClient}?v=${encodeURIComponent(revision)}`;
}

function resolveModuleActivator(
    mod: ClientPluginModule,
): ((host: BeefTVPluginHost) => Promise<(() => void) | void> | (() => void) | void) | null {
    if (typeof mod.activate === "function") return mod.activate;
    if (typeof mod.default === "function") return mod.default;
    if (mod.default && typeof mod.default === "object" && typeof mod.default.activate === "function") {
        return mod.default.activate;
    }
    return null;
}

function resolveModuleDeactivator(mod: ClientPluginModule): (() => Promise<void> | void) | null {
    if (typeof mod.deactivate === "function") return mod.deactivate;
    if (mod.default && typeof mod.default === "object" && typeof mod.default.deactivate === "function") {
        return mod.default.deactivate;
    }
    return null;
}

// 只用来发现永远不返回的插件；加载本身是异步的，不会挡住应用。计时从 import() 开始，
// 页面忙着渲染时计时器照走，太短会把正常的插件记成异常。
const CLIENT_ENTRY_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, pluginId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`插件 "${pluginId}" 客户端入口激活超时（>${timeoutMs}ms）`));
        }, timeoutMs);
        promise.then(
            (val) => {
                clearTimeout(timer);
                resolve(val);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

export function reconcileLocalChannelsAfterPresetSync(): void {
    const configStore = useConfigStore.getState();
    if (!hasBuiltinChannelProfileUpgrade(configStore.config?.channels)) {
        return;
    }
    const nextLocal = localWorkspaceConfig(configStore.config);
    configStore.replaceConfig(nextLocal);
    if (getCanonicalModelConfig() !== null) {
        void mutateModelConfig((base) => {
            const migrated = localWorkspaceConfig(base);
            return { config: migrated, result: true };
        })
            .then(({ config }) => useConfigStore.getState().replaceConfig(localWorkspaceConfig(config)))
            .catch(() => undefined);
    }
}

// 无论合作伙伴模块是在激活当下同步，还是等后端权威目录到达后延迟重放，只要内置预设变化就自动升级已存渠道档案。
subscribeBuiltinPresets(reconcileLocalChannelsAfterPresetSync);

export function recoverIfRevisionChanged(
    pluginId: string,
    previousManifest: PluginManifest | PluginManifestV2 | undefined,
    latest?: BackendPlugin,
): void {
    if (
        !latest ||
        latest.status !== "enabled" ||
        !latest.manifest?.revision ||
        latest.manifest.revision === previousManifest?.revision
    ) {
        return;
    }
    const store = usePluginStore.getState();
    store.setError(pluginId, undefined);
    store.setRuntimeStatuses({
        ...store.runtimeStatuses,
        [pluginId]: "enabled",
    });
    store.ensurePlugin(latest.manifest);
}

export async function activateClientPluginModule(
    pluginId: string,
    mod: ClientPluginModule,
    options?: {
        manifest?: PluginManifest | PluginManifestV2;
        timeoutMs?: number;
        reportBackendError?: boolean;
    },
): Promise<boolean> {
    if (activeCleanups.has(pluginId)) {
        deactivateClientPlugin(pluginId);
    }

    const timeoutMs = options?.timeoutMs ?? CLIENT_ENTRY_TIMEOUT_MS;
    const host = createBeefTVPluginHost(pluginId, options?.manifest);
    const activator = resolveModuleActivator(mod);
    const deactivator = resolveModuleDeactivator(mod);

    if (!activator) {
        return false;
    }

    try {
        const maybeDisposer = await withTimeout(
            Promise.resolve().then(() => activator(host)),
            timeoutMs,
            pluginId,
        );
        if (options?.manifest?.trusted !== false) {
            syncBuiltinPresetFromModule(pluginId, mod);
        }

        activeCleanups.set(pluginId, () => {
            try {
                if (typeof maybeDisposer === "function") {
                    maybeDisposer();
                } else if (deactivator) {
                    void deactivator();
                }
            } catch (err) {
                console.warn(`[plugin-client-loader] Error during cleanup of "${pluginId}":`, err);
            } finally {
                disposePluginContributions(pluginId);
            }
        });
        usePluginStore.getState().setError(pluginId, undefined);
        return true;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        disposePluginContributions(pluginId);
        activeCleanups.delete(pluginId);
        usePluginStore.getState().setError(pluginId, message);
        const state = usePluginStore.getState();
        state.setRuntimeStatuses({
            ...state.runtimeStatuses,
            [pluginId]: "invalid",
        });
        if (options?.reportBackendError !== false) {
            void reportPluginLoadError(pluginId, message, "activate", options?.manifest?.revision)
                .then((res) => recoverIfRevisionChanged(pluginId, options?.manifest, res?.plugin))
                .catch(() => {
                    // ignore network error in offline/test environments
                });
        }
        return false;
    }
}

export async function loadAndActivateClientPlugin(
    pluginId: string,
    options?: {
        manifest?: PluginManifest | PluginManifestV2;
        timeoutMs?: number;
    },
): Promise<boolean> {
    if (activeCleanups.has(pluginId)) return true;
    const existingPromise = activatingPromises.get(pluginId);
    if (existingPromise) return existingPromise;

    const run = (async () => {
        const registered = getRegisteredPlugin(pluginId);
        const manifest = options?.manifest ?? registered?.manifest;

        if (registered?.setup) {
            return activateClientPluginModule(
                pluginId,
                { activate: registered.setup },
                { manifest, timeoutMs: options?.timeoutMs, reportBackendError: false },
            );
        }

        const clientEntry = clientEntryFor(pluginId, manifest);
        if (!clientEntry) {
            return false;
        }

        try {
            const timeoutMs = options?.timeoutMs ?? CLIENT_ENTRY_TIMEOUT_MS;
            const mod = await withTimeout(
                import(/* @vite-ignore */ clientEntry) as Promise<ClientPluginModule>,
                timeoutMs,
                pluginId,
            );
            const activated = await activateClientPluginModule(pluginId, mod, {
                manifest,
                timeoutMs,
                reportBackendError: true,
            });
            if (activated) loadedEntries.set(pluginId, clientEntry);
            return activated;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            disposePluginContributions(pluginId);
            usePluginStore.getState().setError(pluginId, message);
            const state = usePluginStore.getState();
            state.setRuntimeStatuses({
                ...state.runtimeStatuses,
                [pluginId]: "invalid",
            });
            void reportPluginLoadError(pluginId, message, "import", manifest?.revision)
                .then((res) => recoverIfRevisionChanged(pluginId, manifest, res?.plugin))
                .catch(() => {});
            return false;
        }
    })();

    activatingPromises.set(pluginId, run);
    try {
        return await run;
    } finally {
        activatingPromises.delete(pluginId);
    }
}

export function deactivateClientPlugin(pluginId: string): void {
    const cleanup = activeCleanups.get(pluginId);
    activeCleanups.delete(pluginId);
    loadedEntries.delete(pluginId);
    if (cleanup) {
        cleanup();
    } else {
        disposePluginContributions(pluginId);
    }
}

export function deactivateAllClientPlugins(): void {
    for (const pluginId of Array.from(activeCleanups.keys())) {
        deactivateClientPlugin(pluginId);
    }
}

export function isClientPluginActive(pluginId: string): boolean {
    return activeCleanups.has(pluginId);
}

export function activateRegisteredSetupSync(pluginId: string): boolean {
    if (activeCleanups.has(pluginId)) return true;
    const registered = getRegisteredPlugin(pluginId);
    if (!registered?.setup) return false;
    const host = createBeefTVPluginHost(pluginId, registered.manifest);
    try {
        const result = registered.setup(host);
        if (result && typeof (result as Promise<unknown>).then === "function") {
            void (result as Promise<(() => void) | void>).then(
                (disposer) => {
                    activeCleanups.set(pluginId, () => {
                        try {
                            if (typeof disposer === "function") disposer();
                        } finally {
                            disposePluginContributions(pluginId);
                        }
                    });
                },
                (err) => {
                    const message = err instanceof Error ? err.message : String(err);
                    disposePluginContributions(pluginId);
                    activeCleanups.delete(pluginId);
                    usePluginStore.getState().setError(pluginId, message);
                },
            );
            activeCleanups.set(pluginId, () => {
                disposePluginContributions(pluginId);
            });
            return true;
        }
        activeCleanups.set(pluginId, () => {
            try {
                if (typeof result === "function") result();
            } catch (err) {
                console.warn(`[plugin-client-loader] Error during cleanup of "${pluginId}":`, err);
            } finally {
                disposePluginContributions(pluginId);
            }
        });
        usePluginStore.getState().setError(pluginId, undefined);
        return true;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        disposePluginContributions(pluginId);
        activeCleanups.delete(pluginId);
        usePluginStore.getState().setError(pluginId, message);
        return false;
    }
}

export function syncActiveClientPlugins(changedPluginId?: string): void {
    const storeState = usePluginStore.getState();
    const installationsById = new Map(storeState.installations.map((inst) => [inst.manifest.id, inst]));

    if (changedPluginId) {
        const inst = installationsById.get(changedPluginId);
        const localEnabled = inst ? inst.enabled : false;
        if (!isPluginEffectivelyEnabled(changedPluginId, localEnabled)) {
            if (activeCleanups.has(changedPluginId)) {
                deactivateClientPlugin(changedPluginId);
            } else {
                disposePluginContributions(changedPluginId);
            }
        }
    }

    const registeredById = new Map(listRegisteredPlugins().map((plugin) => [plugin.manifest.id, plugin]));
    const allIds = new Set<string>([
        ...registeredById.keys(),
        ...installationsById.keys(),
    ]);

    for (const pluginId of allIds) {
        const plugin = registeredById.get(pluginId);
        const inst = installationsById.get(pluginId);
        const manifest = plugin?.manifest ?? inst?.manifest;
        const localEnabled = inst ? inst.enabled : false;
        const effective = isPluginEffectivelyEnabled(pluginId, localEnabled);

        if (effective) {
            const loadedEntry = loadedEntries.get(pluginId);
            if (loadedEntry && !plugin?.setup && loadedEntry !== clientEntryFor(pluginId, manifest)) {
                deactivateClientPlugin(pluginId);
            }
            if (!activeCleanups.has(pluginId)) {
                if (plugin?.setup) {
                    activateRegisteredSetupSync(pluginId);
                } else if (manifest?.client) {
                    void loadAndActivateClientPlugin(pluginId, { manifest });
                }
            }
        } else {
            if (activeCleanups.has(pluginId)) {
                deactivateClientPlugin(pluginId);
            } else {
                disposePluginContributions(pluginId);
            }
        }
    }
}

onPluginStoreLifecycleChange((changedPluginId) => {
    syncActiveClientPlugins(changedPluginId);
});
