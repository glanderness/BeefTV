import { saveAs } from "file-saver";
import { nanoid } from "nanoid";

import { sanitizeDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { isDesktopShellOrigin } from "@/lib/desktop-shell";
import { getResourceBlob, ownedResourceIdFromMediaRef, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";

export type OwnedMediaSaveResult = "saved" | "cancelled";

export type DiagnosticBundleSaveOutcome = {
    status: OwnedMediaSaveResult;
    savedPath: string;
};

export const MAX_OWNED_ARTIFACT_BYTES = 32 * 1024 * 1024;

export function isWailsNativeShell() {
    if (typeof window === "undefined") return false;
    return (
        isDesktopShellOrigin(window.location) ||
        typeof window.go?.main?.DesktopApp?.SaveDiagnosticBundle === "function" ||
        typeof window.go?.main?.DesktopApp?.SaveOwnedMedia === "function" ||
        typeof window.go?.main?.DesktopApp?.SaveOwnedMediaBatch === "function" ||
        typeof window.go?.main?.DesktopApp?.ChooseOwnedMediaBatchDirectory === "function" ||
        typeof window.go?.main?.DesktopApp?.SaveAutoDownloadedMedia === "function" ||
        typeof window.go?.main?.DesktopApp?.SaveOwnedArtifact === "function"
    );
}

/**
 * Single-source allowlist check for direct browser `<a download>` / `saveAs(url)` calls.
 * Never allows protected owned resource endpoints, local/loopback/private-LAN hosts,
 * or non-blob/data raw URLs inside the Wails desktop WebView (which can navigate the app).
 */
export function isSafeExternalFetchUrl(rawUrl: string): boolean {
    const trimmed = rawUrl.trim();
    if (!trimmed) return false;
    if (/^(?:blob:|data:)/i.test(trimmed)) return true;
    if (trimmed.startsWith("resource:")) return false;
    if (ownedResourceIdFromMediaRef(undefined, trimmed)) return false;

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
    }
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.+$/u, "");
    return Boolean(hostname && !isLocalOrPrivateHost(hostname));
}

export function isSafeDirectBrowserDownloadUrl(rawUrl: string): boolean {
    const trimmed = rawUrl.trim();
    if (!trimmed) return false;
    if (/^(?:blob:|data:)/i.test(trimmed)) return true;
    if (trimmed.startsWith("resource:")) return false;
    if (ownedResourceIdFromMediaRef(undefined, trimmed)) return false;
    if (isWailsNativeShell()) return false;

    if (trimmed.startsWith("/")) {
        // Reject scheme-relative (`//`), backslash-normalized (`/\host`), and control/tab bypasses (`/\t/host`).
        if (trimmed.startsWith("//") || trimmed.includes("\\") || /[\t\r\n]/u.test(trimmed)) {
            return false;
        }
        const baseHref =
            typeof window !== "undefined" && typeof window.location?.href === "string" && /^https?:\/\//i.test(window.location.href)
                ? window.location.href
                : "https://beeftv.invalid/";
        try {
            const base = new URL(baseHref);
            const resolved = new URL(trimmed, base);
            if (resolved.origin !== base.origin) return false;
            if (ownedResourceIdFromMediaRef(undefined, resolved.pathname)) return false;
            return true;
        } catch {
            return false;
        }
    }
    return isSafeExternalFetchUrl(trimmed);
}

function isLocalOrPrivateHost(rawHostname: string): boolean {
    const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.+$/u, "");
    if (!hostname) return true;
    if (
        hostname === "localhost"
        || hostname === "wails.localhost"
        || hostname.endsWith(".localhost")
        || hostname.endsWith(".local")
        || hostname === "::1"
        || hostname === "::"
        || hostname === "0:0:0:0:0:0:0:1"
        || hostname === "0:0:0:0:0:0:0:0"
    ) {
        return true;
    }
    // IPv4-mapped IPv6 addresses such as ::ffff:127.0.0.1 or ::ffff:7f00:1
    const ipv4MappedDotted = hostname.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
    if (ipv4MappedDotted) {
        return isLocalOrPrivateIpv4(ipv4MappedDotted[1]);
    }
    const ipv4MappedHex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
    if (ipv4MappedHex) {
        const hi = Number.parseInt(ipv4MappedHex[1], 16);
        const lo = Number.parseInt(ipv4MappedHex[2], 16);
        return isLocalOrPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    if (/^(?:fc|fd|fe[89ab])/u.test(hostname) && hostname.includes(":")) {
        return true;
    }
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) {
        return isLocalOrPrivateIpv4(hostname);
    }
    return false;
}

function isLocalOrPrivateIpv4(ip: string): boolean {
    const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
        return true;
    }
    const [a, b] = parts;
    return (
        a === 0
        || a === 127
        || a === 10
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127)
    );
}

/**
 * Safe browser-side single-file download used by both hosted single-save and silent auto-download.
 * Owned resources always go through authenticated blob fetch so raw loopback/API URLs never
 * reach `<a download>` or `file-saver`.
 */
