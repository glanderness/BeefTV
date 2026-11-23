import { ownedResourceStorageKey, resourceIdFromStorageKey } from "@/services/api/resources";
import { getCachedResourceBlob } from "@/services/resource-blob-cache";

export async function copyImageToSystemClipboard(source: string, storageKey?: string) {
    return writeImageToClipboard(async () => {
        const resourceStorageKey = ownedResourceStorageKey(storageKey, source);
        if (resourceIdFromStorageKey(resourceStorageKey)) {
            const originalBlob = await getCachedResourceBlob(resourceStorageKey);
            if (!originalBlob) throw new Error("原图资源读取失败，请重试");
            return originalBlob;
        }
        const response = await fetch(source);
        if (!response.ok) throw new Error(`图片读取失败（HTTP ${response.status}）`);
        return response.blob();
    });
}

export async function writeImageToClipboard(loadOriginal: () => Promise<Blob>) {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("当前浏览器不支持复制图片");
    if (typeof window !== "undefined") window.focus();

    const png = loadOriginal().then((blob) => blob.type === "image/png" ? blob : convertClipboardImageToPNG(blob));

    // 优先尝试将 Promise 直接传给 ClipboardItem（现代浏览器标准），在用户激活手势内立即声明写入，
    // 避免因 fetch / 格式转换耗时导致手势过期或窗口失焦抛出 "Document is not focused" 错误。
    try {
        const item = new ClipboardItem({ "image/png": png });
        await navigator.clipboard.write([item]);
        return;
    } catch {
        // 部分浏览器环境不支持延迟 Promise，回退到先取 Blob 再写入
    }

    const blob = await png;
    if (typeof window !== "undefined") window.focus();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

async function convertClipboardImageToPNG(blob: Blob) {
    const url = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("当前浏览器无法处理这张图片");
        context.drawImage(image, 0, 0);
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("图片格式转换失败"))), "image/png"));
    } finally {
        URL.revokeObjectURL(url);
    }
}
