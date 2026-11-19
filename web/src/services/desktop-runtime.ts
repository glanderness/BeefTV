import { configureApiRuntime } from "@/services/api/request";
import { applySessionCanvasMemoryMode } from "@/lib/canvas/canvas-memory-policy";
import { isDesktopShellOrigin } from "@/lib/desktop-shell";
import { getEmbeddedHarnessConfig } from "@/lib/embedded-runtime";
import { purgeLegacyResourceBlobIndexedDB } from "@/lib/diagnostics-storage";
import {
    clearWorkspaceStartupFailure,
    DesktopStartupError,
    getDesktopBootSnapshot,
    recordStartupDiagnosticEvent,
    updateDesktopBootSnapshot,
    type DesktopStartupState,
} from "@/services/workspace-startup-state";

export {
    clearWorkspaceStartupFailure,
    DesktopStartupError,
    getDesktopBootSnapshot,
    normalizeWorkspaceStartupFailure,
    recordWorkspaceStartupFailure,
    resetDesktopBootSnapshot,
    subscribeDesktopBootSnapshot,
    type DesktopBootSnapshot,
    type DesktopStartupState,
    type DesktopTransportMode,
    type WorkspaceStartupFailure,
} from "@/services/workspace-startup-state";

export type DesktopRuntimeConfig = {
    baseURL: string;
    launchToken: string;
    uiBootstrapToken?: string;
};

export const DESKTOP_UPDATE_STATUSES = ["disabled", "idle", "checking", "available", "downloading", "ready", "installing", "error"] as const;

export type DesktopUpdateStatus = (typeof DESKTOP_UPDATE_STATUSES)[number];

export type DesktopUpdateState = {
    phase?: "downloading" | "verifying" | "extracting" | "preparing" | "restarting";
    completedFiles?: number;
    totalFiles?: number;
    installPrepared?: boolean;
    status: DesktopUpdateStatus;
    currentVersion: string;
    latestVersion: string;
    releaseNotes: string;
    downloadedBytes: number;
    totalBytes: number;
    bytesPerSecond: number;
    reconnecting: boolean;
    error: string;
};

export type DesktopRuntimeBinding = {
    ConsumeSkillLink?: () => Promise<string>;
    OpenPartnerKeysURL?: (partnerId: string) => Promise<void>;
    OpenSkillMarketURL?: (url: string) => Promise<void>;
    DepthComponentStatus?: (refresh: boolean) => Promise<DepthComponentState>;
    DownloadDepthComponents?: () => Promise<DepthComponentState>;
    PauseDepthComponentDownload?: () => Promise<DepthComponentState>;
    ReferenceStorageSettings?: () => Promise<ReferenceStorageConfig>;
    SaveReferenceStorage?: (config: ReferenceStorageConfig & { secretAccessKey: string }) => Promise<ReferenceStorageConfig>;
    UploadReferenceMedia?: (ids: string[]) => Promise<Record<string, string>>;
    ReferenceUploadStatus?: () => Promise<{ label: string; phase: "preparing" | "transferring" | "processing"; loadedBytes: number; totalBytes: number; bytesPerSecond: number; startedAt: number; updatedAt: number }>;
    TestReferenceStorage?: () => Promise<void>;
    StorageSettings?: () => Promise<DesktopStorageUsage>;
    ChooseStorageDirectory?: () => Promise<string>;
    MigrateStorage?: (target: string) => Promise<DesktopStorageUsage>;
    StorageMigrationStatus?: () => Promise<DesktopMigrationProgress>;
    CleanupPreviousStorage?: () => Promise<DesktopStorageUsage>;
    StartupState?: () => Promise<DesktopStartupState>;
    RetryStartup?: () => Promise<DesktopStartupState>;
    RuntimeConfig?: () => Promise<DesktopRuntimeConfig>;
    ExportRuntimeDiagnosticsToDownloads?: (clientPayload: string) => Promise<string>;
    ExportStartupDiagnostics?: (clientPayload: string) => Promise<string>;
    ReloadWindow?: (safeMode: boolean) => Promise<void>;
    SaveDiagnosticBundle?: (fileName: string, data: string) => Promise<string>;
    RevealDiagnosticBundle?: () => Promise<void>;
    SaveEagleMedia?: (fileName: string, baseURL: string, itemID: string) => Promise<boolean>;
    SaveOwnedMedia?: (fileName: string, resourceID: string) => Promise<boolean>;
    SaveOwnedArtifact?: (fileName: string, data: string) => Promise<boolean>;
    SaveOwnedArchive?: (fileName: string, entries: Array<{ name: string; resourceId?: string; data?: string }>) => Promise<boolean>;
    UpdateStatus?: () => Promise<DesktopUpdateState>;
    OpenUpdateLogDirectory?: () => Promise<void>;
    CheckForUpdate?: () => Promise<DesktopUpdateState>;
    DownloadUpdate?: () => Promise<DesktopUpdateState>;
    InstallUpdate?: () => Promise<void>;
    ConfirmUpdateStartup?: () => Promise<void>;
    OpenBeefTVX?: () => Promise<void>;
    OpenBeefTVWebsite?: () => Promise<void>;
    OpenBeefTVGitHub?: () => Promise<void>;
};

