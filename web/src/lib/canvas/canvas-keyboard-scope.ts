// Modal editors take keyboard ownership even if their portal leaves focus on body.
// Custom full-screen editors should use a native dialog or role="dialog" + aria-modal.
const MODAL_HOSTS = [
    "dialog[open]", "[aria-modal='true']", "[role='alertdialog']", ".ant-modal-wrap", ".ant-drawer-open",
    ".ant-image-preview-wrap",
].join(",");

// Transient controls also protect the selection from deletion. Persistent tools
// (e.g. the minimap) only own the key while focus is actually inside them.
const DELETE_HOSTS = [
    "[data-canvas-keyboard-scope]", "[data-canvas-settings-popover]", "[data-canvas-context-menu]", "[data-connection-create-menu]",
    "[data-canvas-resource-mention-menu]", ".ant-popover", ".ant-dropdown", ".ant-select-dropdown", ".ant-picker-dropdown",
    "[role='dialog']:not([data-canvas-minimap])",
].join(",");

function hasVisibleKeyboardHost(selector: string) {
    // Ant can retain closed portals (including nested portals with hidden ancestors).
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).some(host =>
        host.getClientRects().length > 0 && getComputedStyle(host).visibility === "visible"
    );
}

const CANVAS_EDITORS = [MODAL_HOSTS, "[data-director-workbench='true']", "[data-canvas-folder-browser]", "[data-canvas-video-fullscreen='true']"].join(",");

export function hasCanvasKeyboardHost() {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement) || hasVisibleKeyboardHost(CANVAS_EDITORS);
}

export function hasDeleteOverlay() {
    return hasVisibleKeyboardHost(DELETE_HOSTS);
}
