import { getActiveUserScope } from "@/lib/user-scope";

/** Each operation retains the session and account that started it, across awaits. */
export function directorAsyncSession(signal: AbortSignal) {
    const scope = getActiveUserScope();
    const current = () => !signal.aborted && getActiveUserScope() === scope;
    return { signal, current, assertCurrent: () => {
        if (!current()) throw new DOMException("导演台会话已结束", "AbortError");
    } };
}
