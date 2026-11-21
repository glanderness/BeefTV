import { getActiveUserScope } from "@/lib/user-scope";
import { ApiError } from "@/services/api/request";
import { creationConversationsApi, type CreationConversationDocument, type CreationConversationRecord } from "@/services/api/creation-conversations";

type PendingCreationMessage = {
    id: string;
    role: "user" | "assistant";
    mode?: string;
    status?: string;
    taskIds?: string[];
};

export type StoredCreationConversation = {
    id: string;
    messages: PendingCreationMessage[];
    [key: string]: unknown;
};

type CommittedState = {
    revision: number;
    fingerprint: string;
    document: StoredCreationConversation;
};

type PendingWrite = {
    generation: number;
    document: StoredCreationConversation;
    /** Last document actually dispatched in a PUT, used as 3-way ancestor on lost-ack 409/adopt. */
    sentDocument?: StoredCreationConversation;
    adoptedRevision?: number;
};

const committed = new Map<string, CommittedState>();
const writeQueues = new Map<string, Promise<unknown>>();
const pendingWrites = new Map<string, PendingWrite>();
const writeGenerations = new Map<string, number>();
const deletedAt = new Map<string, number>();
let opClock = 0;

const MAX_CONFLICT_REBASE_ATTEMPTS = 2;
const mediaURLKeys = new Set(["dataurl", "url", "previewurl", "poster", "src", "thumbnail", "thumbnailurl", "imageurl"]);

export function updateCreationConversationSnapshot<T extends { id: string }>(conversations: T[], conversationId: string, updater: (conversation: T) => T) {
    return conversations.map((conversation) => (conversation.id === conversationId ? updater(conversation) : conversation));
}

// 对话、生成任务与素材是独立持久状态；删除历史记录不能在这里级联清理任务或资源。
export function removeCreationConversationSnapshot<T extends { id: string }>(conversations: T[], conversationId: string) {
    if (!conversationId) throw new Error("缺少要删除的创作对话 ID");
    const next = conversations.filter((conversation) => conversation.id !== conversationId);
    if (next.length === conversations.length) throw new Error("要删除的创作对话不存在");
    return next;
}

function isRecoverableCreationMessage(message: PendingCreationMessage) {
    if (message.role !== "assistant" || !message.taskIds?.length) return false;
    return message.mode === "text" ? message.status === "streaming" || message.status === "pending" : message.status === "pending";
}

export function pendingCreationTaskKey(conversations: StoredCreationConversation[]) {
    return conversations
        .flatMap((conversation) => conversation.messages.flatMap((message) => (isRecoverableCreationMessage(message) ? [`${conversation.id}:${message.id}:${(message.taskIds || []).join(",")}`] : [])))
        .join("|");
}

export function pendingCreationTaskIds(conversations: StoredCreationConversation[]) {
    const taskIds = conversations.flatMap((conversation) =>
        conversation.messages.flatMap((message) => {
            if (!isRecoverableCreationMessage(message)) return [];
            return message.taskIds || [];
        }),
    );
    return Array.from(new Set(taskIds));
}

function scopeKey(scope: string, id: string) {
    return `${scope}\0${id}`;
}

function cloneConversation<T>(value: T): T {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fieldKey(key: string) {
    return key.trim().toLowerCase().replace(/_/g, "");
}

function isMediaURLKey(key: string) {
    return mediaURLKeys.has(fieldKey(key));
}

function isTempMediaBlob(value: string) {
    const trimmed = value.trim().toLowerCase();
    return trimmed.startsWith("data:") || trimmed.startsWith("blob:");
}

function stringField(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function stripEphemeralMedia(value: unknown, key = ""): unknown {
    if (typeof value === "string") {
        if (isMediaURLKey(key) && isTempMediaBlob(value)) return undefined;
        return value;
    }
    if (Array.isArray(value)) {
        if (fieldKey(key) === "attachments") return value.map((item) => persistAttachment(item));
        if (fieldKey(key) === "resulturls") {
            return value.map((item) => stripEphemeralMedia(item, "url")).filter((item) => item !== undefined);
        }
        return value.map((item) => stripEphemeralMedia(item)).filter((item) => item !== undefined);
    }
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) {
            const cleaned = stripEphemeralMedia(item, childKey);
            if (cleaned !== undefined) out[childKey] = cleaned;
        }
        return out;
    }
    return value;
}

