import { canonicalize } from "json-canonicalize";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

// These fields describe local viewing / synchronization, not an edit to the document.
export function canvasContentSnapshot(project: CanvasProject) {
    const { viewport: _viewport, updatedAt: _updatedAt, revision: _revision, remoteContentHash: _hash, ...content } = project;
    return { ...content, projectId: content.projectId || undefined };
}

export function sameCanvasContent(left: CanvasProject | undefined, right: CanvasProject | undefined) {
    if (left === right) return true;
    if (!left || !right) return false;
    const a = canvasContentSnapshot(left) as Record<string, unknown>;
    const b = canvasContentSnapshot(right) as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => a[key] === b[key] || canonicalize(a[key]) === canonicalize(b[key]));
}

export async function canvasContentHash(project: CanvasProject) {
    const serialized = canonicalize(canvasContentSnapshot(project));
    // LAN HTTP deployments may lack Web Crypto. Keep an exact baseline there;
    // a lossy checksum could incorrectly discard an unsaved draft during login.
    if (!globalThis.crypto?.subtle) return `json:${serialized}`;
    const bytes = new TextEncoder().encode(serialized);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

/** 画布文档字段：只有这些字段代表「这份画布的内容」。 */
const CANVAS_DOCUMENT_KEYS = ["title", "nodes", "connections", "chatSessions", "activeChatId", "timeline", "directorScenes"] as const;

/**
 * 只比较画布文档内容，忽略本机查看偏好（外观、背景、图片信息）。
 *
 * 服务端只持久化文档，外部写入（内置助手、CLI/MCP）返回的画布通常没有本地
 * 偏好字段；若按整份内容比较，每一次外部刷新都会被误判成「本地有未确认编辑」，
 * 从而把服务端已经落地的改动永远挡在外面。
 */
export function sameCanvasDocument(left: CanvasProject | undefined, right: CanvasProject | undefined) {
    if (left === right) return true;
    if (!left || !right) return false;
    const a = left as unknown as Record<string, unknown>;
    const b = right as unknown as Record<string, unknown>;
    return CANVAS_DOCUMENT_KEYS.every((key) => a[key] === b[key] || canonicalize(a[key]) === canonicalize(b[key]));
}
