import { apiBaseURL, apiClient, http } from "@/services/api/request";

export type HubUser = { id: number; username: string; display_name: string; group: string; quota: number; used_quota: number };
export type HubSession = { enabled: boolean; authenticated: boolean; session?: string; scope?: string; user?: HubUser; groups?: Record<string, { desc: string; ratio: number }> };
export type HubModel = { id: string; model_type?: string; supported_endpoint_types?: string[] };
export type UsagePage = { page: number; page_size: number; total: number; items: Array<{ id: number; created_at: number; model_name: string; quota: number; group: string; prompt_tokens: number; completion_tokens: number }> };

const prefix = "/integrations/aihubkit/";
let session = "";
export function setHubSession(value?: string) { session = value || ""; }
export function hubSessionHeaders(): Record<string, string> { return session ? { "X-Aihubkit-Session": session } : {}; }

export function isBackendURL(value: string, baseURL: string, locationURL: string): boolean {
    const base = new URL(baseURL.replace(/\/$/u, "") + "/", locationURL);
    const target = new URL(value, locationURL);
    return target.origin === base.origin && target.pathname.startsWith(base.pathname);
}

// This uses the official business client. The session stays in memory and is
// attached only to this backend; remote inference/storage credentials never
// reach the browser.
apiClient.interceptors.request.use((config) => {
    if (session && isBackendURL(apiClient.getUri(config), apiBaseURL, window.location.href)) config.headers.set("X-Aihubkit-Session", session);
    return config;
});

if (typeof window !== "undefined") {
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
        const request = new Request(input instanceof Request ? input : new URL(String(input), window.location.href), init);
        if (session && isBackendURL(request.url, apiBaseURL, window.location.href)) {
            const headers = new Headers(request.headers);
            headers.set("X-Aihubkit-Session", session);
            return originalFetch(new Request(request, { headers }));
        }
        return originalFetch(request);
    };
}

export const hub = {
    session: () => http.get<HubSession>(prefix + "session"),
    login: (username: string, password: string) => http.post<HubSession>(prefix + "login", { username, password }, { timeout: 120_000, headers: { "X-Aihubkit-Client": "1" } }),
    register: (values: { username: string; password: string; email: string; verification_code?: string; aff_code?: string }) => http.post<boolean>(prefix + "register", values, { timeout: 60_000, headers: { "X-Aihubkit-Client": "1" } }),
    verification: (email: string) => http.post<boolean>(prefix + "verification", { email }, { timeout: 60_000, headers: { "X-Aihubkit-Client": "1" } }),
    self: () => http.get<HubUser>(prefix + "self", { timeout: 60_000 }),
    catalog: (group: string) => http.post<HubModel[]>(prefix + "catalog", { group }, { timeout: 60_000 }),
    logs: (page = 1) => http.get<UsagePage>(prefix + "logs", { params: { p: page, page_size: 10 }, timeout: 60_000 }),
    topup: (key: string) => http.post(prefix + "topup", { key }, { timeout: 60_000 }),
    logout: () => http.post(prefix + "logout", {}, { timeout: 660_000 }),
};
