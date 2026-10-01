import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { ApiError } from "@/services/api/request";
import { creationConversationsApi, type CreationConversationDocument } from "@/services/api/creation-conversations";

export const CREATION_CONVERSATIONS_KEY = "creation-conversations-v1";
const CREATION_CONVERSATION_DRAFTS_KEY = "creation-conversation-drafts-v1";

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

type ConversationDraft = {
    baseRevision: number;
    document: StoredCreationConversation;
};

type DraftMap = Record<string, ConversationDraft>;

type CommittedState = {
    revision: number;
    fingerprint: string;
};

const committed = new Map<string, CommittedState>();
const writeQueues = new Map<string, Promise<unknown>>();
const pendingDocuments = new Map<string, StoredCreationConversation>();

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

function rememberCommitted(scope: string, id: string, revision: number, document: StoredCreationConversation) {
    committed.set(scopeKey(scope, id), { revision, fingerprint: fingerprintOf(document) });
}

function forgetCommitted(scope: string, id: string) {
    committed.delete(scopeKey(scope, id));
    pendingDocuments.delete(scopeKey(scope, id));
}

function fingerprintOf(document: StoredCreationConversation) {
    return JSON.stringify(persistableDocument(document));
}

function persistableDocument(conversation: StoredCreationConversation): CreationConversationDocument {
    const { revision: _revision, pending: _pending, ...rest } = conversation;
    return stripTempBlobs(rest) as CreationConversationDocument;
}

function stripTempBlobs(value: unknown): unknown {
    if (typeof value === "string") {
        const trimmed = value.trim().toLowerCase();
        if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return undefined;
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(stripTempBlobs).filter((item) => item !== undefined);
    }
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            const cleaned = stripTempBlobs(item);
            if (cleaned !== undefined) out[key] = cleaned;
        }
        return out;
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

async function readDrafts(scope: string): Promise<DraftMap> {
    const storage = localForageStorageForScope(scope);
    const value = await storage.getItem(CREATION_CONVERSATION_DRAFTS_KEY);
    if (!value) return {};
    try {
        const parsed = JSON.parse(value) as DraftMap;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        throw new Error("创作对话草稿无效");
    }
}

async function writeDrafts(scope: string, drafts: DraftMap) {
    const storage = localForageStorageForScope(scope);
    await storage.setItem(CREATION_CONVERSATION_DRAFTS_KEY, JSON.stringify(drafts));
}

async function upsertDraft(scope: string, id: string, document: StoredCreationConversation, baseRevision: number) {
    const drafts = await readDrafts(scope);
    drafts[id] = { baseRevision, document };
    await writeDrafts(scope, drafts);
}

async function clearDraft(scope: string, id: string) {
    const drafts = await readDrafts(scope);
    if (!(id in drafts)) return;
    delete drafts[id];
    await writeDrafts(scope, drafts);
}

function documentFromRecord(record: { id: string; document?: CreationConversationDocument }): StoredCreationConversation {
    const document = record.document;
    if (!document || typeof document !== "object") {
        return { id: record.id, messages: [] };
    }
    const messages = Array.isArray(document.messages) ? document.messages : [];
    return { ...document, id: record.id, messages } as StoredCreationConversation;
}

export async function loadLocalCreationConversationDrafts<T extends StoredCreationConversation>() {
    const scope = getActiveUserScope();
    const drafts = await readDrafts(scope);
    const legacy = await readLegacyArray(scope);
    const byId = new Map<string, T>();
    for (const item of legacy || []) {
        if (item?.id) byId.set(item.id, item as T);
    }
    for (const [id, draft] of Object.entries(drafts)) {
        if (draft?.document?.id) byId.set(id, draft.document as T);
    }
    return byId.size ? Array.from(byId.values()) : null;
}

export async function loadCreationConversations<T extends StoredCreationConversation>() {
    const scope = getActiveUserScope();
    const listed = await creationConversationsApi.list();
    rejectIfScopeChanged(scope);
    const deleted = new Set(listed.deletedIds || []);
    const committedRecords = new Map((listed.conversations || []).map((item) => [item.id, item]));
    const legacy = await readLegacyArray(scope);
    rejectIfScopeChanged(scope);
    for (const local of legacy || []) {
        if (!local?.id || deleted.has(local.id) || committedRecords.has(local.id)) continue;
        const imported = await creationConversationsApi.importLegacy({
            operationId: `${CREATION_CONVERSATIONS_KEY}:${local.id}`,
            document: persistableDocument(local),
        });
        rejectIfScopeChanged(scope);
        if (imported.deleted) {
            deleted.add(imported.id);
            continue;
        }
        if (imported.conversation?.id) committedRecords.set(imported.conversation.id, imported.conversation);
    }
    const drafts = await readDrafts(scope);
    rejectIfScopeChanged(scope);
    const loaded: T[] = [];
    for (const record of committedRecords.values()) {
        if (record.deleted || deleted.has(record.id)) continue;
        const document = documentFromRecord(record);
        rememberCommitted(scope, record.id, record.revision, document);
        const draft = drafts[record.id];
        if (draft?.document && draft.baseRevision === record.revision) {
            loaded.push(draft.document as T);
            continue;
        }
        loaded.push(document as T);
    }
    for (const [id, draft] of Object.entries(drafts)) {
        if (!draft?.document || committedRecords.has(id) || deleted.has(id)) continue;
        loaded.push(draft.document as T);
        rememberCommitted(scope, id, 0, { id, messages: [] });
    }
    return loaded.length ? loaded : null;
}

async function flushConversation(scope: string, id: string) {
    rejectIfScopeChanged(scope);
    const document = pendingDocuments.get(scopeKey(scope, id));
    if (!document) return;
    const state = committed.get(scopeKey(scope, id));
    const expectedRevision = state?.revision ?? 0;
    if (state && fingerprintOf(document) === state.fingerprint) {
        pendingDocuments.delete(scopeKey(scope, id));
        await clearDraft(scope, id);
        return;
    }
    await upsertDraft(scope, id, document, expectedRevision);
    rejectIfScopeChanged(scope);
    const saved = await creationConversationsApi.put(id, {
        expectedRevision,
        document: persistableDocument(document),
    });
    rejectIfScopeChanged(scope);
    // 指纹用本地已发送内容：服务端 JSON 键序变化不能当成新版本。
    rememberCommitted(scope, id, saved.revision, document);
    pendingDocuments.delete(scopeKey(scope, id));
    await clearDraft(scope, id);
}

export async function saveCreationConversations<T extends StoredCreationConversation>(conversations: T[]) {
    const scope = getActiveUserScope();
    const jobs = conversations.map((conversation) => {
        if (!conversation?.id) throw new Error("缺少要保存的创作对话 ID");
        pendingDocuments.set(scopeKey(scope, conversation.id), conversation);
        return enqueue(scope, conversation.id, () => flushConversation(scope, conversation.id));
    });
    await Promise.all(jobs);
}

export async function deleteCreationConversation(conversationId: string) {
    if (!conversationId) throw new Error("缺少要删除的创作对话 ID");
    const scope = getActiveUserScope();
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
        await clearDraft(scope, conversationId);
        const legacy = await readLegacyArray(scope);
        if (legacy) await writeLegacyArray(scope, legacy.filter((item) => item.id !== conversationId));
    });
}

export function resetCreationConversationStoreForTests() {
    committed.clear();
    writeQueues.clear();
    pendingDocuments.clear();
}
