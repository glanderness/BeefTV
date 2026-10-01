// 会话动作身份的确定性用例：不需要模型，也不需要真实 SDK 会话。
// 覆盖评审指出的缺陷——身份曾是进程级全局变量，后建的会话会覆盖前一个会话的前缀。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { sessionActionIdentity, toolOperationId } from "./session-identity.mjs";

const serverSource = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const ownerSource = readFileSync(new URL("./session-owner.mjs", import.meta.url), "utf8");

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
        expect(ownerSource).not.toContain("let sessionIdentity");
        expect(ownerSource).toContain("buildTools(canvasId, log, generation, turn, identity.prefix)");
        expect(serverSource).toContain("persistence: entry.persistence");
    });
});

/**
 * 用官方 SessionManager 做真实 create → 重新 open 往返，验证「同一会话的身份稳定」。
 *
 * 这不是纯函数测试：它真的经过 SDK 的持久化路径。官方语义（0.87.1）是会话文件在出现
 * assistant 消息后才落盘（见 session-manager.js `_persist`），因此这里按真实使用方式
 * 追加 user + assistant 两条消息，再走宿主恢复时的 `list` → `open` 路径。
 */
describe("官方会话持久化身份（真实 SDK 往返）", () => {
    test("create → list → open 得到同一 session id，opId 前缀因此稳定", async () => {
        const sessionDir = mkdtempSync(join(tmpdir(), "beeftv-session-id-"));
        const cwd = mkdtempSync(join(tmpdir(), "beeftv-session-cwd-"));

        const created = SessionManager.create(cwd, sessionDir);
        const createdId = created.getSessionId();
        created.appendMessage({ role: "user", content: [{ type: "text", text: "身份核对" }] });
        created.appendMessage({ role: "assistant", content: [{ type: "text", text: "收到" }] });

        // 宿主恢复路径：list 找出会话文件，再 open 同一条会话。
        const known = await SessionManager.list(cwd, sessionDir);
        expect(known.length).toBeGreaterThan(0);
        const target = [...known].sort((a, b) => String(b.modified ?? "").localeCompare(String(a.modified ?? "")))[0];
        const file = target.path || SessionManager.findById(cwd, target.id, sessionDir);
        expect(file).toBeTruthy();
        const reopened = SessionManager.open(file, sessionDir, cwd);

        expect(reopened.getSessionId()).toBe(createdId);

        // 两个进程（不同 RUN_ID）恢复同一会话时，未确认动作的 operationId 必须一致。
        const beforeRestart = sessionActionIdentity({ persistedId: createdId, runId: "run-before" });
        const afterRestart = sessionActionIdentity({ persistedId: reopened.getSessionId(), runId: "run-after" });
        expect(beforeRestart.source).toBe("persistent-session-id");
        expect(toolOperationId(beforeRestart.prefix, "call-7")).toBe(toolOperationId(afterRestart.prefix, "call-7"));
    });

    test("没有持久 id 时退回进程运行 id（不冒充已有动作身份）", () => {
        const inMemory = SessionManager.inMemory("/tmp");
        const identity = sessionActionIdentity({ persistedId: inMemory.getSessionId?.() && inMemory.isPersisted?.() ? inMemory.getSessionId() : "", runId: "run-x" });
        expect(identity.source).toBe("run-id");
        expect(identity.prefix).toBe("run:run-x");
    });
});
