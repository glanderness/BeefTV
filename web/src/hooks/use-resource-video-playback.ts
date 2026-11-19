import { useEffect, useState } from "react";

import { resourceIdFromStorageKey } from "@/services/api/resources";
import { invalidateResourceMediaTicket } from "@/services/media-asset-url";
import { resolveResourceVideoPlayback } from "@/services/resource-video-playback";

// All video surfaces share request ownership, loopback ticket streaming, decode fallback and Blob URL disposal.
export function useResourceVideoPlayback(storageKey: string, fallback: string, active = true) {
    const [url, setUrl] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [compatible, setCompatible] = useState(false);
    const [compatibleTarget, setCompatibleTarget] = useState("");
    const [loadedIdentity, setLoadedIdentity] = useState("");
    const [retryEpoch, setRetryEpoch] = useState(0);
    const identity = JSON.stringify([storageKey, fallback]);
    const needsCompatible = compatibleTarget === identity;
    useEffect(() => { if (!active) setCompatibleTarget(""); }, [active]);

    useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        let ownedUrl = "";
        setLoadedIdentity(identity);
        setError("");
        setCompatible(false);
        setUrl("");
        setLoading(active);
        if (!active) return;
        void resolveResourceVideoPlayback(storageKey, fallback, controller.signal, needsCompatible)
            .then((resolved) => {
                if (cancelled) return;
                if (typeof resolved === "string") {
                    setUrl(resolved);
                } else if ("url" in resolved) {
                    setCompatible(resolved.compatible);
                    setUrl(resolved.url);
                } else {
                    ownedUrl = URL.createObjectURL(resolved.blob);
                    setCompatible(resolved.compatible);
                    setUrl(ownedUrl);
                }
            })
            .catch((error) => {
                if (!cancelled) setError(error instanceof Error ? error.message : "视频加载失败，请重新打开");
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; controller.abort(); if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
    }, [active, fallback, storageKey, identity, needsCompatible, retryEpoch]);

    const requestCompatible = () => {
        const resourceId = resourceIdFromStorageKey(storageKey);
        if (resourceId) invalidateResourceMediaTicket(resourceId);
        if (needsCompatible || (loadedIdentity === identity && compatible) || !storageKey.startsWith("resource:")) return false;
        setCompatibleTarget(identity);
        return true;
    };
    const current = active && loadedIdentity === identity;
    return { url: current ? url : "", loading: active && (!current || loading), error: current ? error : "",
        compatible: current && compatible, requestCompatible, retryEpoch,
        retry: () => {
            const resourceId = resourceIdFromStorageKey(storageKey);
            if (resourceId) invalidateResourceMediaTicket(resourceId);
            setError("");
            setRetryEpoch((value) => value + 1);
        },
        fail: () => setError("视频暂时无法播放，请重新读取预览。") };
}
