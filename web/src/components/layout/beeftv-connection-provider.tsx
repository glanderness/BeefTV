import { App } from "antd";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { mergeManagedBeefTVCatalog, shouldRefreshBeefTVCatalog } from "@/lib/managed-beeftv-catalog";
import { localWorkspaceConfig } from "@/lib/user-session";
import { cancelBeefTVConnection, disconnectBeefTVConnection, getBeefTVConnection, openBeefTVWallet, startBeefTVConnection, type BeefTVConnectionSummary } from "@/services/api/beeftv-connection";
import { getLocalModelConfig } from "@/services/api/workspace";
import { normalizeConfigSnapshot, useConfigStore } from "@/stores/use-config-store";

const BeefTVConnectionContext = createContext<ReturnType<typeof useConnectionState> | null>(null);

export function BeefTVConnectionProvider({ children }: { children: ReactNode }) {
    const connection = useConnectionState();
    return <BeefTVConnectionContext.Provider value={connection}>{children}</BeefTVConnectionContext.Provider>;
}

export function useBeefTVConnection() {
    const connection = useContext(BeefTVConnectionContext);
    if (!connection) throw new Error("BeefTVConnectionProvider is required");
    return connection;
}

function useConnectionState() {
    const { message } = App.useApp();
    const [connection, setConnection] = useState<BeefTVConnectionSummary | null>(null);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [catalogSyncFailed, setCatalogSyncFailed] = useState(false);
    const currentConnection = useRef<BeefTVConnectionSummary | null>(null);
    const appliedState = useRef<string | undefined>(undefined);
    const catalogSync = useRef<{ state: string; selection: string; adopt: boolean; pending: boolean } | null>(null);
    const actionPending = useRef(false);

    const applyConnection = async (summary: BeefTVConnectionSummary) => {
        const previousState = currentConnection.current?.state;
        currentConnection.current = summary;
        setConnection(summary);
        const retry = catalogSync.current?.state === summary.state ? catalogSync.current : null;
        if (retry?.pending) return;
        if (appliedState.current === summary.state && !retry) return;
        appliedState.current = summary.state;
        if (!retry && !shouldRefreshBeefTVCatalog(previousState, summary.state)) {
            catalogSync.current = null;
            setCatalogSyncFailed(false);
            return;
        }
        const intent = retry || { state: summary.state, selection: useConfigStore.getState().config.assistantModel, adopt: summary.state === "connected" && Boolean(previousState && previousState !== "connected"), pending: false };
        catalogSync.current = intent;
        intent.pending = true;
        setSyncing(true);
        try {
            const result = await getLocalModelConfig();
            if (catalogSync.current !== intent) return;
            const current = useConfigStore.getState().config;
            useConfigStore.getState().replaceConfig(localWorkspaceConfig(normalizeConfigSnapshot({
                config: mergeManagedBeefTVCatalog(current, result.config, intent.adopt && current.assistantModel === intent.selection),
            }).config));
            catalogSync.current = null;
            setCatalogSyncFailed(false);
        } catch {
            if (catalogSync.current === intent) setCatalogSyncFailed(true);
        } finally {
            intent.pending = false;
            if (!catalogSync.current || catalogSync.current === intent) setSyncing(false);
        }
    };

    const refresh = async () => applyConnection(await getBeefTVConnection());

    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            if (!actionPending.current) {
                try {
                    const summary = await getBeefTVConnection();
                    if (!stopped && !actionPending.current) await applyConnection(summary);
                } catch { /* 后台状态读取失败时保留已确认的连接，手动操作显示错误。 */ }
                finally { if (!stopped) setLoading(false); }
            }
            if (!stopped) {
                const state = currentConnection.current?.state;
                timer = setTimeout(poll, state === "pending" || state === "connecting" ? 2000 : 30000);
            }
        };
        void poll();
        return () => { stopped = true; clearTimeout(timer); };
    }, [connection?.state]);

    const runAction = async (action: () => Promise<BeefTVConnectionSummary>) => {
        if (actionPending.current) return;
        actionPending.current = true;
        setBusy(true);
        const previous = currentConnection.current;
        try {
            await applyConnection(await action());
        } catch (error) {
            try { await refresh(); } catch { setConnection(previous); }
            message.error(error instanceof Error ? error.message : "无法更新 BeefTV 连接，请重试");
        } finally {
            actionPending.current = false;
            setBusy(false);
        }
    };

    const connect = () => runAction(async () => {
        const state = currentConnection.current?.state;
        if (state === "expired" || state === "revoked" || state === "rejected") await disconnectBeefTVConnection();
        setConnection({ state: "connecting", hasCredential: currentConnection.current?.hasCredential || false });
        return startBeefTVConnection();
    });

    return {
        connection,
        busy,
        loading,
        syncing,
        catalogSyncFailed,
        connect,
        cancel: () => runAction(cancelBeefTVConnection),
        disconnect: () => runAction(disconnectBeefTVConnection),
        refresh: () => runAction(getBeefTVConnection),
        openAccount: () => openBeefTVWallet().catch((error) => message.error(error instanceof Error ? error.message : "无法打开 BeefTV 账户")),
    };
}
