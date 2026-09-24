import { configureApiRuntime } from "@/services/api/request";

export type DesktopRuntimeConfig = {
    baseURL: string;
    launchToken: string;
};

export type DesktopExportResult = {
    canceled: boolean;
    path: string;
};

type DesktopRuntimeBinding = {
    RuntimeConfig: () => Promise<DesktopRuntimeConfig>;
    ExportResource?: (resourceId: string, fileName: string) => Promise<DesktopExportResult>;
};

declare global {
    interface Window {
        go?: {
            main?: {
                DesktopApp?: DesktopRuntimeBinding;
            };
        };
    }
}

let nativeFetch: typeof fetch | undefined;

function isDesktopRuntimeConfig(value: unknown): value is DesktopRuntimeConfig {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<DesktopRuntimeConfig>;
    return /^http:\/\/127\.0\.0\.1:\d+\/api$/u.test(candidate.baseURL ?? "") && Boolean(candidate.launchToken);
}

export function configureDesktopRuntime(config: DesktopRuntimeConfig) {
    const baseURL = config.baseURL.replace(/\/+$/u, "");
    configureApiRuntime(baseURL, config.launchToken);
    if (!nativeFetch) nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url === baseURL || request.url.startsWith(`${baseURL}/`)) {
            const headers = new Headers(request.headers);
            headers.set("X-Desktop-Token", config.launchToken);
            return nativeFetch!(new Request(request, { headers }));
        }
        return nativeFetch!(request);
    }) as typeof fetch;
}

export async function bootstrapDesktopRuntime() {
    const binding = window.go?.main?.DesktopApp;
    let config: DesktopRuntimeConfig | undefined;
    if (binding) {
        try {
            const candidate = await binding.RuntimeConfig();
            if (isDesktopRuntimeConfig(candidate)) config = candidate;
        } catch {
            // Wails can expose the WebView before generated bindings settle.
        }
    }
    if (!config && window.location?.protocol === "wails:") {
        const response = await fetch("/__desktop/runtime-config", { cache: "no-store" });
        if (!response.ok) throw new Error(`Desktop runtime bootstrap failed: ${response.status}`);
        const candidate = await response.json();
        if (isDesktopRuntimeConfig(candidate)) config = candidate;
    }
    if (!config) return false;
    configureDesktopRuntime(config);
    return true;
}

export function desktopResourceExporter() {
    const binding = typeof window === "undefined" ? undefined : window.go?.main?.DesktopApp;
    if (!binding?.ExportResource) return undefined;
    return (resourceId: string, fileName: string) => binding.ExportResource!(resourceId, fileName);
}
