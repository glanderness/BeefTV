import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { AssetLibraryPickerContent, type AssetLibraryPickerFolder, type AssetLibraryPickerItem } from "@/components/assets/asset-library-picker-modal";
import { CanvasActiveTaskPanel } from "@/components/canvas/canvas-active-task-panel";
import { CanvasNodeVideoPlayer } from "@/components/canvas/canvas-node-video-player";
import { CanvasProjectAssetModal } from "@/components/canvas/canvas-project-asset-modal";
import { CanvasVideoViewer } from "@/components/canvas/image-viewer/canvas-video-viewer";
import { hasCanvasKeyboardHost } from "@/lib/canvas/canvas-keyboard-scope";
import type { GenerationTask } from "@/services/api/task-center";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const sampleTaskDelivery: GenerationTask = {
    id: "task-delivery-1",
    type: "canvas_video",
    status: "succeeded",
    stage: "上次任务仍在处理，系统正在自动取回结果",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    outcome: { phase: "fetching", regenerate: "blocked", reason: "delivery_pending" },
};

const sampleTaskRunning: GenerationTask = {
    id: "task-running-1",
    type: "canvas_image",
    status: "running",
    stage: "生成中",
    progress: 45,
    createdAt: new Date(Date.now() - 25_000).toISOString(),
    startedAt: new Date(Date.now() - 25_000).toISOString(),
};

const sampleFolders: AssetLibraryPickerFolder[] = [
    { id: "folder-characters", name: "主角定妆" },
    { id: "folder-scenes", name: "夜景分镜" },
];

const sampleItems: AssetLibraryPickerItem[] = [
    { id: "a1", title: "女主侧面特写", category: "character", kindLabel: "图片", mediaKind: "image", folderId: "folder-characters" },
    { id: "a2", title: "男主雨夜站姿", category: "character", kindLabel: "图片", mediaKind: "image", folderId: "folder-characters" },
    { id: "a3", title: "赛博天台远景", category: "environment", kindLabel: "图片", mediaKind: "image", folderId: "folder-scenes" },
    { id: "a4", title: "未分类参考图", category: "other", kindLabel: "图片", mediaKind: "image" },
];

const sampleVideoNode: CanvasNodeData = {
    id: "video-node-1",
    type: CanvasNodeType.Video,
    title: "夜景开场镜头",
    position: { x: 0, y: 0 },
    width: 640,
    height: 360,
    metadata: {
        content: "/sample.mp4",
        mimeType: "video/mp4",
        naturalWidth: 320,
        naturalHeight: 180,
        durationMs: 2000,
        hasAudio: true,
    },
};

function Harness() {
    const [mode, setMode] = useState<"node-player" | "viewer" | "task-panel" | "asset-picker" | "remote-asset-picker" | "project-asset-fallback">(() => {
        const param = new URLSearchParams(window.location.search).get("mode");
        if (param === "viewer" || param === "task-panel" || param === "asset-picker" || param === "remote-asset-picker" || param === "project-asset-fallback") return param;
        return "node-player";
    });
    const [cancelledIds, setCancelledIds] = useState<string[]>([]);
    const [canvasSpacePanCount, setCanvasSpacePanCount] = useState(0);
    const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));

    // Register a canvas-like Space pan listener BEFORE fullscreen mounts to reproduce real InfiniteCanvas ordering.
    useEffect(() => {
        if (mode !== "node-player") return;
        const handleCanvasSpace = (event: KeyboardEvent) => {
            if (event.code !== "Space" || hasCanvasKeyboardHost()) return;
            if (event.target instanceof Element && event.target.closest("input,textarea,select,button,[contenteditable='true']")) return;
            event.preventDefault();
            setCanvasSpacePanCount((count) => count + 1);
        };
        window.addEventListener("keydown", handleCanvasSpace);
        return () => window.removeEventListener("keydown", handleCanvasSpace);
    }, [mode]);

    useEffect(() => {
        if (mode !== "remote-asset-picker" && mode !== "project-asset-fallback") return;
        useUserStore.setState({
            user: { id: "user-p1-test", username: "tester", nickname: "Tester", role: "user" } as ReturnType<typeof useUserStore.getState>["user"],
            hydrated: true,
        });
    }, [mode]);

    return (
        <QueryClientProvider client={queryClient}>
            <div style={{ padding: 24, minHeight: "100vh", background: "#141417", color: "#f5f5f7" }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                    <button type="button" onClick={() => setMode("node-player")}>node-player</button>
                    <button type="button" onClick={() => setMode("viewer")}>viewer</button>
                    <button type="button" onClick={() => setMode("task-panel")}>task-panel</button>
                    <button type="button" onClick={() => setMode("asset-picker")}>asset-picker</button>
                    <span data-testid="cancelled-log">{cancelledIds.join(",")}</span>
                    <span data-testid="canvas-space-pan-count">{canvasSpacePanCount}</span>
                </div>

                {mode === "node-player" ? (
                    <div style={{ width: 640, height: 360, position: "relative" }}>
                        <CanvasNodeVideoPlayer src="/sample.mp4" mimeType="video/mp4" title="测试节点视频" hasAudio />
                    </div>
                ) : null}

                {mode === "viewer" ? (
                    <CanvasVideoViewer node={sampleVideoNode} onClose={() => setMode("node-player")} />
                ) : null}

                {mode === "task-panel" ? (
                    <div style={{ position: "relative", height: 500 }}>
                        <CanvasActiveTaskPanel
                            tasks={[sampleTaskDelivery, sampleTaskRunning]}
                            nodes={[sampleTaskDelivery, sampleTaskRunning].map(task => ({
                                ...sampleVideoNode,
                                id: `node-${task.id}`,
                                type: task.type === "canvas_image" ? CanvasNodeType.Image : CanvasNodeType.Video,
                                metadata: { taskId: task.id },
                            }))}
                            topInset="16px"
                            onLocateNode={() => undefined}
                            onCancelTask={(task) => setCancelledIds((prev) => [...prev, `${task.id}:${task.status}`])}
                        />
                    </div>
                ) : null}

                {mode === "asset-picker" ? (
                    <div style={{ width: 920, height: 560, border: "1px solid #333", borderRadius: 12, overflow: "hidden" }}>
                        <AssetLibraryPickerContent
                            open
                            items={sampleItems}
                            categoryLabels={{ all: "全部素材", character: "角色", environment: "场景", other: "其他" }}
                            folders={sampleFolders}
                            mediaKinds={["image", "video", "audio", "text"]}
                            onClose={() => undefined}
                            onConfirm={() => undefined}
                        />
                    </div>
                ) : null}

                {mode === "remote-asset-picker" ? (
                    <div style={{ width: 920, height: 560, border: "1px solid #333", borderRadius: 12, overflow: "hidden" }}>
                        <AssetLibraryPickerContent
                            remoteLibrary
                            open
                            items={[]}
                            categoryLabels={{ all: "全部素材", character: "角色", environment: "场景", other: "其他" }}
                            mediaKinds={["image", "video", "audio", "text"]}
                            onClose={() => undefined}
                            onConfirm={() => undefined}
                        />
                    </div>
                ) : null}

                {mode === "project-asset-fallback" ? (
                    <CanvasProjectAssetModal
                        open
                        detail={undefined}
                        onClose={() => undefined}
                        onInsert={() => undefined}
                        onInsertFolder={() => {
                            throw new Error("should not invoke project folder insert for personal folder");
                        }}
                    />
                ) : null}
            </div>
        </QueryClientProvider>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
