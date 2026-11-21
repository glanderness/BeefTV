import { expect, test } from "bun:test";
import { subscribeWorkspaceResume } from "@/lib/workspace-resume";
import { shouldHydrateCanvasLibraryOnResume } from "@/lib/workspace-routes";

function harness() {
    const foreground = new EventTarget();
    const visibility = Object.assign(new EventTarget(), { hidden: false });
    let now = 0;
    let serial = 0;
    let refreshes = 0;
    const timers = new Map<number, { at: number; run: () => void }>();
    const clock = Object.assign(foreground, {
        setTimeout(run: () => void, delay = 0) {
            const id = ++serial;
            timers.set(id, { at: now + delay, run });
            return id;
        },
        clearTimeout(id: number) { timers.delete(id); },
    });
    const stop = subscribeWorkspaceResume(() => { refreshes++; }, {
        window: clock as unknown as Window,
        document: visibility,
    });
    return {
        stop,
        count: () => refreshes,
        fire: (name: string) => foreground.dispatchEvent(new Event(name)),
        hide(hidden: boolean) {
            visibility.hidden = hidden;
            visibility.dispatchEvent(new Event("visibilitychange"));
        },
        advance(ms: number) {
            now += ms;
            for (const [id, timer] of timers) {
                if (timer.at > now) continue;
                timers.delete(id);
                timer.run();
            }
        },
    };
}

test("focus and visibility resume coalesce without synchronous refresh", () => {
    const app = harness();
    app.hide(false);
    app.fire("focus");
    expect(app.count()).toBe(0);
    app.advance(500);
    expect(app.count()).toBe(1);
    app.stop();
});

test("the first drag defers refresh until pointer release and a quiet interval", () => {
    const app = harness();
    app.fire("focus");
    app.advance(200);
    app.fire("pointerdown");
    app.advance(2000);
    expect(app.count()).toBe(0);
    app.fire("pointerup");
    app.advance(499);
    expect(app.count()).toBe(0);
    app.advance(1);
    expect(app.count()).toBe(1);
    app.stop();
});

test("wheel and keyboard interactions postpone pending refresh without starting new refreshes", () => {
    const app = harness();
    app.fire("focus");
    for (const event of ["wheel", "keydown"]) {
        app.advance(400);
        app.fire(event);
        expect(app.count()).toBe(0);
    }
    app.advance(500);
    expect(app.count()).toBe(1);
    app.fire("wheel");
    app.advance(500);
    expect(app.count()).toBe(1);
    app.stop();
});

test("hiding during drag cancels refresh and the next resume recovers", () => {
    const app = harness();
    app.fire("focus");
    app.fire("pointerdown");
    app.hide(true);
    app.advance(2000);
    expect(app.count()).toBe(0);
    app.hide(false);
    app.advance(500);
    expect(app.count()).toBe(1);
    app.stop();
});

test("blur and disposal cancel queued refreshes", () => {
    const app = harness();
    app.fire("focus");
    app.fire("blur");
    app.advance(500);
    expect(app.count()).toBe(0);
    app.fire("focus");
    app.stop();
    app.advance(500);
    app.fire("focus");
    app.advance(500);
    expect(app.count()).toBe(0);
});

test("multiple subscribers share one listener set and detach wheel/keydown when idle", () => {
    const activeListeners = new Map<string, number>();
    const foreground = new EventTarget();
    const origAdd = foreground.addEventListener.bind(foreground);
    const origRemove = foreground.removeEventListener.bind(foreground);
    foreground.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
        activeListeners.set(type, (activeListeners.get(type) ?? 0) + 1);
        return origAdd(type, listener, options);
    }) as typeof foreground.addEventListener;
    foreground.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
        activeListeners.set(type, Math.max(0, (activeListeners.get(type) ?? 0) - 1));
        return origRemove(type, listener, options);
    }) as typeof foreground.removeEventListener;

    const visibility = Object.assign(new EventTarget(), { hidden: false });
    let now = 0;
    let serial = 0;
    const timers = new Map<number, { at: number; run: () => void }>();
    const clock = Object.assign(foreground, {
        setTimeout(run: () => void, delay = 0) {
            const id = ++serial;
            timers.set(id, { at: now + delay, run });
            return id;
        },
        clearTimeout(id: number) { timers.delete(id); },
    });
    const targets = { window: clock as unknown as Window, document: visibility };

    let a = 0;
    let b = 0;
    const stopA = subscribeWorkspaceResume(() => { a++; }, targets);
    const stopB = subscribeWorkspaceResume(() => { b++; }, targets);

    expect(activeListeners.get("focus")).toBe(1);
    expect(activeListeners.get("pointerdown")).toBe(1);
    expect(activeListeners.get("wheel") ?? 0).toBe(0);
    expect(activeListeners.get("keydown") ?? 0).toBe(0);

    foreground.dispatchEvent(new Event("focus"));
    expect(activeListeners.get("wheel")).toBe(1);
    expect(activeListeners.get("keydown")).toBe(1);

    now += 500;
    for (const [id, timer] of timers) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
    }
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(activeListeners.get("wheel")).toBe(0);
    expect(activeListeners.get("keydown")).toBe(0);

    stopA();
    expect(activeListeners.get("focus")).toBe(1);
    stopB();
    expect(activeListeners.get("focus")).toBe(0);
    expect(activeListeners.get("pointerdown")).toBe(0);
});

test("project-library resume hydration is skipped on open canvas editor routes and runs on other pages", () => {
    const foreground = new EventTarget();
    const visibility = Object.assign(new EventTarget(), { hidden: false });
    let now = 0;
    let serial = 0;
    const timers = new Map<number, { at: number; run: () => void }>();
    const clock = Object.assign(foreground, {
        setTimeout(run: () => void, delay = 0) {
            const id = ++serial;
            timers.set(id, { at: now + delay, run });
            return id;
        },
        clearTimeout(id: number) { timers.delete(id); },
    });
    let currentPath = "/canvas/proj-123";
    let hydrations = 0;
    const stop = subscribeWorkspaceResume(() => {
        if (shouldHydrateCanvasLibraryOnResume(currentPath, visibility.hidden)) hydrations++;
    }, { window: clock as unknown as Window, document: visibility });
    const flush = () => {
        foreground.dispatchEvent(new Event("focus"));
        now += 500;
        for (const [id, timer] of timers) {
            if (timer.at > now) continue;
            timers.delete(id);
            timer.run();
        }
    };

    for (const skipped of ["/canvas/proj-123", "/canvas/proj-123/details"]) {
        currentPath = skipped;
        flush();
    }
    expect(hydrations).toBe(0);

    for (const hydrated of ["/", "/canvas", "/assets"]) {
        currentPath = hydrated;
        flush();
    }
    expect(hydrations).toBe(3);

    expect(shouldHydrateCanvasLibraryOnResume("/", true)).toBe(false);
    stop();
});
