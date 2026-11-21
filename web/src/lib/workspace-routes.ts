export function isCanvasEditorPath(pathname: string) {
    return /^\/canvas\/[^/]+(?:\/|$)/.test(pathname);
}

export function shouldHydrateCanvasLibraryOnResume(pathname: string, hidden: boolean) {
    return !hidden && !isCanvasEditorPath(pathname);
}

export function isSpatialWorkbenchPath(pathname: string) {
    // 画布列表属于用户工作台，只有具体画布编辑器与运营后台保留各自现有视觉契约。
    return !isCanvasEditorPath(pathname) && !pathname.startsWith("/admin");
}
