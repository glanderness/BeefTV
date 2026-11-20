type PastePosition = { x: number; y: number };

/**
 * 右键粘贴：画布里复制的节点优先；否则读系统剪贴板里的图片或媒体。
 * 两者都没有时提示读不到内容。
 */
export function pasteCanvasAtPosition(
    position: PastePosition,
    options: {
        shouldPreferCopiedNodes: () => boolean;
        pasteCopiedNodes: (position: PastePosition) => boolean;
        pasteSystemClipboard: (position: PastePosition) => Promise<boolean> | boolean;
        warn: (content: string) => void;
    },
) {
    if (options.shouldPreferCopiedNodes() && options.pasteCopiedNodes(position)) return;
    void (async () => {
        try {
            // 标记写入成功时仍优先系统图片，兼容截图和从外部应用复制的媒体。
            const handled = await options.pasteSystemClipboard(position);
            if (!handled) options.pasteCopiedNodes(position);
        } catch {
            if (!options.pasteCopiedNodes(position)) options.warn("无法读取剪贴板内容");
        }
    })();
}
