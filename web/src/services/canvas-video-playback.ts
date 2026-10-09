import { captureUserScope, assertUserScope } from "@/lib/user-scope-guard";
import { getResource, refreshResource, getResourcePlaybackBlob, resourceIdFromStorageKey } from "@/services/api/resources";
import { resolveMediaUrl } from "@/services/file-storage";

export async function resolveCanvasVideoPlayback(storageKey: string, fallback: string, signal: AbortSignal): Promise<string | Blob> {
    const expectedScope = captureUserScope();
    const id = resourceIdFromStorageKey(storageKey);
    if (id) {
        let resource = await getResource(id, { signal, expectedScope });
        for (let attempt = 0; resource.playbackStatus === "processing"; attempt += 1) {
            if (attempt >= 120) throw new Error("视频已导入，兼容播放副本仍在处理中，请稍后重新打开");
            await waitForPlaybackPoll(signal);
            resource = await refreshResource(id, { signal, expectedScope });
        }
        if (resource.playbackStatus === "ready") {
            const blob = await getResourcePlaybackBlob(storageKey, { signal, expectedScope });
            assertUserScope(expectedScope);
            if (!blob) throw new Error("兼容播放副本不可用");
            return blob;
        }
        if (resource.playbackStatus === "failed") throw new Error("视频已导入，兼容播放副本处理失败");
    }
    const url = await resolveMediaUrl(storageKey, fallback);
    assertUserScope(expectedScope);
    if (signal.aborted) throw signal.reason;
    return url;
}

function waitForPlaybackPoll(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); reject(signal.reason); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, 2500);
        signal.addEventListener("abort", abort, { once: true });
    });
}
