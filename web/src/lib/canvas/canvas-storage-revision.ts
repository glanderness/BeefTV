import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { normalizeAssetCategory } from "@/lib/asset-category";
import { normalizeCanvasProjectGraph, sameCanvasDocument } from "@/lib/canvas/canvas-content";

export type CanvasStorageDocument = {
    state: { projects: CanvasProject[] };
    version: number;
    storageRevision: number;
    deletedProjectIds?: Record<string, number>;
};

function parseDeletedProjectIds(raw: unknown): Record<string, number> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const result: Record<string, number> = {};
    for (const [id, revision] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof revision === "number" && Number.isFinite(revision) && revision > 0) {
            result[id] = revision;
        }
    }
    return result;
}

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
            state: { projects: fallback.filter((project) => !project.summaryOnly).map(normalizeStoredProject) },
            version: 0,
            storageRevision: 0,
            deletedProjectIds: {},
        };
    }
    const parsed = JSON.parse(value) as {
        state?: { projects?: unknown };
        version?: unknown;
        storageRevision?: unknown;
        deletedProjectIds?: unknown;
        tombstones?: { projects?: unknown };
    };
    if (!Array.isArray(parsed.state?.projects)) throw new Error("画布持久状态无效");
    return {
        state: { projects: (parsed.state.projects as CanvasProject[]).filter((project) => !project?.summaryOnly).map(normalizeStoredProject) },
        version: typeof parsed.version === "number" ? parsed.version : 0,
        storageRevision: typeof parsed.storageRevision === "number" && Number.isFinite(parsed.storageRevision) ? parsed.storageRevision : 0,
        deletedProjectIds: parseDeletedProjectIds(parsed.deletedProjectIds ?? parsed.tombstones?.projects),
    };
}

function viewPreferencesChanged(local: CanvasProject, base: CanvasProject) {
    return JSON.stringify(local.viewport) !== JSON.stringify(base.viewport)
        || JSON.stringify(local.appearance) !== JSON.stringify(base.appearance)
        || local.backgroundMode !== base.backgroundMode
        || local.showImageInfo !== base.showImageInfo;
}

/**
 * Project-level cross-tab merge for non-desktop browser IndexedDB cache writes:
 * - Preserves concurrent edits made to other canvases in another tab.
 * - Preserves another tab's document edits on the same canvas when this tab only changed view preferences.
 * - Preserves canvases newly created in another tab.
 * - Prevents stale tabs from resurrecting canvases deleted in another tab.
 */
export function mergeCanvasStorageProjects(input: {
    durable: CanvasStorageDocument;
    baseProjects: CanvasProject[];
    localProjects: CanvasProject[];
    baseRevision: number;
    ignoredDeletedIds?: ReadonlySet<string>;
}): { document: CanvasStorageDocument; droppedDeletedIds: string[] } {
    const nextRevision = Math.max(input.durable.storageRevision, input.baseRevision) + 1;
    const deletedProjectIds: Record<string, number> = { ...(input.durable.deletedProjectIds ?? {}) };
    const baseById = new Map(input.baseProjects.map((project) => [project.id, project]));
    const localById = new Map(input.localProjects.map((project) => [project.id, project]));
    const durableById = new Map(input.durable.state.projects.map((project) => [project.id, project]));

    for (const id of baseById.keys()) {
        if (!localById.has(id)) {
            deletedProjectIds[id] = nextRevision;
        }
    }
    for (const id of localById.keys()) {
        if (!baseById.has(id) && !input.ignoredDeletedIds?.has(id)) {
            delete deletedProjectIds[id];
        }
    }

    const projects: CanvasProject[] = [];
    const seen = new Set<string>();
    const droppedDeletedIds: string[] = [];
    for (const local of input.localProjects) {
        const base = baseById.get(local.id);
        const durable = durableById.get(local.id);
        const deletedAt = deletedProjectIds[local.id] ?? 0;
        if (deletedAt > 0 && (input.ignoredDeletedIds?.has(local.id) || (base && deletedAt > input.baseRevision))) {
            droppedDeletedIds.push(local.id);
            continue;
        }
        seen.add(local.id);
        if (local.summaryOnly) {
            if (durable && !durable.summaryOnly) {
                projects.push(durable);
            }
            continue;
        }
        if (base && durable && sameCanvasDocument(local, base)) {
            projects.push(viewPreferencesChanged(local, base)
                ? {
                    ...durable,
                    viewport: local.viewport,
                    appearance: local.appearance,
                    backgroundMode: local.backgroundMode,
                    showImageInfo: local.showImageInfo,
                }
                : durable);
            continue;
        }
        projects.push(local);
    }
    for (const durable of input.durable.state.projects) {
        if (seen.has(durable.id) || baseById.has(durable.id)) continue;
        if ((deletedProjectIds[durable.id] ?? 0) >= nextRevision) continue;
        projects.push(durable);
    }

    return {
        document: {
            state: { projects },
            version: input.durable.version,
            storageRevision: nextRevision,
            deletedProjectIds,
        },
        droppedDeletedIds,
    };
}

export function serializeCanvasStorageDocument(document: CanvasStorageDocument) {
    return JSON.stringify(document);
}