function persistAttachment(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("附件必须是对象");
    const attachment = value as Record<string, unknown>;
    const storageKey = stringField(attachment.storageKey) || stringField(attachment.storage_key);
    const out: Record<string, unknown> = {};
    for (const [childKey, item] of Object.entries(attachment)) {
        if (typeof item === "string" && isMediaURLKey(childKey) && isTempMediaBlob(item)) {
            if (!storageKey) throw new Error("附件没有可恢复的存储引用");
            continue;
        }
        const cleaned = stripEphemeralMedia(item, childKey);
        if (cleaned !== undefined) out[childKey] = cleaned;
    }
    return out;
}

function persistableDocument(conversation: StoredCreationConversation): CreationConversationDocument {
    const { revision: _revision, ...rest } = conversation;
    const stripped = stripEphemeralMedia(rest) as Record<string, unknown>;
    const title = typeof stripped.title === "string" ? stripped.title.trim() : "";
    stripped.title = title || "新创作";
    return stripped as CreationConversationDocument;
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
                .sort()
                .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
        );
    }
    return value;
}

function canonicalFingerprint(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function fingerprintOf(document: StoredCreationConversation) {
    return canonicalFingerprint(persistableDocument(document));
}

function samePersistable(left: unknown, right: unknown) {
    try {
        return canonicalFingerprint(left) === canonicalFingerprint(right);
    } catch {
        return false;
    }
}

function looksLikeMessageList(value: unknown[]) {
    return value.every((item) => !item || (isPlainObject(item) && typeof item.id === "string"));
}

function messageMap(list: unknown[]) {
    const map = new Map<string, Record<string, unknown>>();
    for (const item of list) {
        if (isPlainObject(item) && typeof item.id === "string") map.set(item.id, item);
    }
    return map;
}

function mergeMessages(base: unknown[], ours: unknown[], theirs: unknown[]) {
    const baseById = messageMap(base);
    const oursById = messageMap(ours);
    const theirsById = messageMap(theirs);
    const seen = new Set<string>();
    const merged: unknown[] = [];
    for (const item of ours) {
        if (!isPlainObject(item) || typeof item.id !== "string") {
            merged.push(item);
            continue;
        }
        seen.add(item.id);
        const previous = baseById.get(item.id);
        const canonical = theirsById.get(item.id);
        if (!previous) {
            merged.push(item);
            continue;
        }
        if (samePersistable(item, previous)) {
            if (canonical) merged.push(canonical);
            continue;
        }
        merged.push(mergeValue(previous, item, canonical ?? item));
    }
    for (const item of theirs) {
        if (!isPlainObject(item) || typeof item.id !== "string" || seen.has(item.id)) continue;
        if (baseById.has(item.id) && !oursById.has(item.id)) continue;
        merged.push(item);
    }
    return merged;
}

function mergeValue(base: unknown, ours: unknown, theirs: unknown): unknown {
    if (samePersistable(ours, base)) return theirs;
    if (samePersistable(theirs, base)) return ours;
    if (Array.isArray(ours) && Array.isArray(theirs) && Array.isArray(base) && looksLikeMessageList(ours)) {
        return mergeMessages(base, ours, theirs);
    }
    if (isPlainObject(ours) && isPlainObject(theirs) && isPlainObject(base)) {
        const keys = new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)]);
        const out: Record<string, unknown> = {};
        for (const key of keys) {
            if (!(key in ours)) {
                if (samePersistable(theirs[key], base[key])) continue;
                out[key] = theirs[key];
                continue;
            }
            out[key] = mergeValue(base[key], ours[key], key in theirs ? theirs[key] : ours[key]);
        }
        return out;
    }
    return ours;
}

function mergeMessagesWithoutBase(local: unknown[], canonical: unknown[]) {
    const canonicalIds = new Set<string>();
    const merged: unknown[] = [];
    for (const item of canonical) {
        if (isPlainObject(item) && typeof item.id === "string") canonicalIds.add(item.id);
        merged.push(cloneConversation(item));
    }
    for (const item of local) {
        if (isPlainObject(item) && typeof item.id === "string") {
            if (canonicalIds.has(item.id)) continue;
            canonicalIds.add(item.id);
        }
        merged.push(cloneConversation(item));
    }
    return merged;
}

