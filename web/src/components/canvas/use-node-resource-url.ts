import { useCallback, useEffect, useRef, useState } from "react";
import { buildLibTVImagePreviewUrl, buildLibTVVideoSourceUrl } from "@/lib/canvas/libtv-import";
import { isProtectedResourceFileUrl, ownedResourceStorageKey, resourceIdFromStorageKey } from "@/services/api/resources";
import { canUseSameOriginResourceAsset, resourcePreviewAssetUrl } from "@/services/media-asset-url";
import { cacheResourceImagePreviewObjectUrl, cacheResourceObjectUrl, getCachedResourceObjectUrl, peekCachedResourceObjectUrl, peekFallbackResourceImagePreviewUrl } from "@/services/resource-blob-cache";
import { resolveImageUrl } from "@/services/image-storage";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function useNodeResourceUrl(node: CanvasNodeData, eager: boolean, previewSize?: number) {
    const rawContent = node.metadata?.content || "";
    const content = node.type === CanvasNodeType.Video && node.metadata?.importSource?.provider === "libtv"
        ? buildLibTVVideoSourceUrl(rawContent)
        : rawContent;
    const rawFallback = node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio
        ? content
        : node.metadata?.previewContent
            || (node.type === CanvasNodeType.Image && node.metadata?.importSource?.provider === "libtv" ? buildLibTVImagePreviewUrl(content) : content);
    const storageKey = ownedResourceStorageKey(node.metadata?.storageKey, rawFallback || content);
    const fallback = isProtectedResourceFileUrl(rawFallback) ? "" : rawFallback;
    const resourceId = resourceIdFromStorageKey(storageKey);
    const isRemoteResource = Boolean(resourceId);
    const isLazyVisual = node.type === CanvasNodeType.Image;
    const useDirectSameOriginPreview = isRemoteResource && isLazyVisual && canUseSameOriginResourceAsset();

    const synchronousUrl = eager && isRemoteResource && isLazyVisual
        ? useDirectSameOriginPreview
            ? resourcePreviewAssetUrl(resourceId, previewSize)
            : peekFallbackResourceImagePreviewUrl(storageKey, previewSize)
        : "";
    const initialUrl = synchronousUrl || (isRemoteResource || isLazyVisual ? "" : fallback);
    const [url, setUrl] = useState(() => initialUrl);
    const [loading, setLoading] = useState(() => !initialUrl && isRemoteResource && eager);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const reloadRequested = useRef(false);
    const sourceIdentityRef = useRef(storageKey);
    const reportImageEvent = useCallback((code: "CANVAS_IMAGE_READ_FAILED" | "CANVAS_IMAGE_DECODE_FAILED" | "CANVAS_IMAGE_RELOAD") => {
        if (node.type !== CanvasNodeType.Image) return;
        const safeNodeId = /^[A-Za-z0-9._:-]{1,96}$/.test(node.id) ? node.id : "unknown";
        recordDiagnosticEvent({
            level: code === "CANVAS_IMAGE_RELOAD" ? "info" : "error",
            category: "runtime", code,
            message: `${code === "CANVAS_IMAGE_DECODE_FAILED" ? "画布图片解码失败" : code === "CANVAS_IMAGE_READ_FAILED" ? "画布图片读取失败" : "重新读取画布图片"} node=${safeNodeId}`,
            taskId: node.metadata?.taskId,
            route: resourceId && /^[A-Za-z0-9_-]{1,96}$/.test(resourceId)
                ? `/resources/${resourceId}/${useDirectSameOriginPreview ? "asset" : "file"}`
                : undefined,
        });
    }, [node.id, node.type, node.metadata?.taskId, resourceId, useDirectSameOriginPreview]);
    const fail = useCallback(() => { reportImageEvent("CANVAS_IMAGE_DECODE_FAILED"); setError(true); }, [reportImageEvent]);
    const retry = useCallback(() => { reportImageEvent("CANVAS_IMAGE_RELOAD"); reloadRequested.current = true; setError(false); setAttempt((current) => current + 1); }, [reportImageEvent]);

    useEffect(() => {
        let cancelled = false;
        const sourceIdentity = storageKey;
        const sourceChanged = sourceIdentityRef.current !== sourceIdentity;
        sourceIdentityRef.current = sourceIdentity;
        if (sourceChanged) setUrl("");
        setError(false);

        if (useDirectSameOriginPreview) {
            // Unmount offscreen image URLs cleanly so GPU decoded textures are released.
            if (!eager) {
                setUrl("");
                setLoading(false);
                return;
            }
            const directUrl = resourcePreviewAssetUrl(resourceId, previewSize, "preserve", attempt || undefined);
            setUrl(directUrl);
            setLoading(false);
            return;
        }

        if (!isRemoteResource && isLazyVisual && storageKey) {
            if (!eager) {
                setUrl("");
                setLoading(false);
                return;
            }
            setLoading(true);
            void resolveImageUrl(storageKey, fallback, { renderable: true })
                .then((resolved) => {
                    if (!cancelled) setUrl(resolved);
                })
                .catch(() => {
                    if (!cancelled) { setUrl(""); setError(true); reportImageEvent("CANVAS_IMAGE_READ_FAILED"); }
                })
                .finally(() => {
                    if (!cancelled) setLoading(false);
                });
            return () => { cancelled = true; };
        }
        if (!isRemoteResource) {
            setUrl(isLazyVisual && !eager ? "" : fallback);
            setLoading(false);
            return;
        }
        if (!eager && isLazyVisual) {
            setUrl("");
            setLoading(false);
            return;
        }
        const reload = reloadRequested.current;
        reloadRequested.current = false;
        const cachedSync = reload || !eager ? "" : peekCachedResourceObjectUrl(storageKey, previewSize);
        if (cachedSync) {
            setUrl(cachedSync);
            setLoading(false);
            return;
        }
        if (!isLazyVisual || sourceChanged || reload) setUrl("");
        setLoading(eager);
        const resolve = previewSize
            ? eager ? cacheResourceImagePreviewObjectUrl(storageKey, previewSize, reload) : Promise.resolve("")
            : eager ? cacheResourceObjectUrl(storageKey, reload) : getCachedResourceObjectUrl(storageKey);
        void resolve.then((cached) => {
            if (!cancelled && cached) { setUrl(cached); setError(false); }
            if (!cancelled && eager && !cached) { setError(true); reportImageEvent("CANVAS_IMAGE_READ_FAILED"); }
        }).catch(() => {
            if (!cancelled && eager) { setUrl(synchronousUrl); setError(true); reportImageEvent("CANVAS_IMAGE_READ_FAILED"); }
        }).finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => { cancelled = true; };
    }, [eager, fallback, isLazyVisual, isRemoteResource, resourceId, storageKey, attempt, reportImageEvent, previewSize, useDirectSameOriginPreview, synchronousUrl]);

    return { url, loading, error, retry, fail };
}
