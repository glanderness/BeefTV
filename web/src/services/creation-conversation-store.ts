import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { ApiError } from "@/services/api/request";
import { creationConversationsApi, type CreationConversationDocument, type CreationConversationRecord } from "@/services/api/creation-conversations";

export const CREATION_CONVERSATIONS_KEY = "creation-conversations-v1";
const CREATION_CONVERSATION_DRAFTS_KEY = "creation-conversation-drafts-v1";
const CREATION_CONVERSATION_DRAFT_INDEX_KEY = "creation-conversation-drafts-v1:index";
const CREATION_CONVERSATION_TOMBSTONES_KEY = "creation-conversation-tombstones-v1";

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
    conflictRemote?: { revision: number; document: StoredCreationConversation };
    [key: string]: unknown;
};

type ConversationDraft = {
    baseRevision: number;
    document: StoredCreationConversation;
    remote?: { revision: number; document: StoredCreationConversation };
};

type CommittedState = {
    revision: number;
    fingerprint: string;
};

type PendingWrite = {
    generation: number;
    document: StoredCreationConversation;
};

const committed = new Map<string, CommittedState>();
const writeQueues = new Map<string, Promise<unknown>>();
const storageQueues = new Map<string, Promise<unknown>>();
const pendingWrites = new Map<string, PendingWrite>();
const writeGenerations = new Map<string, number>();

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
    return `${scope}:${id}`;
}

function draftItemKey(id: string) {
    return `${CREATION_CONVERSATION_DRAFTS_KEY}:${id}`;
}

function rememberCommitted(scope: string, id: string, revision: number, document: StoredCreationConversation) {
    committed.set(scopeKey(scope, id), { revision, fingerprint: fingerprintOf(document) });
}

function forgetCommitted(scope: string, id: string) {
    committed.delete(scopeKey(scope, id));
    pendingWrites.delete(scopeKey(scope, id));
}

function fingerprintOf(document: StoredCreationConversation) {
    return canonicalFingerprint(persistableDocument(document));
}

function persistableFingerprint(document: StoredCreationConversation) {
    try {
        return fingerprintOf(document);
    } catch {
        return null;
    }
}

