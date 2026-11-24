import { useEffect, useRef, useState, type SyntheticEvent } from "react";

import { isUndecodableVideoTrack } from "@/lib/video-player-policy";
import { ownedResourceStorageKey, resourceIdFromStorageKey } from "@/services/api/resources";
import { invalidateResourceMediaTicket, MEDIA_TICKET_REFRESH_MARGIN_MS } from "@/services/media-asset-url";
import { resolveResourceVideoPlayback } from "@/services/resource-video-playback";

type ResolvedVideoAttempt = {
    identity: string;
    url: string;
    compatible: boolean;
    requestedCompatible: boolean;
    epoch: number;
};

// All video surfaces share request ownership, loopback ticket streaming, decode fallback and Blob URL disposal.
export function useResourceVideoPlayback(storageKey: string, fallback: string, active = true) {
    const [url, setUrl] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [compatible, setCompatible] = useState(false);
    const [compatibleTarget, setCompatibleTarget] = useState("");
    const [loadedIdentity, setLoadedIdentity] = useState("");
    const [retryEpoch, setRetryEpoch] = useState(0);
    const streamMetaRef = useRef<{ identity: string; mode?: string; expiresAtMs?: number; autoRefreshedKey?: string }>({ identity: "" });
    const resolvedRef = useRef<ResolvedVideoAttempt | null>(null);
    const handledSourceRef = useRef<{ url: string; recovered: boolean } | null>(null);
    const identity = JSON.stringify([storageKey, fallback]);
    const needsCompatible = compatibleTarget === identity;
    useEffect(() => { if (!active) setCompatibleTarget(""); }, [active]);

    useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        let ownedUrl = "";
        resolvedRef.current = null;
        handledSourceRef.current = null;
        setLoadedIdentity(identity);
        setError("");
        setCompatible(false);
        setUrl("");
        setLoading(active);
        if (streamMetaRef.current.identity !== identity) {
            streamMetaRef.current = { identity };
        }
        if (!active) return;
        void resolveResourceVideoPlayback(storageKey, fallback, controller.signal, needsCompatible)
            .then((resolved) => {
                if (cancelled) return;
                let nextUrl = "";
                let nextCompatible = false;
                if (typeof resolved === "string") {
                    streamMetaRef.current = { identity };
                    nextUrl = resolved;
                } else if ("url" in resolved) {
                    streamMetaRef.current = {
                        identity,
                        mode: resolved.mode,
                        expiresAtMs: resolved.expiresAtMs,
                        autoRefreshedKey: streamMetaRef.current.autoRefreshedKey,
                    };
                    nextUrl = resolved.url;
                    nextCompatible = resolved.compatible;
                } else {
                    streamMetaRef.current = { identity };
                    ownedUrl = URL.createObjectURL(resolved.blob);
                    nextUrl = ownedUrl;
                    nextCompatible = resolved.compatible;
                }
                resolvedRef.current = nextUrl
                    ? { identity, url: nextUrl, compatible: nextCompatible, requestedCompatible: needsCompatible, epoch: retryEpoch }
                    : null;
                handledSourceRef.current = null;
                setError("");
                setCompatible(nextCompatible);
                setUrl(nextUrl);
            })
            .catch((error) => {
                if (!cancelled) setError(error instanceof Error ? error.message : "视频加载失败，请重新打开");
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; controller.abort(); if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
    }, [active, fallback, storageKey, identity, needsCompatible, retryEpoch]);

    const requestCompatible = () => {
        const resolved = resolvedRef.current;
        if (!resolved || resolved.identity !== identity) {
            // A fresh load or compatible fallback is already in flight; ignore stale
            // media events from an outgoing <video> before the swap commits.
            return active && !error;
        }
        if (handledSourceRef.current?.url === resolved.url) {
            return handledSourceRef.current.recovered;
        }
        const effectiveKey = ownedResourceStorageKey(storageKey, fallback);
        const resourceId = resourceIdFromStorageKey(effectiveKey);
        const meta = streamMetaRef.current;
        const variant: "original" | "playback" = resolved.requestedCompatible || resolved.compatible ? "playback" : "original";
        const refreshKey = `${identity}:${variant}:${resolved.epoch}`;
        // If a long-paused loopback ticket has expired (or is within the renewal margin),
        // silently re-issue a fresh ticket for the same variant once before falling back
        // to transcode or surfacing an error.
        if (
            resourceId &&
            meta.identity === identity &&
            meta.mode === "loopback-ticket" &&
            meta.autoRefreshedKey !== refreshKey &&
            (!meta.expiresAtMs || Date.now() >= meta.expiresAtMs - MEDIA_TICKET_REFRESH_MARGIN_MS)
        ) {
            meta.autoRefreshedKey = `${identity}:${variant}:${resolved.epoch + 1}`;
            handledSourceRef.current = { url: resolved.url, recovered: true };
            invalidateResourceMediaTicket(resourceId, variant);
            setError("");
            setRetryEpoch((value) => value + 1);
            return true;
        }
        if (resourceId) invalidateResourceMediaTicket(resourceId);
        if (resolved.requestedCompatible || resolved.compatible || !resourceId) {
            handledSourceRef.current = { url: resolved.url, recovered: false };
            return false;
        }
        handledSourceRef.current = { url: resolved.url, recovered: true };
        setCompatibleTarget(identity);
        return true;
    };
    const fail = () => setError("视频暂时无法播放，请重新读取预览。");
    const handleVideoError = () => {
        if (!requestCompatible()) fail();
    };
    const rejectUndecodableVideo = (video: HTMLVideoElement | null | undefined): boolean => {
        if (!isUndecodableVideoTrack(video)) return false;
        video?.pause();
        handleVideoError();
        return true;
    };
    const handleVideoTrackEvent = (event: SyntheticEvent<HTMLVideoElement>) => {
        rejectUndecodableVideo(event.currentTarget);
    };
    const videoFallbackProps = {
        onLoadedMetadata: handleVideoTrackEvent,
        onLoadedData: handleVideoTrackEvent,
        onCanPlay: handleVideoTrackEvent,
        onError: handleVideoError,
    };
    const current = active && loadedIdentity === identity;
    return { url: current ? url : "", loading: active && (!current || loading), error: current ? error : "",
        compatible: current && compatible, requestCompatible, rejectUndecodableVideo, videoFallbackProps, retryEpoch,
        retry: () => {
            const resourceId = resourceIdFromStorageKey(ownedResourceStorageKey(storageKey, fallback));
            if (resourceId) invalidateResourceMediaTicket(resourceId);
            resolvedRef.current = null;
            handledSourceRef.current = null;
            streamMetaRef.current.autoRefreshedKey = undefined;
            setError("");
            setRetryEpoch((value) => value + 1);
        },
        fail };
}