export type DesktopStorageUsage = { dataDir: string; usedBytes: number; freeBytes: number; previousDir?: string; previousBytes?: number };
export type DesktopMigrationProgress = { phase: "preparing" | "transferring" | "processing" | "done"; detail: string; loadedBytes: number; totalBytes: number; completedFiles: number; totalFiles: number };
export type DepthComponentState = {
    status: "not_installed" | "downloading" | "installing" | "ready" | "paused" | "error" | "unsupported";
    variant: string;
    dataDir: string;
    downloadBytes: number;
    requiredBytes: number;
    freeBytes: number;
    downloadedBytes: number;
    error?: string;
};
export type ReferenceStorageConfig = { enabled: boolean; endpoint: string; bucket: string; region: string; accessKeyId: string; publicBaseURL: string; hasSecret: boolean };

declare global {
    interface Window {
        runtime?: {
            BrowserOpenURL?: (url: string) => void;
            EventsOn?: (eventName: string, callback: (...data: unknown[]) => void) => () => void;
        };
        go?: {
            main?: {
                DesktopApp?: DesktopRuntimeBinding;
            };
        };
    }
}

export function getDesktopAppBinding(): DesktopRuntimeBinding | undefined {
    return typeof window !== "undefined" ? window.go?.main?.DesktopApp : undefined;
}

let wrappedFetch: typeof fetch | undefined;
let underlyingFetch: typeof fetch | undefined;
let upgradeProbeTimer: ReturnType<typeof setInterval> | null = null;
let currentDesktopApiBaseURL = "/api";
let rendererHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let rendererHeartbeatVisibilityBound = false;
let desktopEventsBound = false;
let legacyBlobPurgeTimer: ReturnType<typeof setTimeout> | null = null;
let rendererBusyCount = 0;
let pendingSafeModeAckId: number | null = null;
let reloadFlushInFlight = false;
let beforeReloadFlusher: (() => Promise<void>) | null = null;

/**
 * Registers the workspace persistence flusher invoked before a graceful
 * menu-triggered window reload. Kept as an injected hook so early desktop
 * startup never imports application stores before boot finishes.
 */
export function registerBeforeReloadFlusher(flusher: (() => Promise<void>) | null) {
    beforeReloadFlusher = flusher;
}