function persistableDocument(conversation: StoredCreationConversation): CreationConversationDocument {
    const { revision: _revision, pending: _pending, conflictRemote: _conflictRemote, ...rest } = conversation;
    return stripEphemeralMedia(rest) as CreationConversationDocument;
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

function canonicalFingerprint(value: unknown): string {
    return JSON.stringify(sortKeys(value));
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

function rejectIfScopeChanged(scope: string) {
    if (scope !== getActiveUserScope()) throw new Error("工作区已切换，已忽略过期对话结果");
}

function enqueue(scope: string, id: string, work: () => Promise<void>) {
    const key = scopeKey(scope, id);
    const previous = writeQueues.get(key) || Promise.resolve();
    const next = previous.then(work, work);
    writeQueues.set(key, next.catch(() => undefined));
    return next;
}

function withScopeStorage<T>(scope: string, work: () => Promise<T>): Promise<T> {
    const previous = storageQueues.get(scope) || Promise.resolve();
    const current = previous.then(work, work) as Promise<T>;
    storageQueues.set(scope, current.then(() => undefined, () => undefined));
    return current;
}

function nextGeneration(key: string) {
    const generation = (writeGenerations.get(key) || 0) + 1;
    writeGenerations.set(key, generation);
    return generation;
}

async function readLegacyArray(scope: string): Promise<StoredCreationConversation[] | null> {
    const storage = localForageStorageForScope(scope);
    const value = await storage.getItem(CREATION_CONVERSATIONS_KEY);
    if (!value) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error("创作对话持久状态无效");
    }
    if (!Array.isArray(parsed)) throw new Error("创作对话持久状态无效");
    return parsed as StoredCreationConversation[];
}

async function writeLegacyArray(scope: string, conversations: StoredCreationConversation[]) {
    const storage = localForageStorageForScope(scope);
    await storage.setItem(CREATION_CONVERSATIONS_KEY, JSON.stringify(conversations));
}

async function removeLegacyConversation(scope: string, id: string) {
    const legacy = await readLegacyArray(scope);
    if (!legacy?.some((item) => item.id === id)) return;
    await writeLegacyArray(scope, legacy.filter((item) => item.id !== id));
}

async function readJSON<T>(scope: string, key: string, fallback: T): Promise<T> {
    const storage = localForageStorageForScope(scope);
    const value = await storage.getItem(key);
    if (!value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        throw new Error("创作对话本地状态无效");
    }
}

async function readDraftIndex(scope: string): Promise<string[]> {
    await migrateCombinedDrafts(scope);
    const index = await readJSON<string[]>(scope, CREATION_CONVERSATION_DRAFT_INDEX_KEY, []);
    return Array.isArray(index) ? index.filter((id) => typeof id === "string" && id) : [];
}

async function migrateCombinedDrafts(scope: string) {
    const storage = localForageStorageForScope(scope);
    const raw = await storage.getItem(CREATION_CONVERSATION_DRAFTS_KEY);
    if (!raw) return;
    let parsed: Record<string, ConversationDraft>;
    try {
        parsed = JSON.parse(raw) as Record<string, ConversationDraft>;
    } catch {
        await storage.removeItem(CREATION_CONVERSATION_DRAFTS_KEY);
        return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        await storage.removeItem(CREATION_CONVERSATION_DRAFTS_KEY);
        return;
    }
    const ids = Object.keys(parsed);
    for (const id of ids) {
        if (parsed[id]?.document) await storage.setItem(draftItemKey(id), JSON.stringify(parsed[id]));
    }
    await storage.setItem(CREATION_CONVERSATION_DRAFT_INDEX_KEY, JSON.stringify(ids));
    await storage.removeItem(CREATION_CONVERSATION_DRAFTS_KEY);
}

async function readDraft(scope: string, id: string): Promise<ConversationDraft | null> {
    const value = await readJSON<ConversationDraft | null>(scope, draftItemKey(id), null);
    if (!value?.document) return null;
    return value;
}

async function writeDraft(scope: string, id: string, draft: ConversationDraft) {
    const storage = localForageStorageForScope(scope);
    await storage.setItem(draftItemKey(id), JSON.stringify(draft));
    const index = await readDraftIndex(scope);
    if (!index.includes(id)) {
        index.push(id);
        await storage.setItem(CREATION_CONVERSATION_DRAFT_INDEX_KEY, JSON.stringify(index));
    }
}

async function removeDraft(scope: string, id: string) {
    const storage = localForageStorageForScope(scope);
    await storage.removeItem(draftItemKey(id));
    const index = (await readDraftIndex(scope)).filter((item) => item !== id);
    await storage.setItem(CREATION_CONVERSATION_DRAFT_INDEX_KEY, JSON.stringify(index));
}

async function listDrafts(scope: string): Promise<Record<string, ConversationDraft>> {
    const ids = await readDraftIndex(scope);
    const drafts: Record<string, ConversationDraft> = {};
    for (const id of ids) {
        const draft = await readDraft(scope, id);
        if (draft) drafts[id] = draft;
    }
    return drafts;
}

async function readTombstones(scope: string): Promise<Set<string>> {
    const ids = await readJSON<string[]>(scope, CREATION_CONVERSATION_TOMBSTONES_KEY, []);
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id) : []);
}

async function writeTombstones(scope: string, ids: Set<string>) {
    const storage = localForageStorageForScope(scope);
    await storage.setItem(CREATION_CONVERSATION_TOMBSTONES_KEY, JSON.stringify(Array.from(ids)));
}

async function rememberTombstones(scope: string, ids: string[]) {
    await withScopeStorage(scope, async () => {
        const current = await readTombstones(scope);
        for (const id of ids) current.add(id);
        await writeTombstones(scope, current);
    });
}

async function captureDraft(scope: string, id: string, document: StoredCreationConversation) {
    await withScopeStorage(scope, async () => {
        const existing = await readDraft(scope, id);
        const committedRevision = committed.get(scopeKey(scope, id))?.revision ?? 0;
        const baseRevision = existing && existing.baseRevision < committedRevision ? existing.baseRevision : committedRevision;
        await writeDraft(scope, id, {
            baseRevision,
            document,
            remote: existing?.remote,
        });
    });
}

async function draftBaseRevision(scope: string, id: string) {
    return withScopeStorage(scope, async () => {
        const existing = await readDraft(scope, id);
        const committedRevision = committed.get(scopeKey(scope, id))?.revision ?? 0;
        if (existing && existing.baseRevision < committedRevision) return existing.baseRevision;
        return committedRevision;
    });
}

function documentFromRecord(record: { id: string; document?: CreationConversationDocument }): StoredCreationConversation {
    const document = record.document;
    if (!document || typeof document !== "object") {
        return { id: record.id, messages: [] };
    }
    const messages = Array.isArray(document.messages) ? document.messages : [];
    return { ...document, id: record.id, messages } as StoredCreationConversation;
}

