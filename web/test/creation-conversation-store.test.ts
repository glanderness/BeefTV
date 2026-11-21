import { beforeEach, expect, mock, test } from "bun:test";
import { ApiError } from "@/services/api/request";

let activeScope = "guest";

function switchScope(next: string) {
    activeScope = next;
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
    puts: [] as Array<{ id: string; expectedRevision: number; title?: string; messageCount: number }>,
    putHold: null as Promise<void> | null,
    releasePut: null as (() => void) | null,
    putEntered: 0,
    listHold: null as Promise<void> | null,
    releaseList: null as (() => void) | null,
    listEntered: 0,
    getHold: null as Promise<void> | null,
    releaseGet: null as (() => void) | null,
    getEntered: 0,
};

function failIfNeeded() {
    if (!server.failNext) return;
    const failure = server.failNext;
    server.failNext = null;
    throw new ApiError(failure.message || "保存失败", { status: failure.status, reason: failure.reason });
}

function holdPuts() {
    server.putEntered = 0;
    server.putHold = new Promise((resolve) => {
        server.releasePut = resolve;
    });
}

function holdList() {
    server.listHold = new Promise((resolve) => {
        server.releaseList = resolve;
    });
}

function holdGet() {
    server.getEntered = 0;
    server.getHold = new Promise((resolve) => {
        server.releaseGet = resolve;
    });
}