export async function downloadBrowserMediaSafely(options: {
    fileName: string;
    resourceId?: string;
    browserUrl?: string;
    loadResourceBlob?: (storageKey: string) => Promise<Blob | null>;
}): Promise<"saved"> {
    const fileName = sanitizeDownloadFileName(options.fileName);
    const browserUrl = options.browserUrl?.trim() || "";
    const resourceId = options.resourceId?.trim() || ownedResourceIdFromMediaRef(undefined, browserUrl);
    if (resourceId) {
        const loadBlob = options.loadResourceBlob ?? getResourceBlob;
        const blob = await loadBlob(resourceStorageKey(resourceId));
        if (!blob) throw new Error("无法读取可下载的本地文件");
        saveAs(blob, fileName);
        return "saved";
    }
    if (!browserUrl) throw new Error("没有可导出的文件");
    if (!isSafeDirectBrowserDownloadUrl(browserUrl)) {
        throw new Error("当前链接无法直接下载，请先保存到本地素材库后再导出");
    }
    saveAs(browserUrl, fileName);
    return "saved";
}

/**
 * Silent auto-download entry point: uses native Go disk streaming in desktop
 * shells (avoiding WKWebView broken `saveAs(blob)` and base64 memory bloat),
 * falling back to browser download when running on hosted web.
 */
export async function saveAutoDownloadedMedia(options: {
    fileName: string;
    resourceId?: string;
    browserUrl?: string;
    projectName?: string;
    loadResourceBlob?: (storageKey: string) => Promise<Blob | null>;
}): Promise<"saved"> {
    const fileName = sanitizeDownloadFileName(options.fileName);
    const browserUrl = options.browserUrl?.trim() || "";
    const resourceId = options.resourceId?.trim() || ownedResourceIdFromMediaRef(undefined, browserUrl);
    if (isWailsNativeShell()) {
        const nativeSave = typeof window === "undefined" ? undefined : window.go?.main?.DesktopApp?.SaveAutoDownloadedMedia;
        if (!nativeSave) throw new Error("当前桌面端暂不支持原生自动下载");
        if (!resourceId) throw new Error("没有可自动保存的本机文件");
        await nativeSave(fileName, resourceId, options.projectName?.trim() || "");
        return "saved";
    }
    return downloadBrowserMediaSafely({ ...options, fileName, resourceId, browserUrl });
}

export async function downloadOwnedOrBrowserMedia(options: { fileName: string; resourceId?: string; browserUrl?: string }): Promise<OwnedMediaSaveResult> {
    const fileName = sanitizeDownloadFileName(options.fileName);
    if (isWailsNativeShell()) {
        const resourceId = options.resourceId?.trim() || ownedResourceIdFromMediaRef(undefined, options.browserUrl);
        if (!resourceId) throw new Error("没有可导出的本机文件");
        const save = window.go?.main?.DesktopApp?.SaveOwnedMedia;
        if (!save) throw new Error("当前应用还不能把文件存到所选位置");
        const saved = await save(fileName, resourceId);
        return saved ? "saved" : "cancelled";
    }
    return downloadBrowserMediaSafely({ ...options, fileName });
}

export async function saveOwnedOrBrowserBlob(fileName: string, blob: Blob): Promise<OwnedMediaSaveResult> {
    const name = sanitizeDownloadFileName(fileName, "未命名导出");
    if (isWailsNativeShell()) {
        if (blob.size > MAX_OWNED_ARTIFACT_BYTES) throw new Error("导出包太大，请减少所选内容后再导出");
        const save = window.go?.main?.DesktopApp?.SaveOwnedArtifact;
        if (!save) throw new Error("当前应用还不能把文件存到所选位置");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const saved = await save(name, bytesToBase64(bytes));
        return saved ? "saved" : "cancelled";
    }
    saveAs(blob, name);
    return "saved";
}

export async function saveDiagnosticBundleBlob(fileName: string, blob: Blob): Promise<DiagnosticBundleSaveOutcome> {
    const name = sanitizeDownloadFileName(fileName, "beeftv-diagnostics.zip");
    if (isWailsNativeShell()) {
        if (blob.size > MAX_OWNED_ARTIFACT_BYTES) throw new Error("导出包太大，请减少所选内容后再导出");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const encoded = bytesToBase64(bytes);
        const saveDiagnostic = window.go?.main?.DesktopApp?.SaveDiagnosticBundle;
        if (typeof saveDiagnostic === "function") {
            const savedPath = await saveDiagnostic(name, encoded);
            if (!savedPath) return { status: "cancelled", savedPath: "" };
            return { status: "saved", savedPath };
        }
        const saveArtifact = window.go?.main?.DesktopApp?.SaveOwnedArtifact;
        if (!saveArtifact) throw new Error("当前应用还不能把文件存到所选位置");
        const saved = await saveArtifact(name, encoded);
        return { status: saved ? "saved" : "cancelled", savedPath: "" };
    }
    saveAs(blob, name);
    return { status: "saved", savedPath: "" };
}