function withConflict(document: StoredCreationConversation, remote: { revision: number; document: StoredCreationConversation }): StoredCreationConversation {
    const { conflictRemote: _conflictRemote, ...rest } = document;
    return { ...rest, conflictRemote: remote };
}

export async function loadLocalCreationConversationDrafts<T extends StoredCreationConversation>(scope = getActiveUserScope()) {
    const drafts = await withScopeStorage(scope, () => listDrafts(scope));
    const tombstones = await withScopeStorage(scope, () => readTombstones(scope));
    const legacy = await withScopeStorage(scope, () => readLegacyArray(scope));
    const byId = new Map<string, T>();
    for (const item of legacy || []) {
        if (item?.id && !tombstones.has(item.id)) byId.set(item.id, item as T);
    }
    for (const [id, draft] of Object.entries(drafts)) {
        if (draft?.document?.id && !tombstones.has(id)) {
            byId.set(id, (draft.remote ? withConflict(draft.document, draft.remote) : draft.document) as T);
        }
    }
    return byId.size ? Array.from(byId.values()) : null;
}

export async function loadCreationConversations<T extends StoredCreationConversation>(scope = getActiveUserScope()) {
    const listed = await creationConversationsApi.list();
    rejectIfScopeChanged(scope);
    const deleted = new Set(listed.deletedIds || []);
    await rememberTombstones(scope, listed.deletedIds || []);
    const committedRecords = new Map((listed.conversations || []).map((item) => [item.id, item]));
    const tombstones = await withScopeStorage(scope, () => readTombstones(scope));
    const legacy = await withScopeStorage(scope, () => readLegacyArray(scope));
    rejectIfScopeChanged(scope);
    for (const local of legacy || []) {
        if (!local?.id || deleted.has(local.id) || tombstones.has(local.id) || committedRecords.has(local.id)) continue;
        let document: CreationConversationDocument;
        try {
            document = persistableDocument(local);
        } catch {
            await withScopeStorage(scope, () => writeDraft(scope, local.id, { baseRevision: 0, document: local }));
            continue;
        }
        const imported = await creationConversationsApi.importLegacy({
            operationId: `${CREATION_CONVERSATIONS_KEY}:${local.id}`,
            document,
        });
        rejectIfScopeChanged(scope);
        if (imported.deleted) {
            deleted.add(imported.id);
            await rememberTombstones(scope, [imported.id]);
            continue;
        }
        if (imported.conversation?.id) {
            committedRecords.set(imported.conversation.id, imported.conversation);
            await withScopeStorage(scope, () => removeLegacyConversation(scope, imported.conversation.id));
        }
    }
    for (const record of committedRecords.values()) {
        if (!record.deleted) await withScopeStorage(scope, () => removeLegacyConversation(scope, record.id));
    }
    const drafts = await withScopeStorage(scope, () => listDrafts(scope));
    rejectIfScopeChanged(scope);
    const loaded: T[] = [];
    for (const record of committedRecords.values()) {
        if (record.deleted || deleted.has(record.id) || tombstones.has(record.id)) continue;
        const document = documentFromRecord(record);
        rememberCommitted(scope, record.id, record.revision, document);
        const draft = drafts[record.id];
        if (draft?.document) {
            const draftFingerprint = persistableFingerprint(draft.document);
            const remoteFingerprint = persistableFingerprint(document);
            if (draftFingerprint && remoteFingerprint && draftFingerprint === remoteFingerprint) {
                await withScopeStorage(scope, () => removeDraft(scope, record.id));
                loaded.push(document as T);
                continue;
            }
            if (draft.baseRevision !== record.revision || !draftFingerprint) {
                const remote = { revision: record.revision, document };
                await withScopeStorage(scope, () => writeDraft(scope, record.id, { ...draft, remote }));
                loaded.push(withConflict(draft.document, remote) as T);
                continue;
            }
            loaded.push(draft.document as T);
            continue;
        }
        loaded.push(document as T);
    }
    for (const [id, draft] of Object.entries(drafts)) {
        if (!draft?.document || committedRecords.has(id) || deleted.has(id) || tombstones.has(id)) continue;
        loaded.push(draft.document as T);
        rememberCommitted(scope, id, 0, { id, messages: [] });
    }
    return loaded.length ? loaded : null;
}

