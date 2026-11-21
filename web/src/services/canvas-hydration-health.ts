type Health = { error: string; loading: boolean; scope?: string };
let state: Health = { error: "", loading: true };
let attempt = 0;
const listeners = new Set<() => void>();
export const getCanvasHydrationHealth = () => state;
export function subscribeCanvasHydrationHealth(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
export function setCanvasHydrationHealth(next: Health) {
    state = next;
    listeners.forEach((listener) => listener());
}
export function beginCanvasHydration(scope?: string) {
    const id = ++attempt;
    setCanvasHydrationHealth({ error: "", loading: true, scope });
    return id;
}
export function finishCanvasHydration(id: number, error = "", scope?: string) {
    if (id === attempt) setCanvasHydrationHealth({ error, loading: false, scope: error ? undefined : scope });
}
