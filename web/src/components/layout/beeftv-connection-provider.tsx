import { App } from "antd";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { mergeManagedBeefTVCatalog, shouldRefreshBeefTVCatalog } from "@/lib/managed-beeftv-catalog";
import { localWorkspaceConfig } from "@/lib/user-session";
import { cancelBeefTVConnection, disconnectBeefTVConnection, getBeefTVConnection, getBeefTVConnectionEpoch, openBeefTVWallet, startBeefTVConnection, syncBeefTVConnection, type BeefTVConnectionSummary } from "@/services/api/beeftv-connection";
import { getLocalModelConfig } from "@/services/api/workspace";
import { acceptExternalModelConfig, getModelConfigPersistenceState, withoutModelConfigAutosave } from "@/services/model-config-repository";
import { normalizeConfigSnapshot, useConfigStore } from "@/stores/use-config-store";

const BeefTVConnectionContext = createContext<ReturnType<typeof useConnectionState> | null>(null);
const LIFECYCLE_SYNC_THROTTLE_MS = 5_000;

export function BeefTVConnectionProvider({ children }: { children: ReactNode }) {
    const connection = useConnectionState();
    return <BeefTVConnectionContext.Provider value={connection}>{children}</BeefTVConnectionContext.Provider>;
}

export function useBeefTVConnection() {
    const connection = useContext(BeefTVConnectionContext);
    if (!connection) throw new Error("BeefTVConnectionProvider is required");
    return connection;
}

export function useOptionalBeefTVConnection() {
    return useContext(BeefTVConnectionContext);
}

export function shouldSyncManagedBeefTVRevision(
    previousState: string | undefined,
    summary: Pick<BeefTVConnectionSummary, "state" | "catalogRevision" | "catalogConfigRevision">,
    appliedCatalogRevision: number | null,
    initialHydratedRevision: number,
) {
    const nextCatalogRevision = typeof summary.catalogRevision === "number" && Number.isSafeInteger(summary.catalogRevision) && summary.catalogRevision >= 0 ? summary.catalogRevision : 0;
    const nextCatalogConfigRevision = typeof summary.catalogConfigRevision === "number" && Number.isSafeInteger(summary.catalogConfigRevision) && summary.catalogConfigRevision > 0 ? summary.catalogConfigRevision : 0;
    if (summary.state === "connected") {
        if (appliedCatalogRevision === null) {
            if (previousState && previousState !== "connected") return true;
            if (nextCatalogConfigRevision > initialHydratedRevision) return true;
            return false;
        }
        if (nextCatalogRevision > appliedCatalogRevision) {
            return true;
        }
    }
    return shouldRefreshBeefTVCatalog(previousState, summary.state);
}

function pollIntervalForSummary(summary: BeefTVConnectionSummary | null | undefined) {
    const state = summary?.state;
    if (state === "pending" || state === "connecting") return 2000;
    if (summary?.catalogSyncing) return 1000;
    return 30000;
}

