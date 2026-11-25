import { useCallback, useEffect, useRef, useState } from "react";
import {
    getNetworkProxySettings,
    updateNetworkProxyMode,
    type NetworkProxyMode,
    type NetworkProxyStatus,
} from "@/services/api/network-proxy";

export function useNetworkProxySetting(enabled = true) {
    const [status, setStatus] = useState<NetworkProxyStatus | null>(null);
    const [loading, setLoading] = useState<boolean>(false);
    const [saving, setSaving] = useState<boolean>(false);
    const [error, setError] = useState<string>("");
    const loadSeq = useRef(0);
    const saveSeq = useRef(0);
    const savingRef = useRef(false);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const refresh = useCallback(async (signal?: AbortSignal, options?: { silent?: boolean }) => {
        const seq = ++loadSeq.current;
        const saveAtStart = saveSeq.current;
        const silent = Boolean(options?.silent);
        if (!silent) {
            setLoading(true);
            setError("");
        }
        try {
            const result = await getNetworkProxySettings(signal);
            if (!mounted.current || seq !== loadSeq.current || result.stale || saveAtStart !== saveSeq.current) {
                return null;
            }
            setStatus(result.status);
            return result.status;
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") return null;
            if (!mounted.current || seq !== loadSeq.current || saveAtStart !== saveSeq.current) return null;
            if (!silent) {
                setError(err instanceof Error && err.message ? err.message : "无法读取网络代理设置");
            }
            return null;
        } finally {
            if (!silent && mounted.current && seq === loadSeq.current) {
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        void refresh(controller.signal);
        return () => {
            controller.abort();
        };
    }, [enabled, refresh]);

    const restartPending = Boolean(status?.assistantRestartPending);
    useEffect(() => {
        if (!enabled || !restartPending || saving) return;
        let controller: AbortController | null = null;
        const timer = window.setInterval(() => {
            controller?.abort();
            controller = new AbortController();
            void refresh(controller.signal, { silent: true });
        }, 2500);
        return () => {
            window.clearInterval(timer);
            controller?.abort();
        };
    }, [enabled, restartPending, saving, refresh]);

    const saveMode = useCallback(async (mode: NetworkProxyMode): Promise<NetworkProxyStatus | null> => {
        if (savingRef.current) return null;
        const seq = ++saveSeq.current;
        savingRef.current = true;
        setSaving(true);
        setError("");
        try {
            const result = await updateNetworkProxyMode(mode);
            if (!mounted.current || seq !== saveSeq.current || result.stale) return null;
            setStatus(result.status);
            return result.status;
        } catch (err) {
            if (!mounted.current || seq !== saveSeq.current) return null;
            const message = err instanceof Error && err.message ? err.message : "保存网络代理设置失败";
            setError(message);
            return null;
        } finally {
            if (seq === saveSeq.current) {
                savingRef.current = false;
                if (mounted.current) {
                    setSaving(false);
                }
            }
        }
    }, []);

    return {
        status,
        loading,
        saving,
        error,
        refresh,
        saveMode,
    };
}