async function putConversation(id: string, expectedRevision: number, document: StoredCreationConversation) {
    return creationConversationsApi.put(id, {
        expectedRevision,
        document: persistableDocument(document),
    });
}

function isConflictError(error: unknown) {
    return error instanceof ApiError && (error.status === 409 || error.reason === "conflict");
}

async function recoverLostAck(scope: string, id: string, document: StoredCreationConversation): Promise<CreationConversationRecord | null> {
    let remote: CreationConversationRecord;
    try {
        remote = await creationConversationsApi.get(id);
    } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.reason === "not_found")) return null;
        throw error;
    }
    rejectIfScopeChanged(scope);
    if (remote.deleted) return null;
    const remoteDocument = documentFromRecord(remote);
    const localFingerprint = persistableFingerprint(document);
    const remoteFingerprint = persistableFingerprint(remoteDocument);
    if (localFingerprint && remoteFingerprint && localFingerprint === remoteFingerprint) {
        return remote;
    }
    await withScopeStorage(scope, async () => {
        const existing = await readDraft(scope, id);
        await writeDraft(scope, id, {
            baseRevision: existing?.baseRevision ?? committed.get(scopeKey(scope, id))?.revision ?? 0,
            document,
            remote: { revision: remote.revision, document: remoteDocument },
        });
    });
    return null;
}

async function flushConversation(scope: string, id: string) {
    rejectIfScopeChanged(scope);
    const key = scopeKey(scope, id);
    for (;;) {
        const snapshot = pendingWrites.get(key);
        if (!snapshot) return;
        const state = committed.get(key);
        if (state && fingerprintOf(snapshot.document) === state.fingerprint) {
            if (pendingWrites.get(key)?.generation === snapshot.generation) {
                pendingWrites.delete(key);
                await withScopeStorage(scope, () => removeDraft(scope, id));
            }
            if ((pendingWrites.get(key)?.generation ?? 0) > snapshot.generation) continue;
            return;
        }
        const expectedRevision = await draftBaseRevision(scope, id);
        rejectIfScopeChanged(scope);
        let saved: CreationConversationRecord;
        try {
            saved = await putConversation(id, expectedRevision, snapshot.document);
        } catch (error) {
            if (!isConflictError(error)) throw error;
            const recovered = await recoverLostAck(scope, id, snapshot.document);
            if (!recovered) throw error;
            saved = recovered;
        }
        rejectIfScopeChanged(scope);
        rememberCommitted(scope, id, saved.revision, snapshot.document);
        const latest = pendingWrites.get(key);
        if (latest && latest.generation > snapshot.generation) {
            await withScopeStorage(scope, () => writeDraft(scope, id, {
                baseRevision: saved.revision,
                document: latest.document,
            }));
            continue;
        }
        if (latest?.generation === snapshot.generation) {
            pendingWrites.delete(key);
            await withScopeStorage(scope, () => removeDraft(scope, id));
        }
        return;
    }
}

export async function saveCreationConversations<T extends StoredCreationConversation>(conversations: T[], scope = getActiveUserScope()) {
    const jobs = conversations.map((conversation) => {
        if (!conversation?.id) throw new Error("缺少要保存的创作对话 ID");
        const key = scopeKey(scope, conversation.id);
        const generation = nextGeneration(key);
        pendingWrites.set(key, { generation, document: conversation });
        return captureDraft(scope, conversation.id, conversation).then(() => {
            rejectIfScopeChanged(scope);
            return enqueue(scope, conversation.id, () => flushConversation(scope, conversation.id));
        });
    });
    await Promise.all(jobs);
}

export async function deleteCreationConversation(conversationId: string, scope = getActiveUserScope()) {
    if (!conversationId) throw new Error("缺少要删除的创作对话 ID");
    return enqueue(scope, conversationId, async () => {
        rejectIfScopeChanged(scope);
        const expectedRevision = committed.get(scopeKey(scope, conversationId))?.revision ?? 0;
        try {
            await creationConversationsApi.remove(conversationId, expectedRevision);
        } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
        }
        rejectIfScopeChanged(scope);
        forgetCommitted(scope, conversationId);
        await rememberTombstones(scope, [conversationId]);
        await withScopeStorage(scope, async () => {
            await removeDraft(scope, conversationId);
            await removeLegacyConversation(scope, conversationId);
        });
    });
}

export function resetCreationConversationStoreForTests() {
    committed.clear();
    writeQueues.clear();
    storageQueues.clear();
    pendingWrites.clear();
    writeGenerations.clear();
}
