import * as React from "react";
import {
    appHref,
    appPathname,
    defaultAppRoutingRuntime,
    usesNativeHashRouting,
    type AppRoutingRuntime,
} from "@/lib/app-routing";
import { emitPluginEvent, onPluginEvent } from "@/lib/plugins/plugin-events";
import { getRegisteredPlugin } from "@/lib/plugins/plugin-registry";
import { pluginStorageFor } from "@/lib/plugins/plugin-storage";
import {
    PLUGIN_API_VERSION,
    type BeefTVPluginHost,
    type PluginInstallConfirmRequest,
    type PluginManifest,
    type PluginManifestV2,
} from "@/lib/plugins/plugin-types";
import { createHostCapabilities } from "@/lib/plugins/plugin-host-capabilities";
import { assertPluginOpPermission, READ_ONLY_PLUGIN_OPS, resolvePluginPermissions } from "@/lib/plugins/plugin-permissions";
import { contributeSlot } from "@/lib/plugins/slot-registry";
import { localWorkspaceConfig } from "@/lib/user-session";
import { executeWorkspaceOperation } from "@/services/api/operations";
import { http } from "@/services/api/request";
import { getCanonicalModelConfig, mutateModelConfig } from "@/services/model-config-repository";
import { createModelChannel, normalizeConfigSnapshot, useConfigStore, type ModelChannel } from "@/stores/use-config-store";
import { usePluginStore } from "@/stores/use-plugin-store";

/** The host install confirmation listens for this event; plugins never install directly. */
export const PLUGIN_INSTALL_REQUEST_EVENT = "beeftv:plugin-install-request";

export function requestPluginInstall(request: PluginInstallConfirmRequest): void {
    const source = typeof request?.source === "string" ? request.source.trim() : "";
    if (!source || typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent<PluginInstallConfirmRequest>(PLUGIN_INSTALL_REQUEST_EVENT, { detail: { ...request, source } }));
}

let customNavigator: ((path: string) => void) | null = null;

export function setPluginHostNavigator(fn: ((path: string) => void) | null): void {
    customNavigator = fn;
}

export function navigatePluginHost(path: string, runtime?: AppRoutingRuntime): void {
    const clean = String(path || "").trim() || "/";
    const appPath = clean.startsWith("/") ? clean : `/${clean}`;
    if (!runtime && customNavigator) {
        customNavigator(appPath);
        return;
    }
    const resolvedRuntime = runtime ?? defaultAppRoutingRuntime();
    const nextHref = appHref(appPath, resolvedRuntime);
    if (usesNativeHashRouting(resolvedRuntime)) {
        const hashTarget = `#${appPath}`;
        if (runtime) {
            resolvedRuntime.history?.replaceState(null, "", nextHref);
            resolvedRuntime.location.hash = hashTarget;
            return;
        }
        if (typeof window === "undefined") return;
        window.location.hash = hashTarget;
        return;
    }
    const parsed = new URL(nextHref);
    const historyTarget = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (runtime) {
        resolvedRuntime.history?.replaceState(null, "", historyTarget);
        resolvedRuntime.location.pathname = parsed.pathname;
        resolvedRuntime.location.search = parsed.search;
        return;
    }
    if (typeof window === "undefined") return;
    window.history.pushState({}, "", historyTarget);
    window.dispatchEvent(new PopStateEvent("popstate"));
}

/** The open canvas is the one in the route; the canvas store keeps every loaded canvas. */
export function currentCanvasId(runtime?: AppRoutingRuntime): string | undefined {
    if (!runtime && typeof window === "undefined") return undefined;
    const pathname = appPathname(runtime ?? defaultAppRoutingRuntime());
    const match = /^\/canvas\/([^/]+)/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : undefined;
}

const CORE_RESERVED_CHANNEL_IDS = ["beeftv", "default", "fal-topaz-upscale"] as const;

function reservedHostChannelIds(channels: readonly ModelChannel[], extraPresetIds: readonly string[] = []): Set<string> {
    const reserved = new Set<string>(CORE_RESERVED_CHANNEL_IDS);
    for (const id of extraPresetIds) {
        if (id) reserved.add(id);
    }
    for (const channel of channels) {
        if (channel.scope === "system" || channel.pinned || Boolean(channel.credentialRef)) {
            if (channel.id) reserved.add(channel.id);
            for (const legacyId of channel.legacyIds ?? []) {
                if (legacyId) reserved.add(legacyId);
            }
        }
    }
    return reserved;
}

