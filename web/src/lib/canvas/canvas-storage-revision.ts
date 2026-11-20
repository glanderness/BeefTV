import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { normalizeAssetCategory } from "@/lib/asset-category";
import { normalizeCanvasProjectGraph } from "@/lib/canvas/canvas-content";

export type CanvasStorageDocument = {
    state: { projects: CanvasProject[] };
    version: number;
    storageRevision: number;
};

function normalizeStoredProject(rawProject: CanvasProject): CanvasProject {
    const project = normalizeCanvasProjectGraph(rawProject);
    const sessions = Array.isArray(project.chatSessions) ? project.chatSessions : [];
    let changed = project !== rawProject || sessions !== project.chatSessions;
    const nodes = project.nodes.map((node) => {
        const category = node.metadata?.assetCategory;
        if (!category) return node;
        const normalized = normalizeAssetCategory(category);
        if (normalized === category) return node;
        changed = true;
        return { ...node, metadata: { ...node.metadata, assetCategory: normalized } };
    });
    const chatSessions = sessions.map((session) => {
        if (Array.isArray(session.messages)) return session;
        changed = true;
        return { ...session, messages: [] };
    });
    return changed ? { ...project, nodes, chatSessions } : rawProject;
}

export function parseCanvasStorageDocument(value: string | null, fallback: CanvasProject[] = []): CanvasStorageDocument {
    if (!value) {
        return {
            state: { projects: fallback.map(normalizeStoredProject) },
            version: 0,
            storageRevision: 0,
        };
    }
    const parsed = JSON.parse(value) as {
        state?: { projects?: unknown };
        version?: unknown;
        storageRevision?: unknown;
    };
    if (!Array.isArray(parsed.state?.projects)) throw new Error("画布持久状态无效");
    return {
        state: { projects: (parsed.state.projects as CanvasProject[]).map(normalizeStoredProject) },
        version: typeof parsed.version === "number" ? parsed.version : 0,
        storageRevision: typeof parsed.storageRevision === "number" && Number.isFinite(parsed.storageRevision) ? parsed.storageRevision : 0,
    };
}

export function serializeCanvasStorageDocument(document: CanvasStorageDocument) {
    return JSON.stringify(document);
}
