export type ReferenceLinkRequest = { key: string; label: string; name?: string };
export type ResolveReferenceLinks = (references: ReferenceLinkRequest[], signal?: AbortSignal) => Promise<Record<string, string> | null>;

export function isReferenceHTTPSLink(value: string): boolean {
    try {
        const url = new URL(value.trim());
        return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
    } catch {
        return false;
    }
}
