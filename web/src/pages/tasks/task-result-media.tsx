import { App, Button, Typography } from "antd";
import { useState } from "react";
import { MediaPreview } from "@/components/media-preview";
import { parseTimelineRenderResult } from "@/services/api/timeline-tasks";
import { resourceFileUrl } from "@/services/api/resources";
import { downloadOwnedOrBrowserMedia, reportOwnedMediaSave } from "@/services/desktop-media-save";

function TimelineRenderMedia({ value }: { value?: string }) {
    const { message } = App.useApp();
    const [saving, setSaving] = useState(false);
    let result;
    try { result = parseTimelineRenderResult(value); } catch { return null; }
    const resourceId = result.resourceId;
    const url = resourceFileUrl(resourceId);
    const save = async () => {
        if (saving) return;
        setSaving(true);
        try {
            await reportOwnedMediaSave(message, downloadOwnedOrBrowserMedia({
                resourceId, browserUrl: url, fileName: result.fileName || "成片.mp4",
            }));
        } finally { setSaving(false); }
    };
    return <div>
        <Typography.Text strong>成片结果</Typography.Text>
        <MediaPreview src={url} kind="video" controls alt="后台成片" className="task-result-media is-video" fallbackClassName="task-result-media is-video" />
        <Button loading={saving} onClick={() => void save()}>下载成片</Button>
    </div>;
}

export function TaskResultMedia({ value, taskType, status }: { value?: string; taskType: string; status: string }) {
    if (taskType === "timeline_render") return status === "succeeded" ? <TimelineRenderMedia key={value} value={value} /> : null;
    const urls = resultMediaUrls(value);
    if (!urls.length) return null;
    return (
        <div>
            <Typography.Text strong>生成结果</Typography.Text>
            <div className="mt-2 grid max-h-[360px] grid-cols-2 gap-2 overflow-auto rounded-lg bg-stone-950 p-2 md:grid-cols-3">
                {urls.map((url, index) => {
                    const isVideo = isVideoResult(url, taskType);
                    return (
                        <MediaPreview
                            key={`${url}-${index}`}
                            src={url}
                            kind={isVideo ? "video" : "image"}
                            alt={`生成结果 ${index + 1}`}
                            controls={isVideo}
                            className={isVideo ? "task-result-media is-video" : "task-result-media"}
                            fallbackClassName={isVideo ? "task-result-media is-video" : "task-result-media"}
                        />
                    );
                })}
            </div>
        </div>
    );
}

function resultMediaUrls(value?: string) {
    if (!value) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        parsed = value;
    }
    const urls: string[] = [];
    const visit = (item: unknown, key = "") => {
        if (typeof item === "string") {
            const isInlineMedia = /^(data:image\/|data:video\/)/.test(item);
            const isMediaPath = /\.(png|jpe?g|webp|gif|avif|mp4|webm|mov)(?:$|\?)/i.test(item);
            const isNamedMediaUrl = /^(https?:|blob:)/.test(item) && /(url|image|video|result|output|media)/i.test(key);
            if ((isInlineMedia || isMediaPath || isNamedMediaUrl) && !urls.includes(item)) urls.push(item);
            return;
        }
        if (Array.isArray(item)) return item.forEach((value) => visit(value, key));
        if (item && typeof item === "object") Object.entries(item).forEach(([field, value]) => visit(value, field));
    };
    visit(parsed);
    return urls.slice(0, 12);
}

function isVideoResult(value: string, taskType: string) {
    return value.startsWith("data:video/") || /\.(mp4|webm|mov)(?:$|\?)/i.test(value) || taskType.includes("video");
}
