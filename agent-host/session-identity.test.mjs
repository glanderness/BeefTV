// 会话动作身份的确定性用例：不需要模型，也不需要真实 SDK 会话。
// 覆盖评审指出的缺陷——身份曾是进程级全局变量，后建的会话会覆盖前一个会话的前缀。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { sessionActionIdentity, toolOperationId } from "./session-identity.mjs";

const serverSource = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");

describe("会话动作身份", () => {
    test("优先使用官方持久会话 id，没有时退回进程运行 id", () => {
        expect(sessionActionIdentity({ persistedId: "sess-A", runId: "run-1" })).toEqual({ prefix: "sess-A", source: "persistent-session-id" });
        expect(sessionActionIdentity({ persistedId: "", runId: "run-1" })).toEqual({ prefix: "run:run-1", source: "run-id" });
    });

    test("两个会话的同一 toolCallId 不会撞成同一个 operationId", () => {
        const a = sessionActionIdentity({ persistedId: "sess-A", runId: "run-1" });
        const b = sessionActionIdentity({ persistedId: "sess-B", runId: "run-1" });

        const callInA = toolOperationId(a.prefix, "call-1", "fallback");
        const callInB = toolOperationId(b.prefix, "call-1", "fallback");

        expect(callInA).not.toBe(callInB);
        expect(callInA).toBe("sess-A:call-1");
        expect(callInB).toBe("sess-B:call-1");
    });

    test("同一会话同一 toolCallId 在重启后仍是同一个 operationId", () => {
        const before = sessionActionIdentity({ persistedId: "sess-A", runId: "run-1" });
        const afterRestart = sessionActionIdentity({ persistedId: "sess-A", runId: "run-2" });

        expect(toolOperationId(before.prefix, "call-9", "x")).toBe(toolOperationId(afterRestart.prefix, "call-9", "x"));
    });

    test("没有持久 id 时按进程运行 id 区分，不冒充已成历史动作", () => {
        const first = sessionActionIdentity({ persistedId: "", runId: "run-1" });
        const second = sessionActionIdentity({ persistedId: "", runId: "run-2" });

        expect(toolOperationId(first.prefix, "call-1", "x")).not.toBe(toolOperationId(second.prefix, "call-1", "x"));
    });

    test("宿主不再用进程级全局保存会话身份与持久化状态", () => {
        expect(serverSource).not.toContain("let sessionIdentity");
        expect(serverSource).not.toContain("let persistenceState");
        expect(serverSource).toContain("buildTools(canvasId, log, generation, turn, identity.prefix)");
        expect(serverSource).toContain("persistence: entry.persistence");
    });
});
