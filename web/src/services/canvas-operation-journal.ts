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

export class CanvasJournalError extends Error {
    override cause?: unknown;

    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = "CanvasJournalError";
        this.cause = options?.cause;
    }
}

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonNegativeInteger(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new CanvasJournalError(`画布提交日记 ${label} 无效`);
    }
    return value;
}

function parseConfirmedSnapshot(value: unknown, canvasId: string): CanvasProject | null {
    if (value == null) return null;
    if (!isPlainObject(value) || typeof value.id !== "string" || value.id !== canvasId) {
        throw new CanvasJournalError("画布提交日记快照无效");
    }
    return value as unknown as CanvasProject;
}

function parseInFlight(value: unknown, canvasId: string): CanvasInFlightCommit | null {
    if (value == null) return null;
    if (!isPlainObject(value)) throw new CanvasJournalError("画布提交日记在途操作无效");
    const operationId = value.operationId;
    if (typeof operationId !== "string" || !operationId) {
        throw new CanvasJournalError("画布提交日记 operationId 无效");
    }
    const expectedRevision = asNonNegativeInteger(value.expectedRevision, "expectedRevision");
    if (!isPlainObject(value.payload)) throw new CanvasJournalError("画布提交日记 payload 无效");
    const payload = value.payload;
    if (payload.canvasId !== canvasId) throw new CanvasJournalError("画布提交日记 payload 作用域不匹配");
    const payloadExpected = asNonNegativeInteger(payload.expectedRevision, "payload.expectedRevision");
    if (payloadExpected !== expectedRevision) {
        throw new CanvasJournalError("画布提交日记 payload revision 不一致");
    }
    if (!isPlainObject(payload.document)) throw new CanvasJournalError("画布提交日记 payload 文档无效");
    return {
        operationId,
        expectedRevision,
        payload: {
            canvasId,
            expectedRevision: payloadExpected,
            document: payload.document as unknown as CanvasProject,
        },
    };
}

function parseCanvasOperationJournal(raw: unknown, scope: string, canvasId: string): CanvasOperationJournal {
    if (!isPlainObject(raw)) throw new CanvasJournalError("画布提交日记损坏");
    if (raw.userScope !== scope || raw.canvasId !== canvasId) {
        throw new CanvasJournalError("画布提交日记作用域不匹配");
    }
    return {
        userScope: scope,
        canvasId,
        confirmedRevision: asNonNegativeInteger(raw.confirmedRevision, "confirmedRevision"),
        confirmedSnapshot: parseConfirmedSnapshot(raw.confirmedSnapshot, canvasId),
        inFlight: parseInFlight(raw.inFlight, canvasId),
    };
}

export function peekCanvasOperationJournal(canvasId: string, scope = getActiveUserScope()) {
    return memory.get(cacheKey(scope, canvasId));
}

export async function loadCanvasOperationJournal(canvasId: string, scope = getActiveUserScope()) {
    const key = cacheKey(scope, canvasId);
    const cached = memory.get(key);
    if (cached) return cached;
    let raw: string | null = null;
    try {
        raw = await localForageStorageForScope(scope).getItem(journalName(canvasId));
    } catch (error) {
        throw new CanvasJournalError("画布提交日记读取失败", { cause: error });
    }
    if (raw == null || raw === "") {
        const journal = emptyJournal(scope, canvasId);
        memory.set(key, journal);
        return journal;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new CanvasJournalError("画布提交日记无法解析", { cause: error });
    }
    const journal = parseCanvasOperationJournal(parsed, scope, canvasId);
    memory.set(key, journal);
    if (journal.confirmedSnapshot) recordCanvasDocumentBase(journal.confirmedSnapshot, scope);
    return journal;
}

export async function saveCanvasOperationJournal(journal: CanvasOperationJournal) {
    const scope = journal.userScope || getActiveUserScope();
    const validated = parseCanvasOperationJournal(journal, scope, journal.canvasId);
    await localForageStorageForScope(scope).setItem(journalName(journal.canvasId), JSON.stringify(validated));
    memory.set(cacheKey(scope, journal.canvasId), validated);
    if (validated.confirmedSnapshot) recordCanvasDocumentBase(validated.confirmedSnapshot, scope);
}

export async function recordConfirmedCanvasCommit(
    project: CanvasProject,
    scope = getActiveUserScope(),
    options: { ackOperationId?: string } = {},
) {
    const current = await loadCanvasOperationJournal(project.id, scope);
    const incomingRevision = typeof project.revision === "number" && Number.isInteger(project.revision) && project.revision >= 0
        ? project.revision
        : current.confirmedRevision;
    const revisionWentBackwards = incomingRevision < current.confirmedRevision;
    const ackMatches = Boolean(options.ackOperationId && current.inFlight?.operationId === options.ackOperationId);
    await saveCanvasOperationJournal({
        ...current,
        confirmedRevision: Math.max(current.confirmedRevision, incomingRevision),
        confirmedSnapshot: revisionWentBackwards ? current.confirmedSnapshot : project,
        inFlight: ackMatches ? null : current.inFlight,
    });
}

export async function abandonCanvasInFlight(canvasId: string, scope = getActiveUserScope()) {
    const current = await loadCanvasOperationJournal(canvasId, scope);
    if (!current.inFlight) return;
    await saveCanvasOperationJournal({ ...current, inFlight: null });
}

export async function clearCanvasOperationJournal(canvasId: string, scope = getActiveUserScope()) {
    await localForageStorageForScope(scope).removeItem(journalName(canvasId));
    memory.delete(cacheKey(scope, canvasId));
}

export function newCanvasCommitOperationId() {
    return `canvas-commit-${nanoid()}`;
}

export function resetCanvasOperationJournalMemory() {
    memory.clear();
}
