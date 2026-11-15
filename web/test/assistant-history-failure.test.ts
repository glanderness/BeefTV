import { beforeEach, expect, mock, test } from "bun:test";

let failure = false;
let response: unknown;
let lastRequestConfig: Record<string, unknown> | undefined;
mock.module("@/services/api/request", () => ({
    ApiError: class extends Error {},
    apiBaseURL: "/api",
    http: {
        get: async (_path: string, config?: Record<string, unknown>) => {
            lastRequestConfig = config;
            if (failure) throw new Error("offline");
            return response;
        },
        post: async (path: string, _body?: unknown, config?: Record<string, unknown>) => {
            if (path === "/assistant/ui-session") return { token: "fixture-ui" };
            lastRequestConfig = config;
            if (failure) throw new Error("offline");
            return response;
        },
        delete: async (_path: string, config?: Record<string, unknown>) => {
            lastRequestConfig = config;
            if (failure) throw new Error("offline");
            return response;
        },
    },
}));
const {
    ASSISTANT_STATUS_TIMEOUT_MS,
    ASSISTANT_READ_TIMEOUT_MS,
    ASSISTANT_MUTATION_TIMEOUT_MS,
    getAgentHostStatus,
    createAssistantSession,
    activateAssistantSession,
    deleteAssistantSession,
    getAssistantHistory,
    listAssistantSessions,
    restartAgentHost,
    resetAgentUiSession,
} = await import("@/services/api/agent-assistant");
beforeEach(() => { failure = false; response = undefined; lastRequestConfig = undefined; resetAgentUiSession(); });

test("C02: rejected create/activate cannot resolve as a new empty conversation", async () => {
    failure = true;
    await expect(createAssistantSession("a")).rejects.toThrow("offline");
    await expect(activateAssistantSession("a", "s2")).rejects.toThrow("offline");
});
test("C05: unavailable history/list are failures, not empty success", async () => {
    failure = true;
    await expect(getAssistantHistory("a")).rejects.toThrow("offline");
    await expect(listAssistantSessions("a")).rejects.toThrow("offline");
});
test("C02: malformed successful session response does not erase the current session", async () => {
    response = {};
    await expect(createAssistantSession("a")).rejects.toThrow();
    await expect(activateAssistantSession("a", "s2")).rejects.toThrow();
});
test("C05: malformed history is distinguished from genuine zero turns", async () => {
    response = {};
    await expect(getAssistantHistory("a")).rejects.toThrow();
    response = { sessionId: "s1", turns: [] };
    expect(await getAssistantHistory("a")).toEqual({ sessionId: "s1", turns: [], active: undefined, plan: null });
});
test("status, read, and mutation endpoints match backend cold-start and proxy timeout budgets", async () => {
    expect(ASSISTANT_STATUS_TIMEOUT_MS).toBe(25_000);
    expect(ASSISTANT_READ_TIMEOUT_MS).toBe(55_000);
    expect(ASSISTANT_MUTATION_TIMEOUT_MS).toBe(65_000);

    response = { available: true };
    await getAgentHostStatus();
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_STATUS_TIMEOUT_MS);

    response = { sessionId: "s1", turns: [] };
    await getAssistantHistory("a");
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_READ_TIMEOUT_MS);

    response = { currentSessionId: "s1", sessions: [] };
    await listAssistantSessions("a");
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_READ_TIMEOUT_MS);

    response = { sessionId: "s2" };
    await createAssistantSession("a");
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_MUTATION_TIMEOUT_MS);

    await activateAssistantSession("a", "s2");
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_MUTATION_TIMEOUT_MS);

    response = { deleted: true, sessionId: "s2", currentSessionId: null };
    await deleteAssistantSession("a", "s2");
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_MUTATION_TIMEOUT_MS);

    response = { restarted: true };
    await restartAgentHost();
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_MUTATION_TIMEOUT_MS);
});
