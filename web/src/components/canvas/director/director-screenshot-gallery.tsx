import { Image } from "antd";
import { useEffect, useState } from "react";

import { resolveImageUrl } from "@/services/image-storage";
import type { DirectorScreenshot } from "@/types/director";

export function DirectorScreenshotGallery({ screenshots }: { screenshots: DirectorScreenshot[] }) {
    return <section aria-label="相机截图" className="space-y-2 border-t pt-3" style={{ borderColor: "var(--director-sequencer-border)" }}>
        <h3 className="text-sm font-medium">相机截图</h3>
        {screenshots.length ? <div className="grid grid-cols-2 gap-2">{screenshots.map((screenshot) => <ScreenshotCard key={screenshot.id} screenshot={screenshot} />)}</div> : <p className="text-xs opacity-55">暂无截图</p>}
    </section>;
}

function ScreenshotCard({ screenshot }: { screenshot: DirectorScreenshot }) {
    const [url, setUrl] = useState(screenshot.url);
    useEffect(() => {
        let active = true;
        void resolveImageUrl(screenshot.storageKey, screenshot.url, { cacheMiss: true }).then((resolved) => { if (active) setUrl(resolved); }).catch(() => {});
        return () => { active = false; };
    }, [screenshot.storageKey, screenshot.url]);
    return <div className="min-w-0 overflow-hidden rounded-lg border" style={{ borderColor: "var(--director-sequencer-border)" }}>
        <Image src={url} alt={screenshot.name} width="100%" className="aspect-video object-cover" preview={{ mask: "查看" }} />
        <span className="block truncate px-2 py-1 text-xs" title={screenshot.name}>{screenshot.name}</span>
    </div>;
}
