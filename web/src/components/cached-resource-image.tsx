import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode, type RefObject } from "react";

import { isProtectedResourceFileUrl, ownedResourceStorageKey, resourceIdFromStorageKey } from "@/services/api/resources";
import { canUseSameOriginResourceAsset, resourcePreviewAssetUrl } from "@/services/media-asset-url";
import { cacheResourceImagePreviewObjectUrl, cacheResourceObjectUrl, peekCachedResourceObjectUrl } from "@/services/resource-blob-cache";
import { resolveImageUrl } from "@/services/image-storage";

type CachedResourceImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
    storageKey?: string;
    src?: string;
    previewSize?: 128 | 256 | 512 | 1024 | 2048;
    observerRootRef?: RefObject<HTMLElement | null>;
    fallback?: ReactNode;
    loadingFallback?: ReactNode;
    eager?: boolean;
    onLoadError?: () => void;
};

/**
 * 资源图片优先读取按用户隔离的本地 Blob 缓存，避免刷新后再次从对象存储下载。
 * 任意本地图片 storageKey 都会自动从 LocalForage 恢复有效的 Object URL。
 */
export function CachedResourceImage({ storageKey: rawStorageKey, src = "", previewSize, observerRootRef, fallback = null, loadingFallback = fallback, eager = false, onError, onLoadError, ...props }: CachedResourceImageProps) {
    const onLoadErrorRef = useRef(onLoadError);
    onLoadErrorRef.current = onLoadError;
    const storageKey = ownedResourceStorageKey(rawStorageKey, src);
    const safeFallbackSrc = isProtectedResourceFileUrl(src) ? "" : src;
    const remoteResource = Boolean(resourceIdFromStorageKey(storageKey));
    const localImageResource = Boolean(storageKey && !remoteResource);
    const storageBackedImage = remoteResource || localImageResource;
    const targetRef = useRef<HTMLSpanElement>(null);
    const resourceId = remoteResource && storageKey ? resourceIdFromStorageKey(storageKey) : "";
    const directDesktopAsset = Boolean(resourceId && canUseSameOriginResourceAsset());
    const syncPreviewUrl = remoteResource && storageKey && !directDesktopAsset
        ? peekCachedResourceObjectUrl(storageKey, previewSize)
        : "";
    const initialDirectUrl = eager && directDesktopAsset ? resourcePreviewAssetUrl(resourceId, previewSize) : "";
    const [nearViewport, setNearViewport] = useState(eager || !remoteResource || Boolean(syncPreviewUrl));
    const [cachedSrc, setCachedSrc] = useState(initialDirectUrl || syncPreviewUrl || (storageBackedImage ? "" : safeFallbackSrc));
    const [cacheFailed, setCacheFailed] = useState(false);

    useEffect(() => {
        if (!remoteResource || eager) {
            setNearViewport(true);
            return;
        }
        const image = targetRef.current;
        if (!image || typeof IntersectionObserver === "undefined") {
            setNearViewport(true);
            return;
        }
        let zoomWaitTimer: ReturnType<typeof setTimeout> | null = null;
        const rootEl = observerRootRef?.current ?? null;
        const observer = new IntersectionObserver(
            (entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return;
                if (image.closest('[data-canvas-viewport-zooming="true"]')) {
                    if (!zoomWaitTimer) {
                        const retryWhenZoomIdle = () => {
                            zoomWaitTimer = null;
                            if (!image.isConnected) return;
                            if (image.closest('[data-canvas-viewport-zooming="true"]')) {
                                zoomWaitTimer = setTimeout(retryWhenZoomIdle, 80);
                                return;
                            }
                            observer.unobserve(image);
                            observer.observe(image);
                        };
                        zoomWaitTimer = setTimeout(retryWhenZoomIdle, 80);
                    }
                    return;
                }
                setNearViewport(true);
                observer.disconnect();
            },
            { root: rootEl, rootMargin: rootEl ? "120px" : "240px" },
        );
        observer.observe(image);
        return () => {
            if (zoomWaitTimer) clearTimeout(zoomWaitTimer);
            observer.disconnect();
        };
    }, [eager, observerRootRef, remoteResource]);

    useEffect(() => {
        let cancelled = false;
        setCacheFailed(false);

        if (remoteResource && storageKey) {
            if (canUseSameOriginResourceAsset()) {
                if (!nearViewport) {
                    setCachedSrc("");
                    return () => {
                        cancelled = true;
                    };
                }
                const resourceId = resourceIdFromStorageKey(storageKey);
                setCachedSrc(resourcePreviewAssetUrl(resourceId, previewSize));
                return () => {
                    cancelled = true;
                };
            }
            const syncHit = peekCachedResourceObjectUrl(storageKey, previewSize);
            if (syncHit) {
                setCachedSrc(syncHit);
                return () => {
                    cancelled = true;
                };
            }
            if (!nearViewport) {
                setCachedSrc("");
                return () => {
                    cancelled = true;
                };
            }
            setCachedSrc("");
            const resolve = previewSize
                ? cacheResourceImagePreviewObjectUrl(storageKey, previewSize)
                : cacheResourceObjectUrl(storageKey);
            void resolve
                .then((url) => {
                    if (!cancelled) {
                        const resolved = url || safeFallbackSrc;
                        setCachedSrc(resolved);
                        setCacheFailed(!resolved);
                        if (!resolved) onLoadErrorRef.current?.();
                    }
                })
                .catch(() => {
                    if (!cancelled) {
                        // 非受保护原始地址仍允许尝试加载；受保护资源地址不能直接交给原生 <img>。
                        setCacheFailed(!safeFallbackSrc);
                        setCachedSrc(safeFallbackSrc);
                        if (!safeFallbackSrc) onLoadErrorRef.current?.();
                    }
                });
            return () => {
                cancelled = true;
            };
        }

        if (localImageResource && storageKey) {
            setCachedSrc("");
            void resolveImageUrl(storageKey, safeFallbackSrc, { renderable: true })
                .then((url) => {
                    if (!cancelled) {
                        const resolved = url || safeFallbackSrc;
                        setCachedSrc(resolved);
                        setCacheFailed(!resolved);
                        if (!resolved) onLoadErrorRef.current?.();
                    }
                })
                .catch(() => {
                    if (!cancelled) {
                        setCacheFailed(!safeFallbackSrc);
                        setCachedSrc(safeFallbackSrc);
                        if (!safeFallbackSrc) onLoadErrorRef.current?.();
                    }
                });
            return () => {
                cancelled = true;
            };
        }

        setCachedSrc(safeFallbackSrc);
        return () => {
            cancelled = true;
        };
    }, [localImageResource, nearViewport, previewSize, remoteResource, safeFallbackSrc, storageKey]);

    const handleImgError = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
        if (localImageResource && storageKey && cachedSrc.startsWith("blob:")) {
            void resolveImageUrl(storageKey, "", { renderable: true })
                .then((url) => {
                    if (url && url !== cachedSrc) {
                        setCachedSrc(url);
                        return;
                    }
                    setCacheFailed(true);
                    onError?.(e);
                    onLoadErrorRef.current?.();
                })
                .catch(() => {
                    setCacheFailed(true);
                    onError?.(e);
                    onLoadErrorRef.current?.();
                });
            return;
        }
        setCacheFailed(true);
        onError?.(e);
        onLoadErrorRef.current?.();
    };

    if (!storageBackedImage) {
        if (cacheFailed && fallback) return <>{fallback}</>;
        return <img {...props} src={cachedSrc} onError={handleImgError} />;
    }
    return (
        <span ref={targetRef} className="cached-resource-image-shell">
            {cachedSrc && !cacheFailed ? <img {...props} src={cachedSrc} onError={handleImgError} /> : cacheFailed ? fallback : loadingFallback}
        </span>
    );
}
