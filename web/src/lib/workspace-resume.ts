/** Run resume refreshes once the first interaction has settled. */
export function subscribeWorkspaceResume(
    refresh: () => void,
    targets: {
        window: Pick<Window, "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout">;
        document: Pick<Document, "addEventListener" | "removeEventListener" | "hidden">;
    } = { window, document },
) {
    let timer: number | undefined;
    let pending = false;
    let pointerDown = false;
    const cancel = () => {
        if (timer !== undefined) targets.window.clearTimeout(timer);
        timer = undefined;
    };
    const schedule = () => {
        cancel();
        if (!pending || pointerDown || targets.document.hidden) return;
        timer = targets.window.setTimeout(() => {
            timer = undefined;
            pending = false;
            refresh();
        }, 500);
    };
    const resume = () => {
        pending = !targets.document.hidden;
        if (!pending) pointerDown = false;
        schedule();
    };
    const blur = () => {
        pending = false;
        pointerDown = false;
        cancel();
    };
    const start = () => {
        pointerDown = true;
        cancel();
    };
    const end = () => {
        pointerDown = false;
        schedule();
    };
    targets.window.addEventListener("focus", resume);
    targets.window.addEventListener("blur", blur);
    targets.document.addEventListener("visibilitychange", resume);
    targets.window.addEventListener("pointerdown", start, true);
    targets.window.addEventListener("pointerup", end, true);
    targets.window.addEventListener("pointercancel", end, true);
    targets.window.addEventListener("wheel", schedule, { passive: true, capture: true });
    targets.window.addEventListener("keydown", schedule, true);
    return () => {
        cancel();
        targets.window.removeEventListener("focus", resume);
        targets.window.removeEventListener("blur", blur);
        targets.document.removeEventListener("visibilitychange", resume);
        targets.window.removeEventListener("pointerdown", start, true);
        targets.window.removeEventListener("pointerup", end, true);
        targets.window.removeEventListener("pointercancel", end, true);
        targets.window.removeEventListener("wheel", schedule, true);
        targets.window.removeEventListener("keydown", schedule, true);
    };
}
