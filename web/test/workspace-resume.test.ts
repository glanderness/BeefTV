import { expect, test } from "bun:test";
import { subscribeWorkspaceResume } from "@/lib/workspace-resume";

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
