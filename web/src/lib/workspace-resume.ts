type ResumeTargets = {
    window: Pick<Window, "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout">;
    document: Pick<Document, "addEventListener" | "removeEventListener" | "hidden">;
};

type ResumeEntry = { refresh: () => void };

type ResumeHub = {
    subscribers: Set<ResumeEntry>;
    dispose: () => void;
};

const hubsByWindow = new WeakMap<ResumeTargets["window"], WeakMap<ResumeTargets["document"], ResumeHub>>();

function getOrCreateHub(targets: ResumeTargets): ResumeHub {
    let byDocument = hubsByWindow.get(targets.window);
    if (!byDocument) {
        byDocument = new WeakMap();
        hubsByWindow.set(targets.window, byDocument);
    }
    const existing = byDocument.get(targets.document);
    if (existing) return existing;

    const subscribers = new Set<ResumeEntry>();
    let timer: number | undefined;
    let pending = false;
    let pointerDown = false;
    let listeningInteraction = false;

    const cancel = () => {
        if (timer !== undefined) targets.window.clearTimeout(timer);
        timer = undefined;
    };

    const setInteractionListening = (active: boolean) => {
        if (listeningInteraction === active) return;
        listeningInteraction = active;
        if (active) {
            targets.window.addEventListener("wheel", schedule, { passive: true, capture: true });
            targets.window.addEventListener("keydown", schedule, true);
        } else {
            targets.window.removeEventListener("wheel", schedule, true);
            targets.window.removeEventListener("keydown", schedule, true);
        }
    };

    const stopPending = () => {
        pending = false;
        cancel();
        setInteractionListening(false);
    };

    const flushSubscribers = () => {
        let firstError: unknown;
        let hasError = false;
        for (const entry of [...subscribers]) {
            try {
                entry.refresh();
            } catch (error) {
                if (!hasError) {
                    hasError = true;
                    firstError = error;
                }
            }
        }
        if (hasError) throw firstError;
    };

    const schedule = () => {
        cancel();
        if (!pending || pointerDown || targets.document.hidden) return;
        timer = targets.window.setTimeout(() => {
            timer = undefined;
            stopPending();
            flushSubscribers();
        }, 500);
    };

    const resume = () => {
        if (targets.document.hidden) {
            pointerDown = false;
            stopPending();
            return;
        }
        pending = true;
        setInteractionListening(true);
        schedule();
    };

    const blur = () => {
        pointerDown = false;
        stopPending();
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

    const dispose = () => {
        stopPending();
        pointerDown = false;
        targets.window.removeEventListener("focus", resume);
        targets.window.removeEventListener("blur", blur);
        targets.document.removeEventListener("visibilitychange", resume);
        targets.window.removeEventListener("pointerdown", start, true);
        targets.window.removeEventListener("pointerup", end, true);
        targets.window.removeEventListener("pointercancel", end, true);
        byDocument?.delete(targets.document);
    };

    const hub: ResumeHub = { subscribers, dispose };
    byDocument.set(targets.document, hub);
    return hub;
}

/** Run resume refreshes once the first interaction has settled. */
export function subscribeWorkspaceResume(refresh: () => void, targets?: ResumeTargets) {
    const resolvedTargets = targets ?? (typeof window !== "undefined" && typeof document !== "undefined" ? { window, document } : null);
    if (!resolvedTargets) return () => {};
    const hub = getOrCreateHub(resolvedTargets);
    const entry: ResumeEntry = { refresh };
    hub.subscribers.add(entry);
    return () => {
        hub.subscribers.delete(entry);
        if (hub.subscribers.size === 0) hub.dispose();
    };
}
