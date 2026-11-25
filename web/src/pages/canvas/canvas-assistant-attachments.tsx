import { Button, InputNumber, Select } from "antd";
import { File, FileCode, FileSpreadsheet, FileText, X } from "lucide-react";
import { useEffect, useState } from "react";
import { resourceStorageKey } from "@/services/api/resources";
import { useResourceVideoPlayback } from "@/hooks/use-resource-video-playback";
import { cacheResourceObjectUrl, peekCachedResourceObjectUrl } from "@/services/resource-blob-cache";
import { ASSISTANT_ATTACHMENT_PURPOSES, assistantAttachmentPurposes, attachmentRangeError } from "@/services/assistant-attachments";
import type { AssistantAttachment } from "@/services/api/agent-assistant";

function formatAttachmentBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "已保存文件";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtensionLabel(name: string): string {
    const dot = name.lastIndexOf(".");
    if (dot <= 0 || dot >= name.length - 1) return "文件";
    return name.slice(dot + 1, dot + 9).toUpperCase();
}

function FileAttachmentIcon({ name }: { name: string }) {
    const ext = fileExtensionLabel(name).toLowerCase();
    if (["csv", "tsv", "xls", "xlsx"].includes(ext)) return <FileSpreadsheet size={18} aria-hidden="true" />;
    if (["json", "jsonl", "yaml", "yml", "xml", "html", "htm", "js", "jsx", "ts", "tsx", "py", "go", "rs", "sql", "sh", "css"].includes(ext)) {
        return <FileCode size={18} aria-hidden="true" />;
    }
    if (["txt", "md", "markdown", "doc", "docx", "pdf", "ppt", "pptx", "srt", "vtt", "ass", "lrc", "log"].includes(ext)) {
        return <FileText size={18} aria-hidden="true" />;
    }
    return <File size={18} aria-hidden="true" />;
}

function AttachmentPreview({ attachment }: { attachment: AssistantAttachment }) {
    const storageKey = resourceStorageKey(attachment.resourceId);
    const video = useResourceVideoPlayback(storageKey, "", attachment.kind === "video");
    const identity = `${attachment.kind}:${attachment.resourceId}`;
    const [retry, setRetry] = useState(0);
    const [preview, setPreview] = useState<{ identity: string; url: string; error: boolean } | null>(null);
    useEffect(() => {
        let cancelled = false;
        setPreview(null);
        if (attachment.kind === "video" || attachment.kind === "file") return;
        const load = async () => {
            return cacheResourceObjectUrl(storageKey);
        };
        void load().then(url => {
            if (!cancelled) setPreview({ identity, url, error: !url });
        }).catch(() => {
            if (!cancelled) setPreview({ identity, url: "", error: true });
        });
        return () => { cancelled = true; };
    }, [attachment.kind, identity, retry, storageKey]);
    if (attachment.kind === "file") {
        return (
            <div className="canvas-assistant-file-card">
                <span className="canvas-assistant-file-icon"><FileAttachmentIcon name={attachment.name} /></span>
                <span className="canvas-assistant-file-meta">
                    <span className="canvas-assistant-file-ext">{fileExtensionLabel(attachment.name)}</span>
                    <span className="canvas-assistant-meta">{formatAttachmentBytes(attachment.bytes)}</span>
                </span>
            </div>
        );
    }
    const current = preview?.identity === identity ? preview : null;
    const url = attachment.kind === "video" ? video.url : current?.url || peekCachedResourceObjectUrl(storageKey);
    if (current?.error || video.error) return <span className="canvas-assistant-meta" role="status">预览暂时无法显示<Button size="small" onClick={() => attachment.kind === "video" ? video.retry() : setRetry(value => value + 1)}>重读预览</Button></span>;
    if (!url) return <span className="canvas-assistant-meta" role="status">正在读取预览…</span>;
    const onError = () => setPreview({ identity, url: "", error: true });
    return attachment.kind === "image" ? <img src={url} alt={attachment.name} loading="lazy" onError={onError} />
        : attachment.kind === "video" ? <video src={url} aria-label={attachment.name} controls preload="metadata" {...video.videoFallbackProps} /> : <audio src={url} aria-label={attachment.name} controls preload="metadata" onError={onError} />;
}

export function CanvasAssistantAttachments({ attachments, onChange, onRemove }: {
    attachments: AssistantAttachment[];
    onChange?: (index: number, attachment: AssistantAttachment) => void;
    onRemove?: (index: number) => void;
}) {
    return <div className="canvas-assistant-attachments">{attachments.map((attachment, index) => {
        const error = attachmentRangeError(attachment);
        const supportsRange = attachment.kind === "video" || attachment.kind === "audio";
        return <div className="canvas-assistant-attachment" key={`${attachment.resourceId}:${index}`}>
            <div className="canvas-assistant-attachment-heading"><span title={attachment.name}>{attachment.name}</span>
                {onRemove ? <Button type="text" size="small" aria-label={`移除 ${attachment.name}`} icon={<X size={14} />} onClick={() => onRemove(index)} /> : null}</div>
            <AttachmentPreview attachment={attachment} />
            {attachment.kind !== "file" ? (
                <span className="canvas-assistant-meta">{attachment.bytes > 0 ? formatAttachmentBytes(attachment.bytes) : "已保存素材"}{attachment.durationMs ? ` · ${(attachment.durationMs / 1000).toFixed(1)} 秒` : ""}</span>
            ) : null}
            {onChange ? <Select size="small" aria-label={`${attachment.name} 的用途`} value={attachment.purpose} options={assistantAttachmentPurposes(attachment.kind)}
                labelRender={({ value }) => ASSISTANT_ATTACHMENT_PURPOSES.find(item => item.value === value)?.label || value}
                onChange={purpose => onChange(index, { ...attachment, purpose })} /> : <span className="canvas-assistant-meta">{ASSISTANT_ATTACHMENT_PURPOSES.find(item => item.value === attachment.purpose)?.label || "仅分析"}</span>}
            {supportsRange && onChange ? <div className="canvas-assistant-attachment-range">
                <InputNumber size="small" min={0} changeOnBlur={false} aria-label={`${attachment.name} 起始秒`} placeholder="起始秒" value={attachment.start} onChange={start => onChange(index, { ...attachment, start: start ?? undefined })} />
                <span>—</span><InputNumber size="small" min={0} changeOnBlur={false} aria-label={`${attachment.name} 结束秒`} placeholder="结束秒" value={attachment.end} onChange={end => onChange(index, { ...attachment, end: end ?? undefined })} />
            </div> : supportsRange && (attachment.start !== undefined || attachment.end !== undefined) ? <span className="canvas-assistant-meta">{attachment.start ?? 0} — {attachment.end} 秒</span> : null}
            {error ? <span className="canvas-assistant-meta" role="status">{error}</span> : null}
        </div>;
    })}</div>;
}
