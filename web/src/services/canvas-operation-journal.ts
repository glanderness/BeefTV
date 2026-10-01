import { nanoid } from "nanoid";

import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { recordCanvasDocumentBase, type CanvasProject } from "@/stores/canvas/use-canvas-store";

const JOURNAL_PREFIX = "canvas-document-journal";

export type CanvasCommitPayload = {
    canvasId: string;
    expectedRevision: number;
    document: CanvasProject;
};

export type CanvasInFlightCommit = {
    operationId: string;
    expectedRevision: number;
    payload: CanvasCommitPayload;
};

export type CanvasOperationJournal = {
    userScope: string;
    canvasId: string;
    confirmedRevision: number;
    confirmedSnapshot: CanvasProject | null;
    inFlight: CanvasInFlightCommit | null;
};

const memory = new Map<string, CanvasOperationJournal>();

function journalName(canvasId: string) {
    return `${JOURNAL_PREFIX}:${canvasId}`;
}

function cacheKey(scope: string, canvasId: string) {
    return `${scope}\0${canvasId}`;
}

function emptyJournal(scope: string, canvasId: string): CanvasOperationJournal {
    return { userScope: scope, canvasId, confirmedRevision: 0, confirmedSnapshot: null, inFlight: null };
}

function belongsToScope(journal: CanvasOperationJournal | null | undefined, scope: string, canvasId: string) {
    return Boolean(journal && journal.userScope === scope && journal.canvasId === canvasId);
}

export function peekCanvasOperationJournal(canvasId: string, scope = getActiveUserScope()) {
    return memory.get(cacheKey(scope, canvasId));
}

export async function loadCanvasOperationJournal(canvasId: string, scope = getActiveUserScope()) {
    const key = cacheKey(scope, canvasId);
    const cached = memory.get(key);
    if (cached) return cached;
    let stored: CanvasOperationJournal | null = null;
    try {
        const raw = await localForageStorageForScope(scope).getItem(journalName(canvasId));
        if (raw) stored = JSON.parse(raw) as CanvasOperationJournal;
    } catch {
        stored = null;
    }
    const journal = belongsToScope(stored, scope, canvasId) ? stored! : emptyJournal(scope, canvasId);
    memory.set(key, journal);
    if (journal.confirmedSnapshot) recordCanvasDocumentBase(journal.confirmedSnapshot, scope);
    return journal;
}

export async function saveCanvasOperationJournal(journal: CanvasOperationJournal) {
    const scope = journal.userScope || getActiveUserScope();
    memory.set(cacheKey(scope, journal.canvasId), journal);
    if (journal.confirmedSnapshot) recordCanvasDocumentBase(journal.confirmedSnapshot, scope);
    await localForageStorageForScope(scope).setItem(journalName(journal.canvasId), JSON.stringify(journal));
}

export async function recordConfirmedCanvasCommit(project: CanvasProject, scope = getActiveUserScope()) {
    const current = await loadCanvasOperationJournal(project.id, scope);
    await saveCanvasOperationJournal({
        ...current,
        confirmedRevision: project.revision ?? current.confirmedRevision,
        confirmedSnapshot: project,
        inFlight: null,
    });
}

export async function abandonCanvasInFlight(canvasId: string, scope = getActiveUserScope()) {
    const current = await loadCanvasOperationJournal(canvasId, scope);
    if (!current.inFlight) return;
    await saveCanvasOperationJournal({ ...current, inFlight: null });
}

export async function clearCanvasOperationJournal(canvasId: string, scope = getActiveUserScope()) {
    memory.delete(cacheKey(scope, canvasId));
    await localForageStorageForScope(scope).removeItem(journalName(canvasId));
}

export function newCanvasCommitOperationId() {
    return `canvas-commit-${nanoid()}`;
}

export function resetCanvasOperationJournalMemory() {
    memory.clear();
}
