import { createRoot } from "react-dom/client";
import { App } from "antd";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CanvasPage from "../../src/pages/canvas";
import { useCanvasStore, type CanvasProject } from "../../src/stores/canvas/use-canvas-store";
import { useUserStore } from "../../src/stores/use-user-store";
import { exportCanvasProjects } from "../../src/lib/canvas/canvas-export";
import { setMediaBlob, getMediaBlob } from "../../src/services/file-storage";
import { reportOwnedMediaSave } from "../../src/services/desktop-media-save";

let archive = "";
Object.assign(window, { go: { main: { DesktopApp: { SaveOwnedArtifact: async (_name: string, data: string) => { archive = data; return true; } } } } });

function fixtureProject(id: string): CanvasProject {
    return {
        id, title: `测试 ${id}`, createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z",
        nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 }, directorScenes: [],
        timeline: { version: 2, durationMs: 1000, tracks: [{ id: "voice", kind: "audio", label: "配音", order: 0 }], clips: [
            { id: "voice", kind: "audio", nodeId: "direct:voice", trackId: "voice", startMs: 0, durationMs: 1000,
                directMedia: { id: "voice", kind: "audio", title: "测试配音", storageKey: "audio:fixture:voice", url: "blob:expired", mimeType: "audio/wav", durationMs: 1000 } },
        ] },
    };
}

function Controls() {
    const { message } = App.useApp();
    return <button onClick={() => void reportOwnedMediaSave(message, exportCanvasProjects([fixtureProject("missing")]))}>测试缺失导出</button>;
}

Object.assign(window, { exportFixture: {
    async export() {
        await setMediaBlob("audio:fixture:voice", new Blob(["unique archive bytes"], { type: "audio/wav" }));
        await exportCanvasProjects([fixtureProject("first"), fixtureProject("second")]);
        return archive;
    },
    async snapshot() {
        const media = await getMediaBlob("audio:fixture:voice");
        return { projects: useCanvasStore.getState().projects, media: media ? await media.text() : null, archive };
    },
} });

await useCanvasStore.persist.rehydrate();
useUserStore.setState({ hydrated: true, storageMode: "local", user: null });
useCanvasStore.setState({ hydrated: true });
createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/canvas"]}><App><Controls /><CanvasPage /></App></MemoryRouter>
    </QueryClientProvider>,
);
