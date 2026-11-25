export function peekCachedResourceObjectUrl() {
    return "";
}

export function cacheResourceObjectUrl(storageKey: string, forceRefresh?: boolean) {
    const win = window as unknown as {
        __angleFallbackCalls?: Array<{ storageKey: string; forceRefresh?: boolean }>;
        __angleFallbackUrl?: string;
    };
    win.__angleFallbackCalls = win.__angleFallbackCalls || [];
    win.__angleFallbackCalls.push({ storageKey, forceRefresh });
    return Promise.resolve(win.__angleFallbackUrl ?? "");
}
