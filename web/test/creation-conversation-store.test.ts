import { beforeEach, expect, mock, test } from "bun:test";
import { ApiError } from "@/services/api/request";

type Stored = Map<string, string>;
const stored: Stored = new Map();
let activeScope = "guest";

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
    putHold: null as Promise<void> | null,
    releasePut: null as (() => void) | null,
    putEntered: 0,
};

function failIfNeeded() {
    if (!server.failNext) return;
    const failure = server.failNext;
    server.failNext = null;
    throw new ApiError(failure.message || "保存失败", { status: failure.status, reason: failure.reason });
}

function holdPuts() {
    server.putHold = new Promise((resolve) => {
        server.releasePut = resolve;
    });
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

mock.module("@/services/api/creation-conversations", () => ({
    creationConversationsApi: {
        list: async () => {
            failIfNeeded();
            return {
                conversations: Array.from(server.conversations.values()).filter((item) => !item.deleted),
                deletedIds: Array.from(server.deleted),
            };
        },
        get: async (id: string) => {
            failIfNeeded();
            const existing = server.conversations.get(id);
            if (!existing || existing.deleted) throw new ApiError("创作对话不存在", { status: 404, reason: "not_found" });
            return existing;
        },
        put: async (id: string, input: { expectedRevision: number; document: { id: string; title?: string; messages: Array<Record<string, unknown>> } }) => {
            server.putEntered += 1;
            if (server.putHold) await server.putHold;
            failIfNeeded();
            server.puts.push({ id, expectedRevision: input.expectedRevision, title: input.document.title });
            const existing = server.conversations.get(id);
            if (!existing && input.expectedRevision !== 0) throw new ApiError("对话已更新，当前草稿未覆盖已保存内容", { status: 409, reason: "conflict" });
            if (existing?.deleted) throw new ApiError("对话已删除，无法再写入", { status: 409, reason: "conflict" });
            if (existing && existing.revision !== input.expectedRevision) {
                if (existing.revision === input.expectedRevision + 1 && JSON.stringify(existing.document) === JSON.stringify(input.document)) return existing;
                throw new ApiError("对话已更新，当前草稿未覆盖已保存内容", { status: 409, reason: "conflict" });
            }
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
    server.putHold = null;
    server.releasePut = null;
    server.putEntered = 0;
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
    const leftover = JSON.parse(stored.get(`guest:${CREATION_CONVERSATIONS_KEY}`) || "[]") as Array<{ id: string }>;
    expect(leftover.map((item) => item.id)).toEqual(["gone"]);
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

test("held write then later save still persists the latest document", async () => {
    holdPuts();
    const first = saveCreationConversations([{ id: "shared", title: "A", messages: [] }]);
    while (server.putEntered === 0) await Promise.resolve();
    const second = saveCreationConversations([{ id: "shared", title: "B", messages: [] }]);
    server.releasePut?.();
    await Promise.all([first, second]);
    expect(server.conversations.get("shared")?.document?.title).toBe("B");
    expect(server.puts.map((item) => item.title)).toEqual(["A", "B"]);
});

test("different conversation drafts survive concurrent saves", async () => {
    await Promise.all([
        saveCreationConversations([{ id: "left", title: "左", messages: [] }]),
        saveCreationConversations([{ id: "right", title: "右", messages: [] }]),
    ]);
    expect(server.conversations.get("left")?.document?.title).toBe("左");
    expect(server.conversations.get("right")?.document?.title).toBe("右");
});

test("failed write then reload recovers the latest draft", async () => {
    const latest = { id: "recover", title: "最新草稿", messages: [{ id: "m1", role: "user" as const, content: "data: keep this prompt" }] };
    server.failNext = { status: 500, message: "对话保存失败" };
    await expect(saveCreationConversations([latest])).rejects.toThrow("对话保存失败");
    resetCreationConversationStoreForTests();
    const recovered = await loadLocalCreationConversationDrafts("guest");
    expect(recovered?.find((item) => item.id === "recover")).toMatchObject({ title: "最新草稿" });
    expect(recovered?.find((item) => item.id === "recover")?.messages[0]).toMatchObject({ content: "data: keep this prompt" });
});

test("conflicting local draft stays visible and does not overwrite remote", async () => {
    server.conversations.set("live", { id: "live", revision: 5, updatedAt: "2026-10-02T00:00:00.000Z", document: { id: "live", title: "后端", messages: [] } });
    stored.set("guest:creation-conversation-drafts-v1:live", JSON.stringify({
        baseRevision: 4,
        document: { id: "live", title: "本地编辑", messages: [{ id: "m1", role: "user", content: "未提交" }] },
    }));
    stored.set("guest:creation-conversation-drafts-v1:index", JSON.stringify(["live"]));
    const loaded = await loadCreationConversations();
    expect(loaded?.find((item) => item.id === "live")).toMatchObject({ title: "本地编辑" });
    expect(loaded?.find((item) => item.id === "live")?.conflictRemote).toMatchObject({ revision: 5, document: { title: "后端" } });
    await expect(saveCreationConversations(loaded || [])).rejects.toThrow("对话已更新，当前草稿未覆盖已保存内容");
    expect(server.conversations.get("live")?.document?.title).toBe("后端");
    expect(server.conversations.get("live")?.revision).toBe(5);
});

test("fallback after remote reject keeps original scope and skips cached tombstones", async () => {
    server.conversations.set("kept", { id: "kept", revision: 1, updatedAt: "2026-10-02T00:00:00.000Z", document: { id: "kept", title: "后端", messages: [] } });
    server.deleted.add("gone");
    stored.set(`guest:${CREATION_CONVERSATIONS_KEY}`, JSON.stringify([
        { id: "gone", title: "墓碑", messages: [] },
    ]));
    stored.set("guest:creation-conversation-drafts-v1:drafty", JSON.stringify({
        baseRevision: 0,
        document: { id: "drafty", title: "原工作区草稿", messages: [] },
    }));
    stored.set("guest:creation-conversation-drafts-v1:index", JSON.stringify(["drafty"]));
    stored.set("other-workspace:creation-conversation-drafts-v1:other", JSON.stringify({
        baseRevision: 0,
        document: { id: "other", title: "新工作区", messages: [] },
    }));
    stored.set("other-workspace:creation-conversation-drafts-v1:index", JSON.stringify(["other"]));
    await loadCreationConversations("guest");
    server.failNext = { status: 500, message: "对话加载失败" };
    await expect(loadCreationConversations("guest")).rejects.toThrow("对话加载失败");
    activeScope = "other-workspace";
    const fallback = await loadLocalCreationConversationDrafts("guest");
    expect(fallback?.map((item) => item.id).sort()).toEqual(["drafty"]);
    expect(fallback?.find((item) => item.id === "gone")).toBeUndefined();
});

test("lost ack of the same document is recovered without a permanent 409", async () => {
    const draft = { id: "replay", title: "原稿", messages: [{ id: "m1", role: "user" as const, content: "hi" }] };
    await saveCreationConversations([draft]);
    expect(server.conversations.get("replay")?.revision).toBe(1);
    resetCreationConversationStoreForTests();
    await saveCreationConversations([draft]);
    expect(server.conversations.get("replay")?.revision).toBe(1);
    expect(server.conversations.get("replay")?.document?.title).toBe("原稿");
});

test("blob-only attachment is a recoverable persist failure", async () => {
    const draft = {
        id: "blob-only",
        title: "附件",
        messages: [{ id: "m1", role: "user" as const, content: "hi", attachments: [{ id: "a1", dataUrl: "data:image/png;base64,aaaa" }] }],
    };
    await expect(saveCreationConversations([draft])).rejects.toThrow("附件没有可恢复的存储引用");
    expect(server.puts).toHaveLength(0);
    const local = await loadLocalCreationConversationDrafts();
    expect(local?.find((item) => item.id === "blob-only")).toMatchObject({ title: "附件" });
});
