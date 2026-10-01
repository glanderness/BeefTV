import { expect, test } from "bun:test";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
import { waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";

test("an in-flight text stream cannot publish after A to B to A", async () => {
    const previousScope = getActiveUserScope();
    const previousFetch = globalThis.fetch;
    setActiveUserScope("stream-owner-a");
    const expectedScope = captureUserScope();
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let cancelled = false;
    let updates = 0;
    globalThis.fetch = (async () => {
        entered();
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) { feed = controller; },
            cancel() { cancelled = true; },
        }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        const pending = waitForGenerationTask("task-1", {
            initialTask: { id: "task-1", status: "running", operation: "text" } as GenerationTask,
            useTextEvents: true,
            expectedScope,
            onTaskUpdate: () => { updates += 1; },
            onTextDelta: () => { updates += 1; },
        });
        await started;
        setActiveUserScope("stream-owner-b");
        setActiveUserScope("stream-owner-a");
        feed.enqueue(new TextEncoder().encode('id: 1\nevent: delta\ndata: {"sequence":1,"content":"old output"}\n\n'));
        await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
        expect(updates).toBe(0);
        expect(cancelled).toBe(true);
    } finally {
        globalThis.fetch = previousFetch;
        setActiveUserScope(previousScope);
    }
});
