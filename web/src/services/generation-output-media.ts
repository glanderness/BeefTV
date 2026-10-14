import type { GenerationOutput } from "@/lib/generation-outputs";
import { mediaFileExtension } from "@/lib/canvas/canvas-media-download";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";
import { getResourceBlob, ownedResourceIdFromMediaRef, resourceStorageKey } from "@/services/api/resources";
import { getMediaBlob } from "@/services/file-storage";
import { downloadOwnedOrBrowserMedia, isWailsNativeShell, saveOwnedOrBrowserBlob } from "@/services/desktop-media-save";

export async function readGenerationOutputBlob(output: GenerationOutput, signal?: AbortSignal): Promise<Blob> {
    signal?.throwIfAborted();
    const expectedScope = captureUserScope();
    const fallback = output.dataUrl || output.url || "";
    const resourceId = ownedResourceIdFromMediaRef(output.storageKey, fallback);
    let blob: Blob | null;
    if (resourceId) {
        // Protected resources must never fall back to a raw URL after an auth failure.
        blob = await getResourceBlob(resourceStorageKey(resourceId), { signal, expectedScope });
    } else if (output.storageKey) {
        blob = await getMediaBlob(output.storageKey);
    } else {
        if (!fallback) throw new Error("输出文件没有可读取的资源");
        const response = await fetch(fallback, { signal, credentials: "same-origin" });
        if (!response.ok) throw new Error("输出文件读取失败，请重新读取");
        blob = await response.blob();
    }
    assertUserScope(expectedScope);
    signal?.throwIfAborted();
    if (!blob) throw new Error("输出文件读取失败，请重新读取");
    return blob;
}

export async function downloadGenerationOutput(output: GenerationOutput, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const expectedScope = captureUserScope();
    const fallback = output.dataUrl || output.url || "";
    const extension = mediaFileExtension(output.mimeType, fallback) || "bin";
    const fileName = `output-${output.outputIndex + 1}.${extension}`;
    if (isWailsNativeShell()) {
        return downloadOwnedOrBrowserMedia({ fileName, resourceId: ownedResourceIdFromMediaRef(output.storageKey, fallback) });
    }
    const blob = await readGenerationOutputBlob(output, signal);
    assertUserScope(expectedScope);
    signal?.throwIfAborted();
    return saveOwnedOrBrowserBlob(fileName, blob);
}
