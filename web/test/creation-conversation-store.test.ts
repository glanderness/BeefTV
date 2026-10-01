import { beforeEach, expect, mock, test } from "bun:test";

type Stored = Map<string, string>;
const stored: Stored = new Map();
let activeScope = "guest";

class ApiError extends Error {
    status?: number;
    reason?: string;
    constructor(message: string, options: { status?: number; reason?: string } = {}) {
        super(message);
        this.status = options.status;
        this.reason = options.reason;
    }
}

type RecordShape = {
    id: string;
    revision: number;
    updatedAt: string;
    deleted?: boolean;
    document?: { id: string; title?: string; messages: Array<Record<string, unknown>> };
};

const server = {
    conversations: new Map<string, RecordShape>(),
    deleted: new Set<string>(),
    failNext: null as { status: number; reason?: string; message?: string } | null,
    puts: [] as Array<{ id: string; expectedRevision: number; title?: string }>,
    imports: [] as string[],
};

function failIfNeeded() {
    if (!server.failNext) return;
    const failure = server.failNext;
    server.failNext = null;
    throw new ApiError(failure.message || "保存失败", { status: failure.status, reason: failure.reason });
}

mock.module("@/lib/localforage-storage", () => ({
    localForageStorageForScope: (scope?: string) => ({
        getItem: async (name: string) => stored.get(`${scope ?? activeScope}:${name}`) ?? null,
        setItem: async (name: string, value: string) => { stored.set(`${scope ?? activeScope}:${name}`, value); },
        removeItem: async (name: string) => { stored.delete(`${scope ?? activeScope}:${name}`); },
    }),
    localForageStorage: {
        getItem: async (name: string) => stored.get(`${activeScope}:${name}`) ?? null,
        setItem: async (name: string, value: string) => { stored.set(`${activeScope}:${name}`, value); },
        removeItem: async (name: string) => { stored.delete(`${activeScope}:${name}`); },
    },
}));

