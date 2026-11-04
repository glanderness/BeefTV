import { onStorageNamespaceChange } from "@/lib/user-scope";

// A startup namespace change invalidates pending reads, even if it changes back.
export function observeStorageNamespaceTask() {
    let current = true;
    const dispose = onStorageNamespaceChange(() => { current = false; });
    return {
        dispose,
        isCurrent: () => current,
        assertCurrent: () => { if (!current) throw new DOMException("The workspace namespace changed", "AbortError"); },
    };
}