function sendRendererHeartbeat(extra?: { reloadAckId?: number }): Promise<void> {
    if (typeof window === "undefined" || !isDesktopShellOrigin(window.location)) return Promise.resolve();
    if (typeof globalThis.fetch !== "function") return Promise.resolve();
    const hidden = typeof document !== "undefined" ? Boolean(document.hidden) : false;
    const busy = rendererBusyCount > 0;
    const ackId = pendingSafeModeAckId ?? 0;
    const safeModeAck = ackId > 0;
    const reloadAckId = typeof extra?.reloadAckId === "number" && extra.reloadAckId > 0 ? extra.reloadAckId : 0;
    const base = String(currentDesktopApiBaseURL || "/api").replace(/\/+$/u, "");
    return globalThis.fetch(`${base}/client-runtime/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            hidden,
            busy,
            safeModeAck,
            safeModeAckId: ackId,
            reloadAckId,
        }),
        credentials: "include",
    })
        .then((res) => {
            if (safeModeAck && res.ok && pendingSafeModeAckId === ackId) {
                pendingSafeModeAckId = null;
            }
        })
        .catch(() => undefined);
}

async function flushAllWorkspacePersistenceBeforeReload() {
    if (!beforeReloadFlusher) return;
    try {
        await Promise.race([
            beforeReloadFlusher().catch(() => undefined),
            waitMs(8_000),
        ]);
    } catch {
        // Best-effort flush before reload; never block recovery.
    }
}

/**
 * Marks the renderer as performing a legitimate long-running operation
 * (e.g. large archive import/export) so the host watchdog uses its extended
 * busy timeout instead of interrupting active work.
 */
export function beginRendererBusyLease(): () => void {
    rendererBusyCount += 1;
    if (rendererBusyCount === 1) {
        sendRendererHeartbeat();
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        rendererBusyCount = Math.max(0, rendererBusyCount - 1);
        if (rendererBusyCount === 0) {
            sendRendererHeartbeat();
        }
    };
}

function ensureDesktopLifecycleHelpers() {
    if (typeof window === "undefined" || !isDesktopShellOrigin(window.location)) return;
    if (!rendererHeartbeatTimer) {
        void sendRendererHeartbeat();
        rendererHeartbeatTimer = setInterval(() => { void sendRendererHeartbeat(); }, 10_000);
        (rendererHeartbeatTimer as { unref?: () => void }).unref?.();
    }
    if (!rendererHeartbeatVisibilityBound && typeof document !== "undefined") {
        rendererHeartbeatVisibilityBound = true;
        document.addEventListener("visibilitychange", () => { void sendRendererHeartbeat(); });
    }
    if (!desktopEventsBound && typeof window.runtime?.EventsOn === "function") {
        desktopEventsBound = true;
        window.runtime.EventsOn("diagnostics:last-crash-ready", (savedPath) => {
            if (typeof savedPath === "string" && savedPath.trim()) {
                updateDesktopBootSnapshot({
                    uncleanPreviousShutdown: true,
                    lastCrashDiagnosticPath: savedPath.trim(),
                });
            }
        });
        window.runtime.EventsOn("desktop:request-reload", (payload?: unknown) => {
            // Check in-flight guard BEFORE acking: a duplicate event while a
            // flush is already running must not silently ack its requestId and
            // disable Go's native fallback.
            if (reloadFlushInFlight) return;
            reloadFlushInFlight = true;
            const rawId = payload && typeof payload === "object" && "requestId" in payload
                ? Number((payload as { requestId?: unknown }).requestId)
                : 0;
            const reloadAckId = Number.isFinite(rawId) && rawId > 0 ? Math.trunc(rawId) : 0;
            // Immediately ack so Go cancels its 1.5s unresponsive-renderer fallback
            // before we run the full multi-store workspace flush.
            const ackPromise = reloadAckId > 0
                ? Promise.race([sendRendererHeartbeat({ reloadAckId }), waitMs(500)])
                : Promise.resolve();
            void ackPromise
                .then(() => flushAllWorkspacePersistenceBeforeReload())
                .finally(() => {
                    // Reset flag before/after calling reload so if beforeunload
                    // cancels navigation (user clicks Stay), subsequent menu
                    // reload actions remain functional.
                    reloadFlushInFlight = false;
                    window.location.reload();
                });
        });
        // Close the subscribe-after-emit window if Go already wrote the last-crash zip.
        const snapshot = getDesktopBootSnapshot();
        const binding = getDesktopAppBinding();
        if (snapshot.uncleanPreviousShutdown && !snapshot.lastCrashDiagnosticPath && typeof binding?.StartupState === "function") {
            void binding.StartupState().then((fresh) => {
                if (fresh?.lastCrashDiagnosticPath) {
                    updateDesktopBootSnapshot({
                        uncleanPreviousShutdown: true,
                        lastCrashDiagnosticPath: fresh.lastCrashDiagnosticPath,
                    });
                }
            }).catch(() => undefined);
        }
    }
    if (!legacyBlobPurgeTimer) {
        legacyBlobPurgeTimer = setTimeout(() => {
            void purgeLegacyResourceBlobIndexedDB();
        }, 3_000);
        (legacyBlobPurgeTimer as { unref?: () => void }).unref?.();
    }
}

function stopLoopbackUpgradeProbe() {
    if (!upgradeProbeTimer) return;
    clearInterval(upgradeProbeTimer);
    upgradeProbeTimer = null;
}

function getUnderlyingFetch(): typeof fetch {
    if (globalThis.fetch !== wrappedFetch) {
        underlyingFetch = globalThis.fetch.bind(globalThis);
    }
    return underlyingFetch!;
}

function restoreUnderlyingFetch() {
    if (wrappedFetch && underlyingFetch && globalThis.fetch === wrappedFetch) {
        globalThis.fetch = underlyingFetch;
    }
    wrappedFetch = undefined;
}

function isDesktopRuntimeConfig(value: unknown): value is DesktopRuntimeConfig {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<DesktopRuntimeConfig>;
    return /^http:\/\/127\.0\.0\.1:\d+\/api$/u.test(candidate.baseURL ?? "") && Boolean(candidate.launchToken);
}

export function configureDesktopRuntime(config: DesktopRuntimeConfig) {
    stopLoopbackUpgradeProbe();
    const baseURL = config.baseURL.replace(/\/+$/u, "");
    currentDesktopApiBaseURL = baseURL;
    configureApiRuntime(baseURL, config.launchToken, config.uiBootstrapToken);
    const baseFetch = getUnderlyingFetch();
    wrappedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof input === "string" && input.startsWith("/") && !input.startsWith("//")) {
            return baseFetch(input, init);
        }
        const request = new Request(input, init);
        if (request.url === baseURL || request.url.startsWith(`${baseURL}/`)) {
            const headers = new Headers(request.headers);
            headers.set("X-Desktop-Token", config.launchToken);
            return baseFetch(new Request(request, { headers }));
        }
        return baseFetch(request);
    }) as typeof fetch;
    globalThis.fetch = wrappedFetch;
    updateDesktopBootSnapshot({
        state: "ready",
        phase: "ready",
        detail: "本地工作区已就绪",
        transportMode: "loopback",
        streamAvailable: true,
        failure: null,
    });
    ensureDesktopLifecycleHelpers();
}

function startLoopbackUpgradeProbe(config: DesktopRuntimeConfig, probeTimeoutMs: number, intervalMs: number) {
    stopLoopbackUpgradeProbe();
    if (intervalMs <= 0) return;
    const healthURL = `${config.baseURL.replace(/\/+$/u, "")}/health/live`;
    let probing = false;
    const timer = setInterval(() => {
        if (probing) return;
        if (getDesktopBootSnapshot().transportMode !== "same-origin-fallback") {
            stopLoopbackUpgradeProbe();
            return;
        }
        probing = true;
        void probeHealthEndpoint(healthURL, probeTimeoutMs)
            .then((healthy) => {
                if (!healthy || getDesktopBootSnapshot().transportMode !== "same-origin-fallback") return;
                configureDesktopRuntime(config);
                recordStartupDiagnosticEvent({
                    level: "info",
                    category: "environment",
                    code: "desktop_loopback_recovered",
                    reason: "loopback_reachable_upgraded",
                    message: "本机回环端口已恢复连通，已切换回直连流式通道",
                });
            })
            .finally(() => {
                probing = false;
            });
    }, intervalMs);
    (timer as { unref?: () => void }).unref?.();
    upgradeProbeTimer = timer;
}

export function configureSameOriginDesktopFallback(
    upgradeCandidate?: DesktopRuntimeConfig,
    options?: { probeTimeoutMs?: number; upgradeProbeIntervalMs?: number },
) {
    stopLoopbackUpgradeProbe();
    restoreUnderlyingFetch();
    currentDesktopApiBaseURL = "/api";
    configureApiRuntime("/api", upgradeCandidate?.launchToken, upgradeCandidate?.uiBootstrapToken);
    if (upgradeCandidate?.launchToken) {
        const baseFetch = getUnderlyingFetch();
        wrappedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            const isSameOriginApi = rawUrl === "/api" || rawUrl.startsWith("/api/") || (typeof location !== "undefined" && rawUrl.startsWith(`${location.origin}/api`));
            if (!isSameOriginApi) {
                return typeof input === "string" ? baseFetch(input, init) : baseFetch(new Request(input, init));
            }
            const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
            headers.set("X-Desktop-Token", upgradeCandidate.launchToken);
            if (typeof input === "string" || input instanceof URL) {
                return baseFetch(input, { ...init, headers });
            }
            return baseFetch(new Request(input, { ...init, headers }));
        }) as typeof fetch;
        globalThis.fetch = wrappedFetch;
    }
    updateDesktopBootSnapshot({
        state: "ready",
        phase: "ready",
        detail: "已切换至窗口内同源通道",
        transportMode: "same-origin-fallback",
        streamAvailable: false,
        failure: null,
    });
    ensureDesktopLifecycleHelpers();
    recordStartupDiagnosticEvent({
        level: "warning",
        category: "environment",
        code: "desktop_loopback_fallback",
        reason: "loopback_unreachable_same_origin_active",
        message: "本机回环端口直连失败，已自动切换为窗口内同源通道",
    });
    if (upgradeCandidate) {
        startLoopbackUpgradeProbe(
            upgradeCandidate,
            options?.probeTimeoutMs ?? 1_500,
            options?.upgradeProbeIntervalMs ?? 15_000,
        );
    }
}

export async function triggerDesktopStartupRetry(): Promise<void> {
    const binding = getDesktopAppBinding();
    if (typeof binding?.RetryStartup === "function") {
        await binding.RetryStartup();
        return;
    }
    if (isDesktopShellOrigin()) {
        await getUnderlyingFetch()("/__desktop/runtime-config", { method: "POST", cache: "no-store" }).catch(() => undefined);
    }
}

async function probeHealthEndpoint(url: string, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await getUnderlyingFetch()(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) return false;
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        if (contentType && !contentType.includes("json")) return false;
        const payload = await response.json().catch(() => null);
        if (!payload || typeof payload !== "object") return false;
        if ("code" in payload && typeof (payload as { code?: unknown }).code === "number") {
            return (payload as { code: number }).code === 0;
        }
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

function waitMs(ms: number) {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function probeLoopbackWithRetries(
    url: string,
    timeoutMs: number,
    retryDelaysMs: readonly number[],
): Promise<boolean> {
    if (await probeHealthEndpoint(url, timeoutMs)) return true;
    for (const delayMs of retryDelaysMs) {
        if (delayMs > 0) await waitMs(delayMs);
        if (await probeHealthEndpoint(url, timeoutMs)) return true;
    }
    return false;
}

export async function bootstrapDesktopRuntime(options?: {
    retry?: boolean;
    pollIntervalMs?: number;
    maxWaitMs?: number;
    loopbackProbeTimeoutMs?: number;
    loopbackRetryDelaysMs?: readonly number[];
    upgradeProbeIntervalMs?: number;
}) {
    const embedded = getEmbeddedHarnessConfig();
    if (embedded) {
        stopLoopbackUpgradeProbe();
        clearWorkspaceStartupFailure();
        restoreUnderlyingFetch();
        configureApiRuntime(embedded.apiBase);
        updateDesktopBootSnapshot({
            state: "ready",
            phase: "ready",
            detail: "嵌入工作区已连接",
            transportMode: "embedded",
            streamAvailable: true,
            failure: null,
        });
        return true;
    }

    const shellOrigin = isDesktopShellOrigin();
    const initialBinding = getDesktopAppBinding();
    if (!shellOrigin && !initialBinding) return false;

    if (options?.retry) {
        await triggerDesktopStartupRetry();
    }

    const pollIntervalMs = options?.pollIntervalMs ?? 150;
    const maxWaitMs = options?.maxWaitMs ?? 90_000;
    const loopbackProbeTimeoutMs = options?.loopbackProbeTimeoutMs ?? 1_500;
    const deadline = Date.now() + maxWaitMs;
    let triggeredIdleStart = false;
    let config: DesktopRuntimeConfig | undefined;

    while (Date.now() <= deadline) {
        const binding = getDesktopAppBinding();
        let stateCandidate: DesktopStartupState | undefined;

        if (typeof binding?.StartupState === "function") {
            try {
                const candidate = await binding.StartupState();
                let nextCandidate = candidate;
                if (nextCandidate?.state === "idle" && !triggeredIdleStart && typeof binding.RetryStartup === "function") {
                    triggeredIdleStart = true;
                    nextCandidate = await binding.RetryStartup();
                }
                if (
                    nextCandidate &&
                    (nextCandidate.state !== "ready" || isDesktopRuntimeConfig(nextCandidate))
                ) {
                    stateCandidate = nextCandidate;
                }
            } catch {
                // Fall back to the in-process asset endpoint when bindings are still settling.
            }
        }

        if (!config && !stateCandidate && shellOrigin) {
            const response = await getUnderlyingFetch()("/__desktop/runtime-config", { cache: "no-store" });
            if (!response.ok) {
                throw new DesktopStartupError({
                    stage: "desktop_boot",
                    reason: `runtime_config_http_${response.status}`,
                    message: `桌面运行时配置读取失败（HTTP ${response.status}）`,
                });
            }
            const payload = (await response.json()) as unknown;
            if (payload && typeof payload === "object" && "state" in payload && typeof (payload as { state?: unknown }).state === "string") {
                stateCandidate = payload as DesktopStartupState;
            }
        }

        if (stateCandidate) {
            const prev = getDesktopBootSnapshot();
            if (stateCandidate.safeModeRequested) {
                applySessionCanvasMemoryMode("thumbnail-only");
                const reqId = typeof stateCandidate.safeModeRequestId === "number" && Number.isFinite(stateCandidate.safeModeRequestId)
                    ? Math.trunc(stateCandidate.safeModeRequestId)
                    : 0;
                if (reqId > 0) {
                    pendingSafeModeAckId = reqId;
                }
            }
            updateDesktopBootSnapshot({
                state: stateCandidate.state,
                phase: stateCandidate.phase ?? prev.phase,
                detail: stateCandidate.detail ?? prev.detail,
                dataDir: stateCandidate.dataDir || prev.dataDir,
                diagnosticPath: stateCandidate.diagnosticPath || prev.diagnosticPath,
                uncleanPreviousShutdown: Boolean(stateCandidate.uncleanPreviousShutdown || prev.uncleanPreviousShutdown),
                lastCrashDiagnosticPath: stateCandidate.lastCrashDiagnosticPath || prev.lastCrashDiagnosticPath,
            });
            if (stateCandidate.state === "failed") {
                throw new DesktopStartupError({
                    stage: "desktop_boot",
                    phase: stateCandidate.phase,
                    reason: stateCandidate.reason || "desktop_startup_failed",
                    message: stateCandidate.error || stateCandidate.detail || "本地工作区启动失败，请导出诊断包排查。",
                    dataDir: stateCandidate.dataDir || prev.dataDir || undefined,
                    diagnosticPath: stateCandidate.diagnosticPath || prev.diagnosticPath || undefined,
                });
            }
            if (stateCandidate.state === "ready" && isDesktopRuntimeConfig(stateCandidate)) {
                config = {
                    baseURL: stateCandidate.baseURL!,
                    launchToken: stateCandidate.launchToken!,
                    uiBootstrapToken: stateCandidate.uiBootstrapToken,
                };
                break;
            }
            if (stateCandidate.state === "starting" || stateCandidate.state === "idle") {
                if (Date.now() + pollIntervalMs > deadline) {
                    throw new DesktopStartupError({
                        stage: "desktop_boot",
                        phase: stateCandidate.phase,
                        reason: "desktop_startup_timeout",
                        message: "本地工作区启动等待超时，请检查磁盘读写与安全软件设置后重新加载。",
                        dataDir: stateCandidate.dataDir || prev.dataDir || undefined,
                    });
                }
                await waitMs(pollIntervalMs);
                continue;
            }
        }

        break;
    }

    if (!config) return false;

    clearWorkspaceStartupFailure();
    if (shellOrigin) {
        const retryDelays = options?.loopbackRetryDelaysMs ?? [120, 250];
        const loopbackHealthy = await probeLoopbackWithRetries(
            `${config.baseURL.replace(/\/+$/u, "")}/health/live`,
            loopbackProbeTimeoutMs,
            retryDelays,
        );
        if (!loopbackHealthy) {
            const sameOriginHealthy = await probeHealthEndpoint("/api/health/live", loopbackProbeTimeoutMs);
            if (sameOriginHealthy) {
                configureSameOriginDesktopFallback(config, {
                    probeTimeoutMs: loopbackProbeTimeoutMs,
                    upgradeProbeIntervalMs: options?.upgradeProbeIntervalMs,
                });
                return true;
            }
        }
    }

    configureDesktopRuntime(config);
    return true;
}
