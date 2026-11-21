import { App } from "antd";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/assets-reference-baseline.css";
import { AssetMediaPreview } from "../../src/components/asset-media-preview";
import { InactiveVideoPreview } from "../../src/components/canvas/canvas-node-content";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { setCanvasMemoryMode } from "../../src/lib/canvas/canvas-memory-policy";
import { GenerationHistorySurface } from "../../src/pages/assets/assets-generation-history";
import type { LibraryAsset } from "../../src/pages/assets/assets-shared";
import { acquireCanvasVideoPreview, captureCanvasVideoPosterBlobUrl, setCanvasVideoPosterTimeoutForTests } from "../../src/services/canvas-video-preview";
import { setDirectMediaAssetsEnabled } from "../../src/services/media-asset-url";
import type { Asset } from "../../src/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";

const poster = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="orange"/></svg>')}`;
const portraitPoster = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="90" height="160"><rect width="90" height="160" fill="orange"/></svg>')}`;

type FixtureParams = { count: number; poster: boolean; portrait: boolean; directPoster: boolean; lowMemory: boolean; protectedCoverFail: boolean; drawer: boolean; libraryCard: boolean; posterTimeoutMs: number; prestartCanvasPreview: boolean; canvasVideoPoster?: boolean };
const initialParams = (window as Window & { __fixture: FixtureParams }).__fixture;
setDirectMediaAssetsEnabled(initialParams.directPoster);
setCanvasMemoryMode(initialParams.lowMemory ? "low-memory" : "normal");
setCanvasVideoPosterTimeoutForTests(initialParams.posterTimeoutMs > 0 ? initialParams.posterTimeoutMs : null);

const previewApi = window as Window & {
    __previewJoin?: {
        startCanvasPreview: (id: string) => void;
        joinTimedPoster: (id: string, timeoutMs: number) => Promise<{ ok: boolean; errorName?: string; url?: string }>;
        awaitCanvasPreview: () => Promise<boolean>;
    };
};
let activeCanvasLease: ReturnType<typeof acquireCanvasVideoPreview> | undefined;
if (initialParams.prestartCanvasPreview) {
    activeCanvasLease = acquireCanvasVideoPreview({ metadata: { storageKey: "resource:video-0-0", content: "/api/resources/video-0-0/file" } });
}
previewApi.__previewJoin = {
    startCanvasPreview(id: string) {
        activeCanvasLease?.release();
        activeCanvasLease = acquireCanvasVideoPreview({ metadata: { storageKey: `resource:${id}`, content: `/api/resources/${id}/file` } });
    },
    async joinTimedPoster(id: string, timeoutMs: number) {
        try {
            const url = await captureCanvasVideoPosterBlobUrl(
                { metadata: { storageKey: `resource:${id}`, content: `/api/resources/${id}/file` } },
                { timeoutMs },
            );
            if (url) URL.revokeObjectURL(url);
            return { ok: Boolean(url), url };
        } catch (error) {
            return { ok: false, errorName: error instanceof Error ? error.name : String(error) };
        }
    },
    async awaitCanvasPreview() {
        const result = await activeCanvasLease?.promise;
        activeCanvasLease?.release();
        activeCanvasLease = undefined;
        return Boolean(result?.content);
    },
};

function Harness() {
    const params = initialParams;
    const [count, setCount] = useState(params.count);
    const [visible, setVisible] = useState(true);
    const [generation, setGeneration] = useState(0);
    const [clicks, setClicks] = useState(0);
    if (params.canvasVideoPoster) {
        const videoNode: CanvasNodeData = {
            id: "canvas-vid-1",
            type: CanvasNodeType.Video,
            title: "生成视频",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: {
                storageKey: "resource:video-0-0",
                content: "/api/resources/video-0-0/file",
                mimeType: "video/mp4",
                status: "success",
            },
        };
        return (
            <div style={{ padding: 16 }}>
                <div data-testid="canvas-video-preview" style={{ width: 320, height: 180 }}>
                    <InactiveVideoPreview node={videoNode} theme={canvasThemes.dark} onPlay={() => undefined} />
                </div>
            </div>
        );
    }
    if (params.drawer) {
        const videoAsset: LibraryAsset = {
            id: "hist-video-1",
            kind: "video",
            title: "历史视频成片",
            coverUrl: poster,
            tags: [],
            status: "confirmed",
            source: "生成任务",
            createdAt: "2026-11-13T00:00:00Z",
            updatedAt: "2026-11-13T00:00:00Z",
            data: { url: "/api/resources/video-0-0/file", storageKey: "resource:video-0-0", width: 160, height: 90, bytes: 2048, mimeType: "video/mp4" },
            metadata: { taskId: "task-video-1" },
        };
        return <App>
            <GenerationHistorySurface
                assets={[videoAsset]}
                generatedTotal={1}
                generatedKindCounts={{ video: 1 }}
                libraryTotal={0}
                onSelectPersonal={() => {}}
                onSaveToLibrary={() => {}}
                onDownload={() => {}}
                onDelete={async () => false}
            />
        </App>;
    }
    return <>
        <button onClick={() => setVisible(value => !value)}>切换列表</button>
        <button onClick={() => setGeneration(value => value + 1)}>换页</button>
        <button onClick={() => setCount(value => value + 1)}>添加素材</button>
        <button onClick={() => setClicks(value => value + 1)}>点击响应 {clicks}</button>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 160px)", gap: 8 }}>
            {visible && Array.from({ length: count }, (_, index) => {
                const id = `video-${generation}-${index}`;
                const coverUrl = params.protectedCoverFail
                    ? `/api/resources/broken-cover-${index}/file`
                    : params.poster
                        ? (params.portrait ? portraitPoster : poster)
                        : "";
                const asset: Asset = { id, kind: "video", title: id, coverUrl, tags: [], createdAt: "2026-11-13", updatedAt: "2026-11-13", data: { url: `/api/resources/${id}/file`, storageKey: `resource:${id}`, width: 160, height: 90, bytes: 2048, mimeType: "video/mp4" } };
                const preview = <AssetMediaPreview asset={asset} alt={id} className={params.portrait ? "generation-history-preview-media" : params.libraryCard ? "assets-cover-media" : "preview"} hoverPlayDelayMs={100} fallback={<span>等待封面</span>} />;
                return <div key={id} data-card={id} style={{ width: params.portrait ? 400 : 160, height: params.portrait ? 480 : 90 }}>{params.libraryCard ? <button type="button" className="assets-cover-link">{preview}</button> : preview}</div>;
            })}
        </div>
    </>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