function projectLocalOnCanonical(
    base: StoredCreationConversation | undefined,
    local: StoredCreationConversation,
    canonical: StoredCreationConversation,
): StoredCreationConversation {
    if (!base) {
        const merged = cloneConversation(canonical) as Record<string, unknown>;
        for (const [key, value] of Object.entries(local)) {
            if (key === "id" || key === "messages") continue;
            if (!(key in merged)) merged[key] = cloneConversation(value);
        }
        const canonicalTitle = typeof merged.title === "string" ? merged.title.trim() : "";
        const localTitle = typeof local.title === "string" ? local.title.trim() : "";
        if ((!canonicalTitle || canonicalTitle === "新创作") && localTitle && localTitle !== "新创作") {
            merged.title = localTitle;
        }
        const messages = mergeMessagesWithoutBase(
            Array.isArray(local.messages) ? local.messages : [],
            Array.isArray(canonical.messages) ? canonical.messages : [],
        );
        return { ...merged, id: canonical.id || local.id, messages } as StoredCreationConversation;
    }
    try {
        if (fingerprintOf(local) === fingerprintOf(base)) return cloneConversation(canonical);
    } catch {
        // Keep merging when an unvalidated local document differs from base.
    }
    const merged = mergeValue(base, local, canonical);
    if (!isPlainObject(merged)) return cloneConversation(canonical);
    const messages = Array.isArray(merged.messages) ? merged.messages : canonical.messages;
    return { ...merged, id: canonical.id || local.id, messages } as StoredCreationConversation;
}

function documentFromRecord(record: { id: string; document?: CreationConversationDocument }): StoredCreationConversation {
    const document = record.document;
    if (!document || typeof document !== "object") {
        return { id: record.id, messages: [] };
    }
    const messages = Array.isArray(document.messages) ? document.messages : [];
    return { ...document, id: record.id, messages } as StoredCreationConversation;
}

function rememberCommitted(scope: string, id: string, revision: number, document: StoredCreationConversation) {
    committed.set(scopeKey(scope, id), {
        revision,
        fingerprint: fingerprintOf(document),
        document: cloneConversation(document),
    });
}

function commitIfCurrent(scope: string, id: string, revision: number, document: StoredCreationConversation) {
    const current = committed.get(scopeKey(scope, id));
    if (current && current.revision > revision) return false;
    rememberCommitted(scope, id, revision, document);
    return true;
}

function enqueue<T>(scope: string, id: string, work: () => Promise<T>): Promise<T> {
    const key = scopeKey(scope, id);
    const previous = writeQueues.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(() => undefined, () => undefined);
    writeQueues.set(key, tail);
    void tail.finally(() => {
        if (writeQueues.get(key) === tail) writeQueues.delete(key);
    });
    return run;
}

function nextGeneration(key: string) {
    const generation = (writeGenerations.get(key) || 0) + 1;
    writeGenerations.set(key, generation);
    return generation;
}

function isConflictError(error: unknown) {
    return error instanceof ApiError && (error.status === 409 || error.reason === "conflict");
}

function isNotFoundError(error: unknown) {
    return error instanceof ApiError && (error.status === 404 || error.reason === "not_found");
}

export function hasPendingCreationConversationWrites(scope = getActiveUserScope()) {
    const prefix = `${scope}\0`;
    for (const key of pendingWrites.keys()) {
        if (key.startsWith(prefix)) return true;
    }
    return false;
}

export async function loadCreationConversations<T extends StoredCreationConversation>(scope = getActiveUserScope()) {
    const startedAt = opClock;
    const listed = await creationConversationsApi.list();
    const deleted = new Set(listed.deletedIds || []);
    const seenIds = new Set<string>();
    const loaded: T[] = [];
    for (const record of listed.conversations || []) {
        if (record.deleted || deleted.has(record.id)) continue;
        const key = scopeKey(scope, record.id);
        if ((deletedAt.get(key) || 0) > startedAt) continue;
        seenIds.add(record.id);
        const document = documentFromRecord(record);
        const existing = committed.get(key);
        if (existing && existing.revision > record.revision) {
            const live = pendingWrites.get(key)?.document ?? existing.document;
            loaded.push(cloneConversation(live) as T);
            continue;
        }
        rememberCommitted(scope, record.id, record.revision, document);
        const pending = pendingWrites.get(key);
        if (!pending) {
            loaded.push(cloneConversation(document) as T);
            continue;
        }
        const live = projectLocalOnCanonical(existing?.document ?? pending.sentDocument, pending.document, document);
        if (fingerprintOf(live) === fingerprintOf(document)) {
            pendingWrites.delete(key);
            loaded.push(cloneConversation(document) as T);
        } else {
            pendingWrites.set(key, {
                generation: nextGeneration(key),
                document: cloneConversation(live),
                sentDocument: pending.sentDocument,
                adoptedRevision: record.revision,
            });
            loaded.push(cloneConversation(live) as T);
        }
    }
    const scopePrefix = `${scope}\0`;
    for (const [key, pending] of pendingWrites) {
        if (!key.startsWith(scopePrefix)) continue;
        const id = key.slice(scopePrefix.length);
        if (seenIds.has(id)) continue;
        if (deleted.has(id)) {
            pendingWrites.delete(key);
            continue;
        }
        if ((deletedAt.get(key) || 0) > startedAt) continue;
        loaded.unshift(cloneConversation(pending.document) as T);
    }
    return loaded.length ? loaded : null;
}