function useConnectionState() {
    const { message } = App.useApp();
    const [connection, setConnection] = useState<BeefTVConnectionSummary | null>(null);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [catalogSyncFailed, setCatalogSyncFailed] = useState(false);
    const [balanceRefreshFailed, setBalanceRefreshFailed] = useState(false);
    const [catalogRevision, setCatalogRevision] = useState<number>(0);
    const currentConnection = useRef<BeefTVConnectionSummary | null>(null);
    const appliedState = useRef<string | undefined>(undefined);
    const initialHydratedRevision = useRef<number>(getModelConfigPersistenceState().revision);
    const appliedCatalogRevision = useRef<number | null>(null);
    const desiredCatalogRevision = useRef<number>(0);
    const catalogSync = useRef<{ state: string; targetRevision: number; selection: string; adopt: boolean; pending: boolean } | null>(null);
    const actionPending = useRef(false);
    const lifecycleSyncInFlight = useRef(false);
    const lastLifecycleSyncAt = useRef(0);
    const mutationSeq = useRef(0);
    const scheduleNextPoll = useRef<((summary?: BeefTVConnectionSummary | null) => void) | null>(null);

    const recordCatalogRevision = (revision: number) => {
        if (!Number.isSafeInteger(revision) || revision < 0) return;
        const next = appliedCatalogRevision.current === null ? revision : Math.max(appliedCatalogRevision.current, revision);
        appliedCatalogRevision.current = next;
        desiredCatalogRevision.current = Math.max(desiredCatalogRevision.current, next);
        setCatalogRevision(next);
    };

    const runCatalogReload = async (intent: { state: string; targetRevision: number; selection: string; adopt: boolean; pending: boolean }) => {
        catalogSync.current = intent;
        intent.pending = true;
        setSyncing(true);
        try {
            const result = await getLocalModelConfig();
            if (catalogSync.current !== intent) return;
            const current = useConfigStore.getState().config;
            const nextConfig = localWorkspaceConfig(normalizeConfigSnapshot({
                config: mergeManagedBeefTVCatalog(current, result.config, intent.adopt && current.assistantModel === intent.selection),
            }).config);
            withoutModelConfigAutosave(() => {
                useConfigStore.getState().replaceConfig(nextConfig);
            });
            acceptExternalModelConfig(nextConfig, result.revision);
            recordCatalogRevision(intent.targetRevision);
            catalogSync.current = null;
            setCatalogSyncFailed(false);
        } catch {
            if (catalogSync.current === intent) setCatalogSyncFailed(true);
        } finally {
            intent.pending = false;
            const latest = currentConnection.current;
            const applied = appliedCatalogRevision.current ?? 0;
            const needsFollowUp = catalogSync.current === null && latest?.state === "connected" && desiredCatalogRevision.current > applied;
            if (needsFollowUp) {
                const followUp = {
                    state: latest.state,
                    targetRevision: desiredCatalogRevision.current,
                    selection: useConfigStore.getState().config.assistantModel,
                    adopt: false,
                    pending: false,
                };
                void runCatalogReload(followUp);
            } else if (!catalogSync.current || catalogSync.current === intent) {
                setSyncing(false);
            }
        }
    };

    const applyConnection = async (summary: BeefTVConnectionSummary, options?: { allowRetry?: boolean }) => {
        const previousState = currentConnection.current?.state;
        currentConnection.current = summary;
        setConnection(summary);
        scheduleNextPoll.current?.(summary);
        const nextCatalogRevision = typeof summary.catalogRevision === "number" && Number.isSafeInteger(summary.catalogRevision) && summary.catalogRevision >= 0 ? summary.catalogRevision : 0;
        if (nextCatalogRevision > desiredCatalogRevision.current) {
            desiredCatalogRevision.current = nextCatalogRevision;
        }
        const retry = catalogSync.current?.state === summary.state ? catalogSync.current : null;
        if (retry?.pending) return;
        const needsSync = shouldSyncManagedBeefTVRevision(previousState, summary, appliedCatalogRevision.current, initialHydratedRevision.current);
        if (!needsSync && appliedState.current === summary.state && !(retry && options?.allowRetry)) {
            if (summary.state === "connected") {
                recordCatalogRevision(nextCatalogRevision);
            }
            return;
        }
        appliedState.current = summary.state;
        if (!retry && !needsSync) {
            if (summary.state === "connected") {
                recordCatalogRevision(nextCatalogRevision);
            }
            catalogSync.current = null;
            setCatalogSyncFailed(false);
            return;
        }
        const intent = retry || {
            state: summary.state,
            targetRevision: nextCatalogRevision,
            selection: useConfigStore.getState().config.assistantModel,
            adopt: summary.state === "connected" && Boolean(previousState && previousState !== "connected"),
            pending: false,
        };
        intent.targetRevision = Math.max(intent.targetRevision, nextCatalogRevision);
        await runCatalogReload(intent);
    };

    const refresh = async (options?: { allowRetry?: boolean }) => applyConnection(await getBeefTVConnection(), options);

    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = (summary = currentConnection.current) => {
            clearTimeout(timer);
            if (stopped) return;
            timer = setTimeout(poll, pollIntervalForSummary(summary));
        };
        scheduleNextPoll.current = arm;
        const poll = async () => {
            if (!actionPending.current) {
                const epoch = getBeefTVConnectionEpoch();
                const seq = mutationSeq.current;
                try {
                    const summary = await getBeefTVConnection();
                    if (!stopped && !actionPending.current && epoch === getBeefTVConnectionEpoch() && seq === mutationSeq.current) {
                        await applyConnection(summary);
                    }
                } catch { /* 后台状态读取失败时保留已确认的连接，手动操作显示错误。 */ }
            }
            if (!stopped) {
                setLoading(false);
                arm();
            }
        };
        const syncOnWake = async () => {
            if (stopped || actionPending.current || lifecycleSyncInFlight.current) return;
            const currentState = currentConnection.current?.state;
            if (currentState !== "connected" && currentState !== "catalog_failed") return;
            const now = Date.now();
            if (now - lastLifecycleSyncAt.current < LIFECYCLE_SYNC_THROTTLE_MS) return;
            lastLifecycleSyncAt.current = now;
            lifecycleSyncInFlight.current = true;
            const epoch = getBeefTVConnectionEpoch();
            const seq = mutationSeq.current;
            try {
                const summary = await syncBeefTVConnection();
                if (!stopped && !actionPending.current && epoch === getBeefTVConnectionEpoch() && seq === mutationSeq.current) {
                    await applyConnection(summary);
                }
            } catch { /* 切回前台静默检查失败时不打扰用户。 */ }
            finally {
                lifecycleSyncInFlight.current = false;
            }
        };
        const onVisible = () => {
            if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
            void syncOnWake();
        };
        const onOnline = () => {
            void syncOnWake();
        };
        if (typeof window !== "undefined") {
            window.addEventListener("focus", onVisible);
            window.addEventListener("online", onOnline);
        }
        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", onVisible);
        }
        void poll();
        return () => {
            stopped = true;
            scheduleNextPoll.current = null;
            clearTimeout(timer);
            if (typeof window !== "undefined") {
                window.removeEventListener("focus", onVisible);
                window.removeEventListener("online", onOnline);
            }
            if (typeof document !== "undefined") {
                document.removeEventListener("visibilitychange", onVisible);
            }
        };
    }, []);

    const runAction = async (action: () => Promise<BeefTVConnectionSummary>, options?: { allowRetry?: boolean }) => {
        if (actionPending.current) return;
        actionPending.current = true;
        mutationSeq.current += 1;
        setBusy(true);
        const previous = currentConnection.current;
        try {
            await applyConnection(await action(), options);
        } catch (error) {
            try { await refresh(); } catch { setConnection(previous); }
            message.error(error instanceof Error ? error.message : "无法更新 BeefTV 连接，请重试");
        } finally {
            actionPending.current = false;
            setLoading(false);
            setBusy(false);
        }
    };

    const connect = () => runAction(async () => {
        const state = currentConnection.current?.state;
        if (state === "expired" || state === "revoked" || state === "rejected") await disconnectBeefTVConnection();
        setConnection({ state: "connecting", hasCredential: currentConnection.current?.hasCredential || false });
        return startBeefTVConnection();
    });

    const retryCatalog = () => {
        const current = currentConnection.current;
        if (current?.catalogFailed || current?.state === "catalog_failed") return connect();
        return runAction(getBeefTVConnection, { allowRetry: true });
    };

    const refreshBalance = async () => {
        if (actionPending.current) return;
        const epoch = getBeefTVConnectionEpoch();
        const seq = mutationSeq.current;
        try {
            const summary = await getBeefTVConnection(undefined, { refresh: true });
            if (!actionPending.current && epoch === getBeefTVConnectionEpoch() && seq === mutationSeq.current) {
                mutationSeq.current += 1;
                setBalanceRefreshFailed(false);
                await applyConnection(summary);
            }
        } catch {
            if (epoch === getBeefTVConnectionEpoch() && seq === mutationSeq.current) {
                setBalanceRefreshFailed(true);
            }
        }
    };

    const applySummary = (summary: BeefTVConnectionSummary) => {
        mutationSeq.current += 1;
        setBalanceRefreshFailed(false);
        void applyConnection(summary);
    };

    const getMutationSeq = () => mutationSeq.current;

    const applyBalanceCnyIfCurrent = (expectedSeq: number, balanceCny: string) => {
        if (actionPending.current || expectedSeq !== mutationSeq.current) return false;
        const current = currentConnection.current;
        if (!current || !/^\d+(?:\.\d{2})?$/.test(balanceCny)) return false;
        const nextBalance = balanceCny === "0.00" ? "zero" : "available";
        mutationSeq.current += 1;
        setBalanceRefreshFailed(false);
        if (current.balanceCny === balanceCny && current.balance === nextBalance) return true;
        void applyConnection({ ...current, balance: nextBalance, balanceCny });
        return true;
    };

    return {
        connection,
        busy,
        loading,
        syncing,
        catalogRevision,
        balanceRefreshFailed,
        catalogSyncFailed: catalogSyncFailed || Boolean(connection?.catalogFailed || connection?.state === "catalog_failed"),
        connect,
        cancel: () => runAction(cancelBeefTVConnection),
        disconnect: () => runAction(disconnectBeefTVConnection),
        refresh: () => runAction(getBeefTVConnection, { allowRetry: true }),
        refreshBalance,
        noteCatalogRevision: recordCatalogRevision,
        getMutationSeq,
        applySummary,
        applyBalanceCnyIfCurrent,
        retryCatalog,
        openAccount: () => openBeefTVWallet().catch((error) => message.error(error instanceof Error ? error.message : "无法打开 BeefTV 账户")),
    };
}
