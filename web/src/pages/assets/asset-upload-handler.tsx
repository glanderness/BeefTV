import { useEffect, useRef } from "react";
import { App } from "antd";

import { readImageMeta } from "@/lib/image-utils";
import { captureUserScope, isUserScopeAbandonedError, userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { localSavedRemotePendingMessage } from "@/services/local-workspace-sync";
import { persistWorkspaceAssetChanges } from "@/services/workspace-asset-repository";
import { useAssetStore } from "@/stores/use-asset-store";

export type AssetUploadRequest = { id: number; files: File[]; folderId: string };

export function AssetUploadHandler({ request, entryScope, onComplete }: { request: AssetUploadRequest | null; entryScope?: CapturedUserScope; onComplete: () => Promise<void> }) {
    const { message } = App.useApp();
    const addAsset = useAssetStore((state) => state.addAsset);
    const onCompleteRef = useRef(onComplete);
    onCompleteRef.current = onComplete;

    useEffect(() => {
        if (!request) return;
        const expected = entryScope ?? captureUserScope();
        const files = request.files.filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/"));
        if (!files.length) {
            message.warning("请选择图片或视频文件");
            return;
        }

        let cancelled = false;
        void (async () => {
            let cursor = 0;
            let completed = 0;
            let failed = 0;
            const worker = async () => {
                while (cursor < files.length && !cancelled) {
                    if (!userScopeMatches(expected)) return;
                    const file = files[cursor++];
                    try {
                        if (file.type.startsWith("video/")) {
                            const uploaded = await uploadMediaFile(file, "video", undefined, expected);
                            if (!userScopeMatches(expected)) return;
                            addAsset({ kind: "video", title: file.name.replace(/\.[^.]+$/, ""), category: "material", folderId: request.folderId || undefined, coverUrl: uploaded.preview?.url || "", tags: [], source: "批量上传", metadata: { source: "manual-batch" }, data: { url: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width || 0, height: uploaded.height || 0, durationMs: uploaded.durationMs, hasAudio: uploaded.hasAudio, bytes: uploaded.bytes, mimeType: uploaded.mimeType } });
                        } else {
                            const uploaded = await uploadImage(file, undefined, expected);
                            if (!userScopeMatches(expected)) return;
                            const meta = await readImageMeta(uploaded.url).catch(() => ({ width: uploaded.width, height: uploaded.height, mimeType: uploaded.mimeType }));
                            if (!userScopeMatches(expected)) return;
                            addAsset({ kind: "image", title: file.name.replace(/\.[^.]+$/, ""), category: "material", folderId: request.folderId || undefined, coverUrl: uploaded.url, tags: [], source: "批量上传", metadata: { source: "manual-batch" }, data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: meta.width || uploaded.width, height: meta.height || uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType } });
                        }
                        completed += 1;
                    } catch (error) {
                        if (isUserScopeAbandonedError(error) || !userScopeMatches(expected)) return;
                        failed += 1;
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(4, files.length) }, () => worker()));
            if (cancelled || !userScopeMatches(expected)) return;
            try {
                await persistWorkspaceAssetChanges(expected);
            } catch (error) {
                if (isUserScopeAbandonedError(error) || !userScopeMatches(expected)) return;
                message.warning(localSavedRemotePendingMessage("部分素材已保存在本地", error));
            }
            if (cancelled || !userScopeMatches(expected)) return;
            if (completed) message.success(`已上传 ${completed} 个素材`);
            if (failed) message.error(`${failed} 个素材上传失败`);
            await onCompleteRef.current();
        })();
        return () => { cancelled = true; };
    }, [addAsset, entryScope, message, request]);

    return null;
}