/** Video exports use the resource upload path so large files never cross Wails as base64. */
export async function saveOwnedOrBrowserVideoBlob(fileName: string, blob: Blob): Promise<OwnedMediaSaveResult> {
    if (!isWailsNativeShell()) return saveOwnedOrBrowserBlob(fileName, blob);
    if (!window.go?.main?.DesktopApp?.SaveOwnedMedia) throw new Error("当前应用还不能把文件存到所选位置");
    const name = sanitizeDownloadFileName(fileName, "未命名导出.mp4");
    const resource = await uploadResourceFile(blob, "video", {
        fileName: name,
        idempotencyKey: `video-export:${nanoid()}`,
    });
    return downloadOwnedOrBrowserMedia({ fileName: name, resourceId: resource.id });
}

export async function saveOwnedNativeArchiveFiles(
    fileName: string,
    files: Array<{ name: string; data: BlobPart; resourceId?: string }>,
    options: { signal?: AbortSignal; onSaving?: () => void } = {},
): Promise<OwnedMediaSaveResult | undefined> {
    const save = typeof window === "undefined" ? undefined : window.go?.main?.DesktopApp?.SaveOwnedArchive;
    if (!save) return undefined;
    const entries: Array<{ name: string; resourceId?: string; data?: string }> = [];
    let inlineBytes = 0;
    for (const file of files) {
        options.signal?.throwIfAborted();
        if (file.resourceId) {
            entries.push({ name: file.name, resourceId: file.resourceId });
        } else {
            const blob = new Blob([file.data]);
            inlineBytes += blob.size;
            if (inlineBytes > MAX_OWNED_ARTIFACT_BYTES) throw new Error("本地附加文件过大，请先保存素材后再导出");
            entries.push({ name: file.name, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) });
        }
    }
    options.signal?.throwIfAborted();
    options.onSaving?.();
    return await save(sanitizeDownloadFileName(fileName, "画布.zip"), entries) ? "saved" : "cancelled";
}

export type NativeMediaBatchFailure = {
    fileName: string;
    reason: string;
};

export type NativeMediaBatchSaveOutcome = {
    saved: number;
    failed: number;
    cancelled?: boolean;
    failures?: NativeMediaBatchFailure[];
};

export async function chooseOwnedNativeMediaBatchDirectory(): Promise<string | undefined> {
    const choose = typeof window === "undefined" ? undefined : window.go?.main?.DesktopApp?.ChooseOwnedMediaBatchDirectory;
    if (!choose) return undefined;
    return choose();
}

export async function saveOwnedNativeMediaBatch(
    items: Array<{ fileName: string; resourceId?: string; blob?: Blob }>,
    dirToken = "",
): Promise<NativeMediaBatchSaveOutcome | undefined> {
    const save = typeof window === "undefined" ? undefined : window.go?.main?.DesktopApp?.SaveOwnedMediaBatch;
    if (!save) return undefined;
    const entries: Array<{ fileName: string; resourceId?: string; data?: string }> = [];
    const preFailures: NativeMediaBatchFailure[] = [];
    let inlineBytes = 0;
    for (const item of items) {
        const fileName = sanitizeDownloadFileName(item.fileName);
        const resourceId = item.resourceId?.trim();
        if (resourceId) {
            entries.push({ fileName, resourceId });
            continue;
        }
        if (!item.blob || item.blob.size === 0) {
            preFailures.push({ fileName, reason: "缺少可保存的本地内容" });
            continue;
        }
        if (inlineBytes + item.blob.size > MAX_OWNED_ARTIFACT_BYTES) {
            preFailures.push({ fileName, reason: "超过 32MB 批量限制，请单独打开保存" });
            continue;
        }
        inlineBytes += item.blob.size;
        entries.push({ fileName, data: bytesToBase64(new Uint8Array(await item.blob.arrayBuffer())) });
    }
    if (entries.length === 0) {
        return { saved: 0, failed: preFailures.length, failures: preFailures };
    }
    const result = await save(entries, dirToken);
    if (result?.cancelled) {
        return { saved: 0, failed: 0, cancelled: true };
    }
    const failures = [...preFailures, ...(result?.failures ?? [])];
    return {
        saved: result?.saved ?? 0,
        failed: preFailures.length + (result?.failed ?? 0),
        cancelled: false,
        ...(failures.length > 0 ? { failures } : {}),
    };
}

function bytesToBase64(bytes: Uint8Array) {
    const toBase64 = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
    if (typeof toBase64 === "function") return toBase64.call(bytes);
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

export function reportOwnedMediaSave(message: { success: (text: string) => void; error: (text: string) => void }, result: Promise<OwnedMediaSaveResult>) {
    return result
        .then((status) => {
            if (status === "saved" && isWailsNativeShell()) message.success("已保存到所选位置");
        })
        .catch((error) => {
            message.error(error instanceof Error && error.message.trim() ? error.message : "保存没有完成，请再试一次");
        });
}