mock.module("@/lib/user-scope", () => ({
    getActiveUserScope: () => activeScope,
    onStorageNamespaceChange: () => () => undefined,
    setActiveUserScope: (userId?: string | null) => switchScope(userId || "guest"),
    scopedStorageKey: (name: string, scope = activeScope) => `${name}:user:${scope}`,
    scopedLocalStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

mock.module("@/services/api/creation-conversations", () => ({
    creationConversationsApi: {
        list: async () => {
            server.listEntered += 1;
            const snapshot = {
                conversations: Array.from(server.conversations.values())
                    .filter((item) => !item.deleted)
                    .map((item) => structuredClone(item)),
                deletedIds: Array.from(server.deleted),
            };
            if (server.listHold) await server.listHold;
            failIfNeeded();
            return snapshot;
        },
        get: async (id: string) => {
            server.getEntered += 1;
            const snapshot = server.conversations.get(id);
            const cloned = snapshot ? structuredClone(snapshot) : undefined;
            if (server.getHold) await server.getHold;
            failIfNeeded();
            if (!cloned || cloned.deleted) throw new ApiError("创作对话不存在", { status: 404, reason: "not_found" });
            return cloned;
        },
        put: async (id: string, input: { expectedRevision: number; document: { id: string; title?: string; messages: Array<Record<string, unknown>> } }) => {
            server.putEntered += 1;
            if (server.putHold) await server.putHold;
            failIfNeeded();
            const title = typeof input.document.title === "string" && input.document.title.trim() ? input.document.title.trim() : "新创作";
            server.puts.push({ id, expectedRevision: input.expectedRevision, title, messageCount: input.document.messages?.length ?? 0 });
            const existing = server.conversations.get(id);
            if (!existing && input.expectedRevision !== 0) throw new ApiError("对话已更新，当前草稿未覆盖已保存内容", { status: 409, reason: "conflict" });
            if (existing?.deleted) throw new ApiError("对话已删除，无法再写入", { status: 409, reason: "conflict" });
            const normalizedDocument = {
                messages: input.document.messages,
                title,
                id: input.document.id,
            };
            if (existing && existing.revision !== input.expectedRevision) {
                if (existing.revision === input.expectedRevision + 1 && JSON.stringify(existing.document) === JSON.stringify(normalizedDocument)) return existing;
                throw new ApiError("对话已更新，当前草稿未覆盖已保存内容", { status: 409, reason: "conflict" });
            }
            const record: RecordShape = {
                id,
                revision: (existing?.revision ?? 0) + 1,
                updatedAt: "2026-10-02T00:00:00.000Z",
                document: normalizedDocument,
            };
            server.conversations.set(id, record);
            return record;
        },
        remove: async (id: string, expectedRevision: number) => {
            failIfNeeded();
            const existing = server.conversations.get(id);
            if (!existing) throw new ApiError("创作对话不存在", { status: 404, reason: "not_found" });
            if (!existing.deleted && existing.revision !== expectedRevision) {
                throw new ApiError("对话版本冲突", { status: 409, reason: "conflict" });
            }
            existing.deleted = true;
            existing.revision += 1;
            server.deleted.add(id);
            return { id, revision: existing.revision, updatedAt: "2026-10-02T00:00:00.000Z", deleted: true };
        },
    },
}));

const {
    loadCreationConversations,
    saveCreationConversations,
    deleteCreationConversation,
    hasPendingCreationConversationWrites,
    resetCreationConversationStoreForTests,
    adoptServerConfirmedConversationDocument,
} = await import("@/services/creation-conversation-store");

beforeEach(() => {
    server.conversations.clear();
    server.deleted.clear();
    server.failNext = null;
    server.puts = [];
    server.putHold = null;
    server.releasePut = null;
    server.putEntered = 0;
    server.listHold = null;
    server.releaseList = null;
    server.listEntered = 0;
    server.getHold = null;
    server.releaseGet = null;
    server.getEntered = 0;
    activeScope = "guest";
    resetCreationConversationStoreForTests();
});

test("load returns canonical SQLite records, filters deleted ids, and propagates read errors", async () => {
    server.conversations.set("live", { id: "live", revision: 4, updatedAt: "2026-10-02T00:00:00.000Z", document: { id: "live", title: "后端", messages: [] } });
    server.deleted.add("gone");

    const loaded = await loadCreationConversations();
    expect(loaded?.map((item) => item.id)).toEqual(["live"]);
    expect(loaded?.[0]?.title).toBe("后端");

    server.failNext = { status: 500, message: "对话加载失败" };
    await expect(loadCreationConversations()).rejects.toThrow("对话加载失败");
});

test("save failure propagates cleanly, retry succeeds, and unchanged saves skip redundant PUT", async () => {
    const draft = { id: "draft-1", title: "未发出", messages: [{ id: "m1", role: "user" as const, content: "镜头" }] };
    server.failNext = { status: 500, message: "对话保存失败" };
    await expect(saveCreationConversations([draft])).rejects.toThrow("对话保存失败");
    expect(server.puts).toHaveLength(0);

    await saveCreationConversations([draft]);
    expect(server.puts).toEqual([{ id: "draft-1", expectedRevision: 0, title: "未发出", messageCount: 1 }]);
    expect(server.conversations.get("draft-1")?.revision).toBe(1);

    server.puts = [];
    await saveCreationConversations([draft]);
    expect(server.puts).toHaveLength(0);
});

test("deleted conversation is not resurrected by a later save", async () => {
    await saveCreationConversations([{ id: "dead", title: "旧", messages: [] }]);
    await deleteCreationConversation("dead");
    expect(server.deleted.has("dead")).toBe(true);
    await expect(saveCreationConversations([{ id: "dead", title: "复活", messages: [] }])).rejects.toThrow("对话已删除，无法再写入");
    expect(server.conversations.get("dead")?.deleted).toBe(true);
    expect(server.conversations.get("dead")?.document?.title).toBe("旧");
});

test("delete auto-rebases on 409 revision conflict and prevents stale in-flight load from restoring it", async () => {
    server.conversations.set("conv-del", { id: "conv-del", revision: 1, updatedAt: "2026-10-02T00:00:00.000Z", document: { id: "conv-del", title: "待删", messages: [] } });
    await loadCreationConversations();
    // Simulate background task attach bumping revision before user deletes.
    server.conversations.get("conv-del")!.revision = 3;

    holdList();
    const loading = loadCreationConversations();
    while (server.listEntered === 0) await Promise.resolve();

    await deleteCreationConversation("conv-del");
    expect(server.deleted.has("conv-del")).toBe(true);

    server.releaseList?.();
    const loaded = await loading;
    expect(loaded).toBeNull();
});

test("held write then later save serializes and persists the latest document", async () => {
    holdPuts();
    const first = saveCreationConversations([{ id: "shared", title: "A", messages: [] }]);
    while (server.putEntered === 0) await Promise.resolve();
    const second = saveCreationConversations([{ id: "shared", title: "B", messages: [] }]);
    server.releasePut?.();
    await Promise.all([first, second]);
    expect(server.conversations.get("shared")?.document?.title).toBe("B");
    expect(server.puts.map((item) => item.title)).toEqual(["A", "B"]);
});

test("different conversations persist concurrently without blocking each other", async () => {
    await Promise.all([
        saveCreationConversations([{ id: "left", title: "左", messages: [] }]),
        saveCreationConversations([{ id: "right", title: "右", messages: [] }]),
    ]);
    expect(server.conversations.get("left")?.document?.title).toBe("左");
    expect(server.conversations.get("right")?.document?.title).toBe("右");
});

test("409 revision conflict merges non-overlapping local edit onto latest SQLite record and retries", async () => {
    server.conversations.set("live", {
        id: "live",
        revision: 3,
        updatedAt: "2026-10-02T00:00:00.000Z",
        document: {
            id: "live",
            title: "原标题",
            messages: [
                { id: "u1", role: "user", content: "画一只猫" },
                { id: "a1", role: "assistant", status: "pending", content: "", taskIds: ["task-1"] },
            ],
        },
    });
    await loadCreationConversations();

    // Backend task attach advances SQLite to revision 4 while frontend still holds revision 3.
    server.conversations.set("live", {
        id: "live",
        revision: 4,
        updatedAt: "2026-10-02T00:01:00.000Z",
        document: {
            id: "live",
            title: "原标题",
            messages: [
                { id: "u1", role: "user", content: "画一只猫" },
                { id: "a1", role: "assistant", status: "done", content: "已生成", taskIds: ["task-1"], resultUrls: ["/api/resources/r1/file"] },
            ],
        },
    });

    await saveCreationConversations([{
        id: "live",
        title: "用户改名",
        messages: [
            { id: "u1", role: "user", content: "画一只猫" },
            { id: "a1", role: "assistant", status: "pending", content: "", taskIds: ["task-1"] },
            { id: "u2", role: "user", content: "再画一张" },
        ],
    }]);

    const final = server.conversations.get("live");
    expect(final?.revision).toBe(5);
    expect(final?.document?.title).toBe("用户改名");
    expect(final?.document?.messages.map((item) => item.id)).toEqual(["u1", "a1", "u2"]);
    expect(final?.document?.messages.find((item) => item.id === "a1")?.content).toBe("已生成");
    expect(server.puts.map((item) => item.expectedRevision)).toEqual([3, 4]);
});

test("lost ack of identical document recovers without error", async () => {
    const draft = { id: "replay", title: "原稿", messages: [{ id: "m1", role: "user" as const, content: "hi" }] };
    await saveCreationConversations([draft]);
    expect(server.conversations.get("replay")?.revision).toBe(1);
    resetCreationConversationStoreForTests();
    await saveCreationConversations([draft]);
    expect(server.conversations.get("replay")?.revision).toBe(1);
    expect(server.conversations.get("replay")?.document?.title).toBe("原稿");
});

test("blob-only attachment without storageKey is rejected before sending PUT", async () => {
    const draft = {
        id: "blob-only",
        title: "附件",
        messages: [{ id: "m1", role: "user" as const, content: "hi", attachments: [{ id: "a1", dataUrl: "data:image/png;base64,aaaa" }] }],
    };
    await expect(saveCreationConversations([draft])).rejects.toThrow("附件没有可恢复的存储引用");
    expect(server.puts).toHaveLength(0);
});

test("caller mutation during delayed PUT cannot change in-flight payload", async () => {
    holdPuts();
    const draft = { id: "mut", title: "原", messages: [{ id: "m1", role: "user" as const, content: "one" }] };
    const pending = saveCreationConversations([draft]);
    while (server.putEntered === 0) await Promise.resolve();
    draft.messages.push({ id: "m2", role: "user" as const, content: "two" });
    draft.title = "changed";
    server.releasePut?.();
    await pending;
    expect(server.puts[0]).toMatchObject({ id: "mut", title: "原", messageCount: 1 });
    expect(server.conversations.get("mut")?.document?.title).toBe("原");
    expect(server.conversations.get("mut")?.document?.messages).toHaveLength(1);
});

test("canonical untitled ack skips a second PUT and projects later edits", async () => {
    await saveCreationConversations([{ id: "untitled", messages: [] }]);
    expect(server.puts).toEqual([{ id: "untitled", expectedRevision: 0, title: "新创作", messageCount: 0 }]);
    server.puts = [];
    await saveCreationConversations([{ id: "untitled", messages: [] }]);
    expect(server.puts).toHaveLength(0);

    holdPuts();
    const first = saveCreationConversations([{ id: "proj", messages: [{ id: "m1", role: "user" as const, content: "a" }] }]);
    while (server.putEntered === 0) await Promise.resolve();
    const second = saveCreationConversations([{
        id: "proj",
        messages: [
            { id: "m1", role: "user" as const, content: "a" },
            { id: "m2", role: "user" as const, content: "b" },
        ],
    }]);
    server.releasePut?.();
    await Promise.all([first, second]);
    expect(server.puts.map((item) => item.title)).toEqual(["新创作", "新创作"]);
    expect(server.puts.map((item) => item.messageCount)).toEqual([1, 2]);
    expect(server.conversations.get("proj")?.document?.messages).toHaveLength(2);
});

test("adoptServerConfirmedConversationDocument adopts cleanly without PUT and refuses older receipts", async () => {
    const adopted = await adoptServerConfirmedConversationDocument("conv-1", {
        id: "conv-1",
        title: "已绑定",
        messages: [{ id: "msg-1", role: "assistant", content: "图片已生成" }],
    }, 5);
    expect(adopted.title).toBe("已绑定");
    expect(server.puts).toEqual([]);

    const older = await adoptServerConfirmedConversationDocument("conv-1", {
        id: "conv-1",
        title: "旧回执",
        messages: [{ id: "msg-1", role: "assistant", content: "旧内容" }],
    }, 3);
    expect(older.title).toBe("已绑定");
    expect((older.messages as Array<{ content?: string }>)[0]?.content).toBe("图片已生成");
});

test("adopt preserves concurrent user edits while in-flight PUT rebases onto server-confirmed revision", async () => {
    server.conversations.set("conv-1", {
        id: "conv-1",
        revision: 3,
        updatedAt: "2026-10-02T00:00:00.000Z",
        document: {
            id: "conv-1",
            title: "原稿",
            messages: [
                { id: "user-1", role: "user", content: "镜头" },
                { id: "msg-1", role: "assistant", status: "pending", content: "", taskIds: ["task-1"] },
            ],
        },
    });
    await loadCreationConversations();
    holdPuts();
    const saveP = saveCreationConversations([{
        id: "conv-1",
        title: "改名",
        messages: [
            { id: "user-1", role: "user", content: "镜头" },
            { id: "msg-1", role: "assistant", status: "pending", content: "", taskIds: ["task-1"] },
            { id: "user-2", role: "user", content: "补充" },
        ],
    }]);
    while (server.putEntered === 0) await Promise.resolve();

    // Simulate backend task attach advancing server revision to 5 before releasing PUT.
    const serverAttached = {
        id: "conv-1",
        title: "原稿",
        messages: [
            { id: "user-1", role: "user" as const, content: "镜头" },
            { id: "msg-1", role: "assistant" as const, status: "done", content: "图片已生成", taskIds: ["task-1"], resultUrls: ["/api/resources/res-1/file"] },
        ],
    };
    server.conversations.set("conv-1", { id: "conv-1", revision: 5, updatedAt: "2026-10-02T00:01:00.000Z", document: serverAttached });

    const adopted = await adoptServerConfirmedConversationDocument("conv-1", serverAttached, 5);
    expect(adopted.title).toBe("改名");
    expect((adopted.messages as Array<{ id: string }>).map((item) => item.id)).toEqual(["user-1", "msg-1", "user-2"]);
    expect((adopted.messages as Array<{ id: string; content?: string }>).find((item) => item.id === "msg-1")?.content).toBe("图片已生成");

    server.releasePut?.();
    await saveP;
    const final = server.conversations.get("conv-1");
    expect(final?.revision).toBe(6);
    expect(final?.document?.title).toBe("改名");
    expect(final?.document?.messages).toHaveLength(3);
    expect(final?.document?.messages.find((item) => item.id === "msg-1")?.content).toBe("图片已生成");
});

test("adopt keeps local title edit without resurrecting a remotely deleted message", async () => {
    server.conversations.set("conv-1", {
        id: "conv-1",
        revision: 3,
        updatedAt: "2026-10-02T00:00:00.000Z",
        document: { id: "conv-1", title: "原稿", messages: [{ id: "msg-1", role: "user", content: "旧消息" }] },
    });
    await loadCreationConversations();
    holdPuts();
    const saving = saveCreationConversations([{ id: "conv-1", title: "本地标题", messages: [{ id: "msg-1", role: "user", content: "旧消息" }] }]);
    while (!server.putEntered) await Promise.resolve();
    const serverDeletedMsg = { id: "conv-1", title: "原稿", messages: [] };
    server.conversations.set("conv-1", { id: "conv-1", revision: 5, updatedAt: "2026-10-02T00:01:00.000Z", document: serverDeletedMsg });
    const adopted = await adoptServerConfirmedConversationDocument("conv-1", serverDeletedMsg, 5);
    expect(adopted.title).toBe("本地标题");
    expect(adopted.messages).toEqual([]);
    server.releasePut?.();
    await saving;
    expect(server.conversations.get("conv-1")?.document).toMatchObject({ title: "本地标题", messages: [] });
});

test("failed PUT retains pending intent so subsequent adopt preserves user rename and appended message", async () => {
    server.conversations.set("conv-fail", {
        id: "conv-fail",
        revision: 2,
        updatedAt: "2026-10-02T00:00:00.000Z",
        document: {
            id: "conv-fail",
            title: "原标题",
            messages: [
                { id: "u1", role: "user", content: "画一只猫" },
                { id: "a1", role: "assistant", status: "pending", content: "", taskIds: ["task-1"] },
            ],
        },
    });
    await loadCreationConversations();

    const edited = {
        id: "conv-fail",
        title: "失败前改名",
        messages: [
            { id: "u1", role: "user" as const, content: "画一只猫" },
            { id: "a1", role: "assistant" as const, status: "pending", content: "", taskIds: ["task-1"] },
            { id: "u2", role: "user" as const, content: "顺便加个背景" },
        ],
    };
    server.failNext = { status: 500, message: "暂不可用" };
    await expect(saveCreationConversations([edited])).rejects.toThrow("暂不可用");

    // Backend task attach completes while the failed local edit is still pending.
    const serverAttached = {
        id: "conv-fail",
        title: "原标题",
        messages: [
            { id: "u1", role: "user" as const, content: "画一只猫" },
            { id: "a1", role: "assistant" as const, status: "done", content: "已生成", taskIds: ["task-1"], resultUrls: ["/api/resources/r1/file"] },
        ],
    };
    server.conversations.set("conv-fail", {
        id: "conv-fail",
        revision: 3,
        updatedAt: "2026-10-02T00:01:00.000Z",
        document: serverAttached,
    });

    const adopted = await adoptServerConfirmedConversationDocument("conv-fail", serverAttached, 3);
    expect(adopted.title).toBe("失败前改名");
    expect((adopted.messages as Array<{ id: string }>).map((item) => item.id)).toEqual(["u1", "a1", "u2"]);
    expect((adopted.messages as Array<{ id: string; content?: string }>).find((item) => item.id === "a1")?.content).toBe("已生成");

    // Follow-up save persists both the merged server result and the local edits onto revision 3.
    await saveCreationConversations([adopted]);
    const final = server.conversations.get("conv-fail");
    expect(final?.revision).toBe(4);
    expect(final?.document?.title).toBe("失败前改名");
    expect(final?.document?.messages.map((item) => item.id)).toEqual(["u1", "a1", "u2"]);
    expect(final?.document?.messages.find((item) => item.id === "a1")?.content).toBe("已生成");
});

test("cold-start adopt and 409 rebase without committed base keep server-confirmed message results and append local-only messages", async () => {
    // Case 1: cold-start adopt while initial PUT is still in flight (no committed base yet).
    holdPuts();
    const initial = saveCreationConversations([{
        id: "cold-1",
        title: "我的对话",
        messages: [
            { id: "u1", role: "user", content: "第一句" },
            { id: "a1", role: "assistant", status: "pending", content: "", taskIds: ["task-1"] },
            { id: "u2", role: "user", content: "本地追加" },
        ],
    }]);
    while (server.putEntered === 0) await Promise.resolve();

    const serverConfirmed = {
        id: "cold-1",
        title: "新创作",
        messages: [
            { id: "u1", role: "user" as const, content: "第一句" },
            { id: "a1", role: "assistant" as const, status: "done", content: "云端回执", taskIds: ["task-1"], resultUrls: ["/api/resources/r9/file"] },
            { id: "s1", role: "assistant" as const, status: "done", content: "服务端补齐" },
        ],
    };
    server.conversations.set("cold-1", {
        id: "cold-1",
        revision: 2,
        updatedAt: "2026-10-02T00:01:00.000Z",
        document: serverConfirmed,
    });

    const adopted = await adoptServerConfirmedConversationDocument("cold-1", serverConfirmed, 2);
    expect(adopted.title).toBe("我的对话");
    expect((adopted.messages as Array<{ id: string }>).map((item) => item.id)).toEqual(["u1", "a1", "s1", "u2"]);
    expect((adopted.messages as Array<{ id: string; content?: string }>).find((item) => item.id === "a1")?.content).toBe("云端回执");

    server.releasePut?.();
    await initial;
    const savedCold1 = server.conversations.get("cold-1");
    expect(savedCold1?.revision).toBe(3);
    expect(savedCold1?.document?.messages.map((item) => item.id)).toEqual(["u1", "a1", "s1", "u2"]);
    expect(savedCold1?.document?.messages.find((item) => item.id === "a1")?.content).toBe("云端回执");

    // Case 2: cold-start 409 GET rebase with no committed base does not clobber canonical result.
    server.conversations.set("cold-2", {
        id: "cold-2",
        revision: 2,
        updatedAt: "2026-10-02T00:01:00.000Z",
        document: {
            id: "cold-2",
            title: "服务端标题",
            messages: [
                { id: "u1", role: "user", content: "起稿" },
                { id: "a1", role: "assistant", status: "done", content: "已完成", resultUrls: ["/api/resources/r2/file"] },
            ],
        },
    });
    await saveCreationConversations([{
        id: "cold-2",
        title: "旧本地标题",
        messages: [
            { id: "u1", role: "user", content: "起稿" },
            { id: "a1", role: "assistant", status: "pending", content: "" },
            { id: "u2", role: "user", content: "新追问" },
        ],
    }]);
    const savedCold2 = server.conversations.get("cold-2");
    expect(savedCold2?.revision).toBe(3);
    expect(savedCold2?.document?.title).toBe("服务端标题");
    expect(savedCold2?.document?.messages.map((item) => item.id)).toEqual(["u1", "a1", "u2"]);
    expect(savedCold2?.document?.messages.find((item) => item.id === "a1")?.content).toBe("已完成");
});

test("invalid attachment in one conversation does not block saving valid sibling conversations", async () => {
    const validBefore = { id: "valid-before", title: "前一条", messages: [{ id: "m1", role: "user" as const, content: "ok" }] };
    const invalidMid = {
        id: "invalid-mid",
        title: "坏附件",
        messages: [{ id: "m2", role: "user" as const, content: "bad", attachments: [{ id: "a1", dataUrl: "data:image/png;base64,aaaa" }] }],
    };
    const validAfter = { id: "valid-after", title: "后一条", messages: [{ id: "m3", role: "user" as const, content: "still ok" }] };

    await expect(saveCreationConversations([validBefore, invalidMid, validAfter])).rejects.toThrow("附件没有可恢复的存储引用");
    expect(server.conversations.get("valid-before")?.document?.title).toBe("前一条");
    expect(server.conversations.get("valid-after")?.document?.title).toBe("后一条");
    expect(server.conversations.has("invalid-mid")).toBe(false);
});

test("409 GET rebase ignores stale GET response when adopt advanced committed revision in flight", async () => {
    server.conversations.set("race-get", {
        id: "race-get",
        revision: 1,
        updatedAt: "2026-10-02T00:00:00.000Z",
        document: {
            id: "race-get",
            title: "原标题",
            messages: [
                { id: "u1", role: "user", content: "画一只猫" },
                { id: "a1", role: "assistant", status: "pending", content: "", taskIds: ["t1"] },
            ],
        },
    });
    await loadCreationConversations();

    // Advance server to revision 2 so the user's PUT gets 409 and enters GET rebase.
    server.conversations.set("race-get", {
        id: "race-get",
        revision: 2,
        updatedAt: "2026-10-02T00:01:00.000Z",
        document: {
            id: "race-get",
            title: "原标题",
            messages: [
                { id: "u1", role: "user", content: "画一只猫" },
                { id: "a1", role: "assistant", status: "pending", content: "中间态", taskIds: ["t1"] },
            ],
        },
    });

    holdGet();
    const saving = saveCreationConversations([{
        id: "race-get",
        title: "用户改名",
        messages: [
            { id: "u1", role: "user", content: "画一只猫" },
            { id: "a1", role: "assistant", status: "pending", content: "", taskIds: ["t1"] },
        ],
    }]);
    while (server.getEntered === 0) await Promise.resolve();

    // While GET (which snapshotted rev 2) is held, backend attach advances server to rev 4 and calls adopt.
    const rev4Doc = {
        id: "race-get",
        title: "原标题",
        messages: [
            { id: "u1", role: "user" as const, content: "画一只猫" },
            { id: "a1", role: "assistant" as const, status: "done", content: "最终成图", taskIds: ["t1"], resultUrls: ["/api/resources/r4/file"] },
        ],
    };
    server.conversations.set("race-get", {
        id: "race-get",
        revision: 4,
        updatedAt: "2026-10-02T00:02:00.000Z",
        document: rev4Doc,
    });
    await adoptServerConfirmedConversationDocument("race-get", rev4Doc, 4);

    // Release stale rev-2 GET: flush must NOT overwrite rev 4's "最终成图" with rev 2's "中间态".
    server.releaseGet?.();
    await saving;
    const final = server.conversations.get("race-get");
    expect(final?.revision).toBe(5);
    expect(final?.document?.title).toBe("用户改名");
    expect(final?.document?.messages.find((item) => item.id === "a1")?.content).toBe("最终成图");
    expect(final?.document?.messages.find((item) => item.id === "a1")?.resultUrls).toEqual(["/api/resources/r4/file"]);
});

test("load surfaces unsaved new conversation after initial PUT failure and drops tombstoned pending ids", async () => {
    server.conversations.set("existing", {
        id: "existing",
        revision: 1,
        updatedAt: "2026-10-02T00:00:00.000Z",
        document: { id: "existing", title: "已有对话", messages: [] },
    });

    const unsavedNew = { id: "new-unsaved", title: "首次失败的新对话", messages: [{ id: "m1", role: "user" as const, content: "草稿" }] };
    server.failNext = { status: 500, message: "临时故障" };
    await expect(saveCreationConversations([unsavedNew])).rejects.toThrow("临时故障");
    expect(hasPendingCreationConversationWrites()).toBe(true);

    // Remounting /create loads server records plus the unsaved pending conversation.
    const reloaded = await loadCreationConversations();
    expect(reloaded?.map((item) => item.id)).toEqual(["new-unsaved", "existing"]);
    expect(reloaded?.[0]?.title).toBe("首次失败的新对话");
    expect(hasPendingCreationConversationWrites()).toBe(true);

    // If the pending id is later confirmed tombstoned in SQLite, load drops it instead of surfacing it.
    server.deleted.add("new-unsaved");
    const afterTombstone = await loadCreationConversations();
    expect(afterTombstone?.map((item) => item.id)).toEqual(["existing"]);
    expect(hasPendingCreationConversationWrites()).toBe(false);
});

test("lost ack on initial PUT followed by same-id edit and 409 rebase preserves both local edit and server result", async () => {
    // Simulate first PUT committed on server at rev 1, but client never saw the ack (transient error after server write).
    const initial = {
        id: "lost-ack-1",
        title: "初版标题",
        messages: [
            { id: "u1", role: "user" as const, content: "初版提示词" },
            { id: "a1", role: "assistant" as const, status: "pending", content: "", taskIds: ["task-1"] },
        ],
    };
    server.conversations.set("lost-ack-1", {
        id: "lost-ack-1",
        revision: 1,
        updatedAt: "2026-10-02T00:00:00.000Z",
        document: structuredClone(initial),
    });
    server.failNext = { status: 500, message: "响应丢失" };
    await expect(saveCreationConversations([initial])).rejects.toThrow("响应丢失");

    // Backend task attach advances server to rev 2 while user edits title AND same-id user message u1.
    const serverAttached = {
        id: "lost-ack-1",
        title: "初版标题",
        messages: [
            { id: "u1", role: "user" as const, content: "初版提示词" },
            { id: "a1", role: "assistant" as const, status: "done", content: "生成完成", taskIds: ["task-1"], resultUrls: ["/api/resources/r1/file"] },
        ],
    };
    server.conversations.set("lost-ack-1", {
        id: "lost-ack-1",
        revision: 2,
        updatedAt: "2026-10-02T00:01:00.000Z",
        document: serverAttached,
    });

    const userEdited = {
        id: "lost-ack-1",
        title: "用户二次改名",
        messages: [
            { id: "u1", role: "user" as const, content: "用户补充后的提示词" },
            { id: "a1", role: "assistant" as const, status: "pending", content: "", taskIds: ["task-1"] },
        ],
    };
    // Retry PUT (expectedRevision 0 -> 409) rebases using sentDocument as true 3-way ancestor!
    await saveCreationConversations([userEdited]);
    const final = server.conversations.get("lost-ack-1");
    expect(final?.revision).toBe(3);
    expect(final?.document?.title).toBe("用户二次改名");
    expect(final?.document?.messages.find((item) => item.id === "u1")?.content).toBe("用户补充后的提示词");
    expect(final?.document?.messages.find((item) => item.id === "a1")?.content).toBe("生成完成");
});

test("lost ack on initial PUT followed by direct adopt preserves both local edit and server result via sentDocument", async () => {
    const initial = {
        id: "lost-ack-adopt",
        title: "初版标题",
        messages: [
            { id: "u1", role: "user" as const, content: "初版提示词" },
            { id: "a1", role: "assistant" as const, status: "pending", content: "", taskIds: ["task-adopt"] },
        ],
    };
    server.failNext = { status: 500, message: "响应丢失" };
    await expect(saveCreationConversations([initial])).rejects.toThrow("响应丢失");

    const userEdited = {
        id: "lost-ack-adopt",
        title: "用户二次改名",
        messages: [
            { id: "u1", role: "user" as const, content: "用户补充后的提示词" },
            { id: "a1", role: "assistant" as const, status: "pending", content: "", taskIds: ["task-adopt"] },
        ],
    };
    server.failNext = { status: 500, message: "暂时离线" };
    await expect(saveCreationConversations([userEdited])).rejects.toThrow("暂时离线");

    // No prior loadCreationConversations: committed is empty, so adopt must use pending.sentDocument.
    const serverAttached = {
        id: "lost-ack-adopt",
        title: "初版标题",
        messages: [
            { id: "u1", role: "user" as const, content: "初版提示词" },
            { id: "a1", role: "assistant" as const, status: "done", content: "生成完成", taskIds: ["task-adopt"], resultUrls: ["/api/resources/r2/file"] },
        ],
    };
    server.conversations.set("lost-ack-adopt", {
        id: "lost-ack-adopt",
        revision: 2,
        updatedAt: "2026-10-02T00:02:00.000Z",
        document: serverAttached,
    });

    const adopted = await adoptServerConfirmedConversationDocument("lost-ack-adopt", serverAttached, 2);
    expect(adopted.title).toBe("用户二次改名");
    expect(adopted.messages.find((item) => item.id === "u1")?.content).toBe("用户补充后的提示词");
    expect(adopted.messages.find((item) => item.id === "a1")?.content).toBe("生成完成");

    await saveCreationConversations([adopted]);
    const final = server.conversations.get("lost-ack-adopt");
    expect(final?.revision).toBe(3);
    expect(final?.document?.title).toBe("用户二次改名");
    expect(final?.document?.messages.find((item) => item.id === "u1")?.content).toBe("用户补充后的提示词");
    expect(final?.document?.messages.find((item) => item.id === "a1")?.content).toBe("生成完成");
});

test("lost ack on initial PUT followed by loadCreationConversations preserves both local edit and server result via sentDocument", async () => {
    const initial = {
        id: "lost-ack-load",
        title: "初版标题",
        messages: [
            { id: "u1", role: "user" as const, content: "初版提示词" },
            { id: "a1", role: "assistant" as const, status: "pending", content: "", taskIds: ["task-load"] },
        ],
    };
    server.failNext = { status: 500, message: "响应丢失" };
    await expect(saveCreationConversations([initial])).rejects.toThrow("响应丢失");

    const userEdited = {
        id: "lost-ack-load",
        title: "用户二次改名",
        messages: [
            { id: "u1", role: "user" as const, content: "用户补充后的提示词" },
            { id: "a1", role: "assistant" as const, status: "pending", content: "", taskIds: ["task-load"] },
        ],
    };
    server.failNext = { status: 500, message: "暂时离线" };
    await expect(saveCreationConversations([userEdited])).rejects.toThrow("暂时离线");

    const serverAttached = {
        id: "lost-ack-load",
        title: "初版标题",
        messages: [
            { id: "u1", role: "user" as const, content: "初版提示词" },
            { id: "a1", role: "assistant" as const, status: "done", content: "生成完成", taskIds: ["task-load"], resultUrls: ["/api/resources/r3/file"] },
        ],
    };
    server.conversations.set("lost-ack-load", {
        id: "lost-ack-load",
        revision: 2,
        updatedAt: "2026-10-02T00:03:00.000Z",
        document: serverAttached,
    });

    // No prior committed entry: loadCreationConversations must use pending.sentDocument as 3-way ancestor.
    const loaded = await loadCreationConversations();
    const record = loaded?.find((item) => item.id === "lost-ack-load");
    expect(record?.title).toBe("用户二次改名");
    expect(record?.messages.find((item) => item.id === "u1")?.content).toBe("用户补充后的提示词");
    expect(record?.messages.find((item) => item.id === "a1")?.content).toBe("生成完成");

    await saveCreationConversations(loaded!);
    const final = server.conversations.get("lost-ack-load");
    expect(final?.revision).toBe(3);
    expect(final?.document?.title).toBe("用户二次改名");
    expect(final?.document?.messages.find((item) => item.id === "u1")?.content).toBe("用户补充后的提示词");
    expect(final?.document?.messages.find((item) => item.id === "a1")?.content).toBe("生成完成");
});