async function flushConversation(scope: string, id: string) {
    const key = scopeKey(scope, id);
    let rebaseAttempts = 0;

    for (;;) {
        const snapshot = pendingWrites.get(key);
        if (!snapshot) return;

        const payload = persistableDocument(snapshot.document);
        const payloadFingerprint = canonicalFingerprint(payload);
        const state = committed.get(key);
        if (state && payloadFingerprint === state.fingerprint) {
            if (pendingWrites.get(key)?.generation === snapshot.generation) {
                pendingWrites.delete(key);
                return;
            }
            continue;
        }

        const expectedRevision = state?.revision ?? 0;
        let saved: CreationConversationRecord;
        try {
            saved = await creationConversationsApi.put(id, { expectedRevision, document: payload });
        } catch (error) {
            // Retain pendingWrites as the latest local intent on transient errors so a
            // subsequent adopt or retry preserves unsaved user edits. Record the first
            // unknown-outcome PUT payload as a possible server ancestor for lost-ack rebase.
            if (!isConflictError(error)) {
                const activePending = pendingWrites.get(key);
                if (activePending && !activePending.sentDocument) {
                    activePending.sentDocument = snapshot.document;
                }
                throw error;
            }
            const latestCommitted = committed.get(key);
            const latestPending = pendingWrites.get(key);
            if (!latestPending) {
                if (latestCommitted && latestCommitted.revision > expectedRevision) return;
                throw error;
            }
            // If adopt/load already advanced committed and projected pendingWrites onto
            // that exact revision while this PUT was in flight, retry without an extra GET.
            if (
                rebaseAttempts < MAX_CONFLICT_REBASE_ATTEMPTS
                && latestCommitted
                && latestCommitted.revision > expectedRevision
                && latestPending.generation > snapshot.generation
                && latestPending.adoptedRevision === latestCommitted.revision
            ) {
                rebaseAttempts += 1;
                continue;
            }
            let remote: CreationConversationRecord;
            try {
                remote = await creationConversationsApi.get(id);
            } catch (getError) {
                if (isNotFoundError(getError)) {
                    if (pendingWrites.get(key)?.generation === snapshot.generation) pendingWrites.delete(key);
                    throw error;
                }
                throw getError;
            }
            if (remote.deleted) {
                if (pendingWrites.get(key)?.generation === snapshot.generation) pendingWrites.delete(key);
                throw error;
            }
            const remoteDoc = documentFromRecord(remote);
            const committedAfterGet = committed.get(key);
            const pendingAfterGet = pendingWrites.get(key);
            if (committedAfterGet && committedAfterGet.revision > remote.revision) {
                if (!pendingAfterGet) return;
                if (rebaseAttempts >= MAX_CONFLICT_REBASE_ATTEMPTS) throw error;
                rebaseAttempts += 1;
                if (pendingAfterGet.adoptedRevision !== committedAfterGet.revision) {
                    const merged = projectLocalOnCanonical(
                        state?.document ?? pendingAfterGet.sentDocument,
                        pendingAfterGet.document,
                        committedAfterGet.document,
                    );
                    pendingWrites.set(key, {
                        generation: nextGeneration(key),
                        document: merged,
                        sentDocument: pendingAfterGet.sentDocument,
                        adoptedRevision: committedAfterGet.revision,
                    });
                }
                continue;
            }
            if (fingerprintOf(remoteDoc) === payloadFingerprint) {
                saved = remote;
            } else if (rebaseAttempts < MAX_CONFLICT_REBASE_ATTEMPTS) {
                rebaseAttempts += 1;
                const liveLocal = pendingAfterGet?.document ?? snapshot.document;
                const base = state?.document ?? snapshot.sentDocument;
                const merged = projectLocalOnCanonical(base, liveLocal, remoteDoc);
                commitIfCurrent(scope, id, remote.revision, remoteDoc);
                pendingWrites.set(key, {
                    generation: nextGeneration(key),
                    document: merged,
                    adoptedRevision: remote.revision,
                });
                continue;
            } else {
                throw error;
            }
        }

        const canonical = documentFromRecord(saved);
        const applied = commitIfCurrent(scope, id, saved.revision, canonical);
        const latest = pendingWrites.get(key);
        if (!applied) {
            if (latest && latest.generation > snapshot.generation) {
                rebaseAttempts = 0;
                continue;
            }
            if (latest?.generation === snapshot.generation) pendingWrites.delete(key);
            return;
        }
        if (latest && latest.generation > snapshot.generation) {
            const projected = projectLocalOnCanonical(snapshot.document, latest.document, canonical);
            pendingWrites.set(key, { generation: latest.generation, document: projected });
            rebaseAttempts = 0;
            continue;
        }
        if (latest?.generation === snapshot.generation) {
            pendingWrites.delete(key);
        }
        return;
    }
}

