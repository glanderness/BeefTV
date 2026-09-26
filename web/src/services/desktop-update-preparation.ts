type PrepareEditor = () => void | Promise<void>;

// Mounted editors own their pending writes; the updater must await them before
// asking the native host to exit. Unmounting removes the old workspace callback.
const editors = new Set<PrepareEditor>();

export function registerDesktopUpdatePreparation(prepare: PrepareEditor) {
    editors.add(prepare);
    return () => {
        editors.delete(prepare);
    };
}

export async function prepareDesktopEditorsForUpdate() {
    for (const prepare of [...editors]) await prepare();
}