mock.module("@/lib/user-scope", () => ({
    getActiveUserScope: () => activeScope,
    scopedStorageKey: (name: string, scope = activeScope) => `${name}:user:${scope}`,
    scopedLocalStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

mock.module("@/services/api/request", () => ({
    ApiError,
    http: { get: async () => ({}), put: async () => ({}), post: async () => ({}), delete: async () => ({}) },
}));

mock.module("@/services/api/creation-conversations", () => ({
    creationConversationsApi: {
        list: async () => {
            failIfNeeded();
            return {
                conversations: Array.from(server.conversations.values()).filter((item) => !item.deleted),
                deletedIds: Array.from(server.deleted),
            };
        },
        put: async (id: string, input: { expectedRevision: number; document: { id: string; title?: string; messages: Array<Record<string, unknown>> } }) => {
            failIfNeeded();
            server.puts.push({ id, expectedRevision: input.expectedRevision, title: input.document.title });
            const existing = server.conversations.get(id);
            if (!existing && input.expectedRevision !== 0) throw new ApiError("对话已更新，当前草稿未覆盖已保存内容", { status: 409, reason: "conflict" });
            if (existing?.deleted) throw new ApiError("对话已删除，无法再写入", { status: 409, reason: "conflict" });
            if (existing && existing.revision !== input.expectedRevision) throw new ApiError("对话已更新，当前草稿未覆盖已保存内容", { status: 409, reason: "conflict" });
            const record: RecordShape = {
                id,
                revision: (existing?.revision ?? 0) + 1,
                updatedAt: "2026-10-02T00:00:00.000Z",
                document: {
                    messages: input.document.messages,
                    title: input.document.title,
                    id: input.document.id,
                },
            };
            server.conversations.set(id, record);
            return record;
        },
        remove: async (id: string) => {
            failIfNeeded();
            const existing = server.conversations.get(id);
            if (!existing) throw new ApiError("创作对话不存在", { status: 404, reason: "not_found" });
            existing.deleted = true;
            existing.revision += 1;
            server.deleted.add(id);
            return { id, revision: existing.revision, updatedAt: "2026-10-02T00:00:00.000Z", deleted: true };
        },
        importLegacy: async (input: { operationId: string; document: { id: string } }) => {
            failIfNeeded();
            server.imports.push(input.operationId);
            if (server.deleted.has(input.document.id)) {
                return { imported: false, id: input.document.id, deleted: true, conversation: { id: input.document.id, revision: 1, updatedAt: "2026-10-02T00:00:00.000Z", deleted: true } };
            }
            const existing = server.conversations.get(input.document.id);
            if (existing) return { imported: false, id: existing.id, conversation: existing };
            const record: RecordShape = {
                id: input.document.id,
                revision: 1,
                updatedAt: "2026-10-02T00:00:00.000Z",
                document: input.document as RecordShape["document"],
            };
            server.conversations.set(record.id, record);
            return { imported: true, id: record.id, conversation: record };
        },
    },
}));

const {
    CREATION_CONVERSATIONS_KEY,
    loadCreationConversations,
    loadLocalCreationConversationDrafts,
    saveCreationConversations,
    deleteCreationConversation,
    resetCreationConversationStoreForTests,
} = await import("@/services/creation-conversation-store");

beforeEach(() => {
    stored.clear();
    server.conversations.clear();
    server.deleted.clear();
    server.failNext = null;
    server.puts = [];
    server.imports = [];
    activeScope = "guest";
    resetCreationConversationStoreForTests();
});

test("load imports IndexedDB only when backend has no record or tombstone", async () => {
    server.conversations.set("kept", { id: "kept", revision: 4, updatedAt: "2026-10-02T00:00:00.000Z", document: { id: "kept", title: "后端", messages: [] } });
    server.deleted.add("gone");
    stored.set(`guest:${CREATION_CONVERSATIONS_KEY}`, JSON.stringify([
        { id: "kept", title: "本地旧稿", messages: [] },
        { id: "gone", title: "已删", messages: [] },
        { id: "fresh", title: "待导入", messages: [{ id: "m1", role: "user", content: "hi" }] },
    ]));
    const loaded = await loadCreationConversations();
    expect(server.imports).toEqual(["creation-conversations-v1:fresh"]);
    expect(loaded?.map((item) => item.id).sort()).toEqual(["fresh", "kept"]);
    expect(loaded?.find((item) => item.id === "kept")).toMatchObject({ title: "后端" });
});

test("save failure keeps visible draft and does not mark server success", async () => {
    const draft = { id: "draft-1", title: "未发出", messages: [{ id: "m1", role: "user" as const, content: "镜头" }] };
    stored.set(`guest:${CREATION_CONVERSATIONS_KEY}`, JSON.stringify([draft]));
    server.failNext = { status: 500, message: "对话保存失败" };
    await expect(saveCreationConversations([draft])).rejects.toThrow("对话保存失败");
    expect(server.puts).toHaveLength(0);
    const local = await loadLocalCreationConversationDrafts();
    expect(local?.find((item) => item.id === "draft-1")).toMatchObject({ title: "未发出" });
    server.failNext = null;
    await saveCreationConversations([draft]);
    expect(server.puts).toEqual([{ id: "draft-1", expectedRevision: 0, title: "未发出" }]);
    expect(server.conversations.get("draft-1")?.revision).toBe(1);
    server.puts = [];
    await saveCreationConversations([draft]);
    expect(server.puts).toHaveLength(0);
});

test("scope switch rejects outstanding save", async () => {
    const draft = { id: "scope-1", title: "原工作区", messages: [] };
    const pending = saveCreationConversations([draft]);
    activeScope = "other-workspace";
    await expect(pending).rejects.toThrow("工作区已切换，已忽略过期对话结果");
    expect(server.puts).toHaveLength(0);
});

test("deleted tombstone is not resurrected by later save of local cache", async () => {
    await saveCreationConversations([{ id: "dead", title: "旧", messages: [] }]);
    await deleteCreationConversation("dead");
    expect(server.deleted.has("dead")).toBe(true);
    await expect(saveCreationConversations([{ id: "dead", title: "复活", messages: [] }])).rejects.toThrow("对话已删除，无法再写入");
    expect(server.conversations.get("dead")?.deleted).toBe(true);
    expect(server.conversations.get("dead")?.document?.title).toBe("旧");
});
