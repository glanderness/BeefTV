export function resolveMediaUrl(storageKey?: string, fallback = "") {
    const win = window as unknown as {
        __angleMediaCalls?: Array<{ storageKey?: string; fallback: string }>;
        __resolveAngleMedia?: (url: string) => void;
    };
    win.__angleMediaCalls = win.__angleMediaCalls || [];
    win.__angleMediaCalls.push({ storageKey, fallback });
    return new Promise<string>((resolveUrl) => {
        win.__resolveAngleMedia = resolveUrl;
    });
}