function isPluginNamespaceChannelId(pluginId: string, targetId: string): boolean {
    if (!targetId || targetId === "beeftv") return false;
    const allowedPrefix = pluginId.replace(/^beeftv-plugin-/, "");
    return (
        targetId === pluginId ||
        targetId === allowedPrefix ||
        targetId === `${allowedPrefix}-channel` ||
        targetId.startsWith(`${pluginId}:`)
    );
}

function redactChannelForPlugin(item: ModelChannel): Record<string, unknown> {
    return {
        ...item,
        apiKey: "",
        secretKey: "",
        headers: undefined,
        hasApiKey: Boolean(item.apiKey || item.hasApiKey),
        hasSecretKey: Boolean(item.secretKey || item.hasSecretKey),
    } as unknown as Record<string, unknown>;
}

function parseHttpOrigin(raw: string): string | null {
    const clean = raw.trim();
    if (!/^https?:\/\//i.test(clean)) return null;
    try {
        const parsed = new URL(clean.endsWith("#") ? clean.slice(0, -1) : clean);
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return null;
        return parsed.origin;
    } catch {
        return null;
    }
}

function sameHttpOrigin(a: string, b: string): boolean {
    const left = parseHttpOrigin(a);
    return Boolean(left) && left === parseHttpOrigin(b);
}

function defaultManifestFor(pluginId: string): PluginManifest | PluginManifestV2 {
    const registered = getRegisteredPlugin(pluginId);
    if (registered) return registered.manifest;
    const installed = usePluginStore.getState().installations.find((item) => item.manifest.id === pluginId);
    if (installed) return installed.manifest;
    return { apiVersion: PLUGIN_API_VERSION, id: pluginId, name: pluginId, version: "", description: "", permissions: [], contributes: {} };
}

export function createBeefTVPluginHost(pluginId: string, manifest?: PluginManifest | PluginManifestV2): BeefTVPluginHost {
    const notify = (msg: string, level: "info" | "success" | "warning" | "error" = "info") => {
        void import("antd").then(({ message }) => message[level](msg));
    };
    const installation = () => usePluginStore.getState().installations.find((item) => item.manifest.id === pluginId);
    const resolvedManifest = manifest ?? defaultManifestFor(pluginId);
    const perms = new Set<string>(Array.isArray(resolvedManifest.permissions) ? resolvedManifest.permissions : []);
    const { canWriteSettings } = resolvePluginPermissions(perms);
    const isTrusted = Boolean(resolvedManifest.trusted);
    const capabilities = createHostCapabilities(pluginId, perms, notify);

    return {
        pluginId,
        manifest: resolvedManifest,
        React,
        ReactDOM: capabilities.ReactDOM,
        ai: capabilities.ai,
        api: capabilities.api,
        media: capabilities.media,
        utils: capabilities.utils,
        contribute: (slot, payload) => contributeSlot(pluginId, slot, payload),
        events: {
            on: (event, handler) => onPluginEvent(pluginId, event, handler),
            emit: (event, payload) => emitPluginEvent(event, payload),
        },
        storage: pluginStorageFor(pluginId),
        config: {
            getAll: () => installation()?.config ?? {},
            get: <T extends string | number | boolean = string>(key: string, fallback?: T): T | undefined => {
                const value = installation()?.config?.[key];
                return value !== undefined ? (value as T) : fallback;
            },
            set: async (patch) => {
                await usePluginStore.getState().updateConfig(pluginId, patch);
            },
        },
        ui: {
            notify,
            navigate: navigatePluginHost,
            requestInstallPlugin: requestPluginInstall,
        },
        ops: {
            call: async <T = unknown>(op: string, params?: Record<string, unknown>) => {
                assertPluginOpPermission(pluginId, perms, op);
                const rawParams = { ...(params ?? {}) };
                const explicitOpId = typeof rawParams.opId === "string" ? rawParams.opId.trim() : "";
                if ("opId" in rawParams) delete rawParams.opId;
                const isReadOnly = READ_ONLY_PLUGIN_OPS.has(op);
                const opId = isReadOnly
                    ? undefined
                    : explicitOpId ||
                      (typeof rawParams.operationId === "string" && rawParams.operationId.trim()
                          ? undefined
                          : `plugin-${pluginId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
                const targetCanvasId = typeof rawParams.canvasId === "string" ? rawParams.canvasId.trim() : "";
                let result: T;
                try {
                    const res = await executeWorkspaceOperation<T>(op, { ...(opId ? { opId } : {}), params: rawParams });
                    result = res.result;
                } catch (err) {
                    const isInitialCommit =
                        op === "canvas.document.commit" &&
                        rawParams.expectedRevision === 0 &&
                        Boolean(targetCanvasId) &&
                        Boolean(rawParams.document && typeof rawParams.document === "object");
                    const isNotFound =
                        (typeof (err as { status?: number })?.status === "number" && (err as { status: number }).status === 404) ||
                        String((err as Error)?.message || "").includes("画布不存在");
                    if (!isInitialCommit || !isNotFound) throw err;
                    const created = await http.put<{
                        project?: { id?: string; revision?: number; title?: string; updatedAt?: string };
                    }>(`/canvas-projects/${encodeURIComponent(targetCanvasId)}`, {
                        project: rawParams.document,
                    });
                    const docObj = rawParams.document as { title?: string; updatedAt?: string };
                    result = {
                        canvasId: created?.project?.id || targetCanvasId,
                        revision: created?.project?.revision ?? 1,
                        title: created?.project?.title ?? docObj.title ?? "",
                        updatedAt: created?.project?.updatedAt ?? docObj.updatedAt ?? new Date().toISOString(),
                    } as unknown as T;
                }
                if (!isReadOnly && targetCanvasId) {
                    void import("@/services/local-workspace-repository").then(({ refreshLocalCanvasProjectIfChanged }) =>
                        refreshLocalCanvasProjectIfChanged(targetCanvasId),
                    );
                }
                return result;
            },
        },
        context: {
            getCanvasId: () => currentCanvasId(),
        },
        assets: capabilities.assets,
        channels: {
            list: () => {
                if (!canWriteSettings) {
                    throw new Error(`插件 ${pluginId} 缺少 settings.write 权限，无法读取模型渠道列表`);
                }
                const canonical = getCanonicalModelConfig();
                const sourceConfig = canonical ?? useConfigStore.getState().config;
                const allChannels = sourceConfig.channels ?? [];
                const reserved = isTrusted ? null : reservedHostChannelIds(allChannels);
                const visible = isTrusted
                    ? allChannels
                    : allChannels.filter(
                          (item) =>
                              item.ownerPluginId === pluginId &&
                              isPluginNamespaceChannelId(pluginId, item.id) &&
                              !reserved?.has(item.id),
                      );
                return visible.map(redactChannelForPlugin);
            },
            upsert: async (rawChannel) => {
                if (!canWriteSettings) {
                    throw new Error(`插件 ${pluginId} 缺少 settings.write 权限，无法修改模型渠道`);
                }
                const incoming = rawChannel as unknown as Partial<ModelChannel>;
                const targetId = String(incoming.id || "").trim();
                const allowedPrefix = pluginId.replace(/^beeftv-plugin-/, "");
                if (!isPluginNamespaceChannelId(pluginId, targetId)) {
                    throw new Error(`插件 ${pluginId} 仅允许写入自身命名空间下的模型渠道`);
                }
                const baseUrl = String(incoming.baseUrl || "").trim();
                if (!parseHttpOrigin(baseUrl)) {
                    throw new Error("渠道接口地址必须以 http:// 或 https:// 开头");
                }
                const [{ BUILTIN_PRESETS }, { MODEL_SERVICE_PRESETS, servicePresetFor }, { withChannels }] = await Promise.all([
                    import("@/lib/builtin-service-presets"),
                    import("@/lib/model-service-presets"),
                    import("@/pages/settings/channel-settings-pane"),
                ]);
                const presetIds = [
                    ...MODEL_SERVICE_PRESETS.map((item) => item.id),
                    ...Object.keys(BUILTIN_PRESETS),
                ];
                const { config: savedConfig, result: savedChannel } = await mutateModelConfig((base) => {
                    const latest = normalizeConfigSnapshot({ config: base }).config;
                    const reserved = reservedHostChannelIds(latest.channels, presetIds);
                    if (!isTrusted && reserved.has(targetId)) {
                        throw new Error(`插件 ${pluginId} 仅允许写入自身命名空间下的模型渠道`);
                    }
                    const existing = latest.channels.find((item) => item.id === targetId)
                        || (isTrusted && allowedPrefix !== "compatible"
                            ? latest.channels.find((item) => item.scope !== "system" && !item.pinned && !item.credentialRef && servicePresetFor(item) === allowedPrefix)
                            : undefined);
                    if (existing?.scope === "system" || existing?.pinned || existing?.credentialRef) {
                        throw new Error("不允许覆盖系统内置或受管凭证渠道");
                    }
                    const sameOrigin = Boolean(existing?.baseUrl) && sameHttpOrigin(baseUrl, existing!.baseUrl);
                    const incomingApiKey = typeof incoming.apiKey === "string" ? incoming.apiKey.trim() : "";
                    if (existing && !isTrusted && existing.ownerPluginId !== pluginId) {
                        // Allow seamless v2.2.x upgrade migration only when an ownerless legacy channel
                        // matches the plugin's namespace ID, shares the exact same gateway origin, and
                        // the user explicitly supplies a non-empty API key.
                        const canClaimLegacyPluginChannel = !existing.ownerPluginId && sameOrigin && Boolean(incomingApiKey);
                        if (!canClaimLegacyPluginChannel) {
                            throw new Error("不允许覆盖非本插件创建的已有模型渠道");
                        }
                    }
                    const effectiveId = existing?.id || targetId;
                    const nextApiKey = incomingApiKey || (sameOrigin ? (existing?.apiKey ?? "") : "");
                    const incomingSecretKey = typeof incoming.secretKey === "string" ? incoming.secretKey.trim() : "";
                    const nextSecretKey = incomingSecretKey || (sameOrigin ? (existing?.secretKey ?? "") : "");
                    const nextHeaders = Array.isArray(incoming.headers)
                        ? incoming.headers
                            .filter((h): h is { name: string; value: string } => Boolean(h && typeof h === "object" && typeof h.name === "string" && h.name.trim()))
                            .map((h) => ({ name: h.name.trim(), value: typeof h.value === "string" ? h.value : "" }))
                        : (sameOrigin ? (existing?.headers ?? []) : []);
                    const seed = existing ?? createModelChannel({
                        id: effectiveId,
                        name: String(incoming.name || targetId).trim(),
                        baseUrl,
                    });
                    const channel: ModelChannel = {
                        ...seed,
                        id: effectiveId,
                        name: String(incoming.name || existing?.name || targetId).trim(),
                        baseUrl,
                        ...(typeof incoming.referenceAssetOrigin === "string"
                            ? { referenceAssetOrigin: incoming.referenceAssetOrigin.trim() || undefined }
                            : {}),
                        apiKey: nextApiKey,
                        hasApiKey: Boolean(nextApiKey || (sameOrigin && existing?.hasApiKey)),
                        secretKey: nextSecretKey,
                        hasSecretKey: Boolean(nextSecretKey || (sameOrigin && existing?.hasSecretKey)),
                        headers: nextHeaders,
                        apiFormat: incoming.apiFormat || existing?.apiFormat || "openai",
                        interfaceType: incoming.interfaceType || existing?.interfaceType,
                        concurrencyLimit: typeof incoming.concurrencyLimit === "number" ? incoming.concurrencyLimit : existing?.concurrencyLimit,
                        enabled: typeof incoming.enabled === "boolean" ? incoming.enabled : (existing?.enabled ?? true),
                        pinned: false,
                        scope: "user",
                        credentialRef: undefined,
                        ownerPluginId: isTrusted ? existing?.ownerPluginId : pluginId,
                        models: Array.isArray(incoming.models) ? incoming.models.filter((m): m is string => typeof m === "string" && Boolean(m.trim())) : (existing?.models ?? []),
                        modelProfiles: Array.isArray(incoming.modelProfiles) ? incoming.modelProfiles : existing?.modelProfiles,
                    };
                    const nextChannels = existing
                        ? latest.channels.map((item) => (item.id === existing.id ? channel : item))
                        : [...latest.channels, channel];
                    const nextConfig = withChannels(latest, nextChannels);
                    return { config: nextConfig, result: channel };
                });
                useConfigStore.getState().replaceConfig(localWorkspaceConfig(savedConfig));
                return redactChannelForPlugin(savedChannel);
            },
            fetchCatalog: async (params) => {
                if (!canWriteSettings) {
                    throw new Error(`插件 ${pluginId} 缺少 settings.write 权限，无法探测模型目录`);
                }
                const baseUrl = String(params.baseUrl || "").trim();
                if (!parseHttpOrigin(baseUrl)) {
                    throw new Error("渠道接口地址必须以 http:// 或 https:// 开头");
                }
                const res = await http.post<{ models?: Array<string | { id?: string }> }>("/ai/models", {
                    baseUrl,
                    apiKey: String(params.apiKey || "").trim(),
                    apiFormat: params.apiFormat || "openai",
                });
                const rawModels = Array.isArray(res?.models) ? res.models : [];
                const models = rawModels
                    .map((item) => (typeof item === "string" ? item : item?.id || ""))
                    .filter(Boolean);
                return { models };
            },
        },
    };
}
