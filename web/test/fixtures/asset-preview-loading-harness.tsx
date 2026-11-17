import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AssetMediaPreview } from "../../src/components/asset-media-preview";
import type { Asset } from "../../src/stores/use-asset-store";

const poster = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="orange"/></svg>')}`;

function Harness() {
    const params = (window as Window & { __fixture: { count: number; poster: boolean; portrait: boolean } }).__fixture;
    const [count, setCount] = useState(params.count);
    const [visible, setVisible] = useState(true);
    const [generation, setGeneration] = useState(0);
    const [clicks, setClicks] = useState(0);
    return <>
        <button onClick={() => setVisible(value => !value)}>切换列表</button>
        <button onClick={() => setGeneration(value => value + 1)}>换页</button>
        <button onClick={() => setCount(value => value + 1)}>添加素材</button>
        <button onClick={() => setClicks(value => value + 1)}>点击响应 {clicks}</button>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 160px)", gap: 8 }}>
            {visible && Array.from({ length: count }, (_, index) => {
                const id = `video-${generation}-${index}`;
                const asset: Asset = { id, kind: "video", title: id, coverUrl: params.poster ? poster : "", tags: [], createdAt: "2026-11-13", updatedAt: "2026-11-13", data: { url: `/api/resources/${id}/file`, storageKey: `resource:${id}`, width: 160, height: 90, bytes: 2048, mimeType: "video/mp4" } };
                return <div key={id} data-card={id} style={{ width: params.portrait ? 400 : 160, height: params.portrait ? 320 : 90 }}><AssetMediaPreview asset={asset} alt={id} className={params.portrait ? "generation-history-preview-media" : "preview"} hoverPlayDelayMs={100} fallback={<span>等待封面</span>} /></div>;
            })}
        </div>
    </>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