export async function saveCreationConversations<T extends StoredCreationConversation>(
    conversations: T[],
    scope = getActiveUserScope(),
) {
    const jobs = conversations.map((conversation) => {
        if (!conversation?.id) return Promise.reject(new Error("缺少要保存的创作对话 ID"));
        const cloned = cloneConversation(conversation);
        let payloadFingerprint: string;
        try {
            payloadFingerprint = fingerprintOf(cloned);
        } catch (error) {
            return Promise.reject(error);
        }
        const key = scopeKey(scope, cloned.id);
        const current = committed.get(key);
        if (!pendingWrites.has(key) && current && current.fingerprint === payloadFingerprint) {
            return Promise.resolve();
        }
        const generation = nextGeneration(key);
        const priorSent = pendingWrites.get(key)?.sentDocument;
        pendingWrites.set(key, { generation, document: cloned, ...(priorSent ? { sentDocument: priorSent } : {}) });
        deletedAt.delete(key);
        return enqueue(scope, cloned.id, () => flushConversation(scope, cloned.id));
    });
    const results = await Promise.allSettled(jobs);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
}

export async function adoptServerConfirmedConversationDocument(
    conversationId: string,
    document: StoredCreationConversation,
    revision: number,
) {
    const scope = getActiveUserScope();
    const id = conversationId.trim();
    if (!id) throw new Error("缺少要采纳的创作对话 ID");
    if (!Number.isInteger(revision) || revision < 1) throw new Error("对话版本无效");

    const key = scopeKey(scope, id);
    const canonical = cloneConversation({ ...document, id });
    const current = committed.get(key);
    const pending = pendingWrites.get(key);

    if (current && current.revision > revision) {
        return cloneConversation(pending?.document ?? current.document);
    }

    const base = current?.document ?? pending?.sentDocument;
    let live: StoredCreationConversation;
    if (!pending) {
        live = cloneConversation(canonical);
    } else if (fingerprintOf(pending.document) === fingerprintOf(canonical)) {
        pendingWrites.delete(key);
        live = cloneConversation(canonical);
    } else {
        live = projectLocalOnCanonical(base, pending.document, canonical);
        if (fingerprintOf(live) === fingerprintOf(canonical)) {
            pendingWrites.delete(key);
        } else {
            pendingWrites.set(key, {
                generation: nextGeneration(key),
                document: cloneConversation(live),
                adoptedRevision: revision,
            });
        }
    }

    rememberCommitted(scope, id, revision, canonical);
    return cloneConversation(live);
}

export async function deleteCreationConversation(conversationId: string, scope = getActiveUserScope()) {
    if (!conversationId) throw new Error("缺少要删除的创作对话 ID");
    const key = scopeKey(scope, conversationId);
    return enqueue(scope, conversationId, async () => {
        const expectedRevision = committed.get(key)?.revision ?? 0;
        try {
            await creationConversationsApi.remove(conversationId, expectedRevision);
        } catch (error) {
            if (isNotFoundError(error)) {
                // Already deleted in SQLite.
            } else if (isConflictError(error)) {
                let latest: CreationConversationRecord;
                try {
                    latest = await creationConversationsApi.get(conversationId);
                } catch (getError) {
                    if (isNotFoundError(getError)) {
                        latest = { id: conversationId, revision: expectedRevision, updatedAt: "", deleted: true };
                    } else {
                        throw getError;
                    }
                }
                if (!latest.deleted) {
                    await creationConversationsApi.remove(conversationId, latest.revision);
                }
            } else {
                throw error;
            }
        }
        committed.delete(key);
        pendingWrites.delete(key);
        deletedAt.set(key, ++opClock);
    });
}

export function resetCreationConversationStoreForTests() {
    committed.clear();
    writeQueues.clear();
    pendingWrites.clear();
    writeGenerations.clear();
    deletedAt.clear();
    opClock = 0;
}
