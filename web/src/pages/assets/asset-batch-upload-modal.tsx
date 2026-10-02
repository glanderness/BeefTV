import { useMemo, useRef, useState } from "react";
import { App, Button, Modal, Progress, Select } from "antd";
import { StatusBadge } from "@/components/ui/base/badges";
import { FileImage, FileVideo, UploadCloud, X } from "lucide-react";

import { ASSET_CATEGORY_OPTIONS, type AssetCategory } from "@/lib/asset-category";
import { readImageMeta } from "@/lib/image-utils";
import { captureUserScope, isUserScopeAbandonedError, userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { localSavedRemotePendingMessage } from "@/services/local-workspace-sync";
import { persistWorkspaceAssetChanges } from "@/services/workspace-asset-repository";
import { useAssetStore } from "@/stores/use-asset-store";
import type { AssetFolder } from "@/services/api/workspace-data";

type BatchItem = { id: string; file: File; status: "queued" | "uploading" | "done" | "error"; error?: string; percent?: number };

export function AssetBatchUploadModal({ open, defaultFolderId, folders, onClose, onComplete, entryScope }: { open: boolean; defaultFolderId: string; folders: AssetFolder[]; onClose: () => void; onComplete: () => Promise<void>; entryScope?: CapturedUserScope }) {
    const { message } = App.useApp();
    const addAsset = useAssetStore((state) => state.addAsset);
    const [sessionScope] = useState(() => entryScope ?? captureUserScope());
    const [items, setItems] = useState<BatchItem[]>([]);
    const [category, setCategory] = useState<AssetCategory>("material");
    const [folderId, setFolderId] = useState(defaultFolderId);
    const [tags, setTags] = useState<string[]>([]);
    const [uploading, setUploading] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const doneCount = items.filter((item) => item.status === "done").length;
    const failedItems = items.filter((item) => item.status === "error");
    const hasFiles = items.length > 0;
    const folderOptions = useMemo(() => [{ label: "未分类", value: "" }, ...folders.map((folder) => ({ label: folder.name, value: folder.id }))], [folders]);

    const chooseFiles = (files: File[]) => {
        const media = files.filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/"));
        if (!media.length) {
            message.warning("请选择图片或视频文件");
            return;
        }
        setItems((current) => [...current, ...media.map((file) => ({ id: `${file.name}-${file.lastModified}-${Math.random()}`, file, status: "queued" as const }))]);
    };

    const uploadBatch = async () => {
        const pending = items.filter((item) => item.status === "queued" || item.status === "error");
        if (!pending.length) return;
        const expected = sessionScope;
        setUploading(true);
        let cursor = 0;
        const worker = async () => {
            while (cursor < pending.length) {
                if (!userScopeMatches(expected)) return;
                const item = pending[cursor++];
                setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "uploading", percent: 10, error: undefined } : entry));
                try {
                    if (item.file.type.startsWith("video/")) {
                        const uploaded = await uploadMediaFile(item.file, "video", (uploadedBytes, totalBytes) => {
                            if (!userScopeMatches(expected)) return;
                            setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, percent: totalBytes ? Math.round((uploadedBytes / totalBytes) * 100) : 10 } : entry));
                        }, expected);
                        if (!userScopeMatches(expected)) return;
                        addAsset({ kind: "video", title: item.file.name.replace(/\.[^.]+$/, ""), category, folderId: folderId || undefined, coverUrl: uploaded.preview?.url || "", tags, source: "批量上传", metadata: { source: "manual-batch" }, data: { url: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width || 0, height: uploaded.height || 0, durationMs: uploaded.durationMs, hasAudio: uploaded.hasAudio, bytes: uploaded.bytes, mimeType: uploaded.mimeType } });
                    } else {
                        const uploaded = await uploadImage(item.file, undefined, expected);
                        if (!userScopeMatches(expected)) return;
                        const meta = await readImageMeta(uploaded.url).catch(() => ({ width: uploaded.width, height: uploaded.height, mimeType: uploaded.mimeType }));
                        if (!userScopeMatches(expected)) return;
                        addAsset({ kind: "image", title: item.file.name.replace(/\.[^.]+$/, ""), category, folderId: folderId || undefined, coverUrl: uploaded.url, tags, source: "批量上传", metadata: { source: "manual-batch" }, data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: meta.width || uploaded.width, height: meta.height || uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType } });
                    }
                    if (!userScopeMatches(expected)) return;
                    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "done", percent: 100 } : entry));
                } catch (error) {
                    if (isUserScopeAbandonedError(error) || !userScopeMatches(expected)) return;
                    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "error", error: error instanceof Error ? error.message : "上传失败" } : entry));
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()));
        if (!userScopeMatches(expected)) return;
        try {
            await persistWorkspaceAssetChanges(expected);
        } catch (error) {
            if (isUserScopeAbandonedError(error) || !userScopeMatches(expected)) return;
            message.warning(localSavedRemotePendingMessage("部分素材已保存在本地", error));
        }
        if (!userScopeMatches(expected)) return;
        setUploading(false);
        try {
            await onComplete();
        } catch (error) {
            if (isUserScopeAbandonedError(error) || !userScopeMatches(expected)) return;
            throw error;
        }
    };

    const close = () => {
        if (uploading) return;
        setItems([]);
        setTags([]);
        setFolderId(defaultFolderId);
        onClose();
    };

    return <Modal className="library-modal library-batch-upload-modal" title="批量上传素材" open={open} onCancel={close} footer={null} destroyOnHidden>
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-xs font-medium text-foreground/65">业务分类<Select className="mt-1 w-full" value={category} options={ASSET_CATEGORY_OPTIONS} onChange={(value) => setCategory(value)} /></label>
                <label className="text-xs font-medium text-foreground/65">自定义分类<Select className="mt-1 w-full" value={folderId} options={folderOptions} onChange={setFolderId} /></label>
                <label className="text-xs font-medium text-foreground/65">公共标签<Select mode="tags" className="mt-1 w-full" value={tags} tokenSeparators={[",", "，"]} onChange={setTags} placeholder="输入后回车" /></label>
            </div>
            <button type="button" className="batch-upload-dropzone" onClick={() => inputRef.current?.click()}>
                <UploadCloud className="size-7" /><strong>选择图片或视频</strong><span>支持多选上传，标题默认取文件名</span>
            </button>
            <input ref={inputRef} type="file" hidden accept="image/*,video/*" multiple onChange={(event) => { chooseFiles(Array.from(event.target.files || [])); event.currentTarget.value = ""; }} />
            {hasFiles ? <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-foreground/55"><span>已选择 {items.length} 张 · 成功 {doneCount} 张</span><button type="button" className="text-foreground/45 hover:text-foreground" onClick={() => setItems([])} disabled={uploading}>清空</button></div>
                <div className="batch-upload-list">{items.map((item) => <div key={item.id} className="batch-upload-item"><FileImage className="size-4 shrink-0 text-foreground/45" /><span className="min-w-0 flex-1 truncate" title={item.file.name}>{item.file.name}</span>{item.status === "uploading" ? <Progress percent={item.percent || 10} size="small" showInfo={false} className="w-20" /> : item.status === "done" ? <StatusBadge tone="success" size="sm" label="完成" /> : item.status === "error" ? <StatusBadge tone="error" size="sm" label="失败" title={item.error} /> : <StatusBadge tone="neutral" size="sm" label="待上传" />}<button type="button" aria-label={`移除 ${item.file.name}`} title="移除" className="batch-upload-remove" onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))} disabled={uploading}><X className="size-3.5" /></button></div>)}</div>
            </div> : null}
            <div className="flex justify-end gap-2"><Button onClick={close} disabled={uploading}>取消</Button><Button type="primary" icon={<UploadCloud className="size-4" />} onClick={() => void uploadBatch()} disabled={!items.some((item) => item.status === "queued" || item.status === "error")} loading={uploading}>{failedItems.length ? `重试失败项 (${failedItems.length})` : "开始上传"}</Button></div>
        </div>
    </Modal>;
}
