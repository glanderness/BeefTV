import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { InactiveVideoPreview } from "@/components/canvas/canvas-node-content";
import { CanvasNodeActionContext } from "@/components/canvas/canvas-node-action-context";
import { canvasThemes } from "@/lib/canvas-theme";
import { setActiveUserScope } from "@/lib/user-scope";
import { acquireCanvasVideoPreview } from "@/services/canvas-video-preview";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const created: string[] = [], revoked: string[] = [];
const originalCreate = URL.createObjectURL.bind(URL), originalRevoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => { const url = originalCreate(blob); created.push(url); return url; };
URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url); };
setActiveUserScope("A");
let writes = 0;
const initial: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "参考视频", x: 0, y: 0, width: 320, height: 180, metadata: { content: "/red.mp4" } };
function Harness() {
    const [node, setNode] = useState(initial);
    const [visible, setVisible] = useState(true);
    Object.assign(window, { previewHarness: {
        state: () => ({ created, revoked, writes, node }),
        source: (content: string) => setNode((n) => ({ ...n, metadata: { content } })),
        oldPoster: () => setNode((n) => ({ ...n, metadata: { content: "/red.mp4", videoPreview: { content: "/poster.svg", captureVersion: 2, sourceKey: "/red.mp4" } } })),
        cycle: () => { setActiveUserScope("B"); setActiveUserScope("A"); },
        unmount: () => setVisible(false),
        /** 第一次读取视频失败：同一次请求内部重试后就该拿到首帧，不需要等重新挂载。 */
        flaky: async () => {
            const lease = acquireCanvasVideoPreview({ ...initial, metadata: { content: "/flaky.mp4" } });
            const preview = await lease.promise;
            lease.release();
            return Boolean(preview);
        },
        /** 一直取不到视频：这次请求只能放弃，但失败的请求不能把后面的重试也堵掉。 */
        broken: async () => {
            const failed = acquireCanvasVideoPreview({ ...initial, metadata: { content: "/broken.mp4" } });
            const first = await failed.promise;
            failed.release();
            const recovered = acquireCanvasVideoPreview(initial);
            const second = await recovered.promise;
            recovered.release();
            return { first: first === null, recovered: Boolean(second) };
        },
        releaseRace: async () => {
            const create = URL.createObjectURL;
            const lease = acquireCanvasVideoPreview(initial);
            URL.createObjectURL = (blob) => { const url = create(blob); lease.release(); URL.createObjectURL = create; return url; };
            const result = await lease.promise;
            URL.createObjectURL = create;
            return result;
        },
        shared: async () => {
            const a = acquireCanvasVideoPreview(initial), b = acquireCanvasVideoPreview(initial);
            const first = await a.promise, second = await b.promise;
            a.release(); const revokedBeforeLast = revoked.includes(first!.content);
            b.release();
            return { same: first === second, revokedBeforeLast, revokedAfterLast: revoked.includes(first!.content) };
        },
        capacity: async () => {
            const leases = Array.from({ length: 33 }, (_, i) => acquireCanvasVideoPreview({ ...initial, metadata: { content: `/red.mp4?cache=${i}` } }));
            const last = await leases[32].promise;
            leases.forEach((lease) => lease.release());
            const recovered = acquireCanvasVideoPreview(initial);
            const result = await recovered.promise;
            recovered.release();
            return { last, recovered: Boolean(result) };
        },
    } });
    return <><div style={{ height: 2500 }}>滚动画布</div><CanvasNodeActionContext.Provider value={{ updateMetadata() { writes += 1; } }}><div style={{ width: 320, height: 180 }}>{visible && <InactiveVideoPreview node={node} theme={canvasThemes.dark} onPlay={() => undefined} hoverEnabled={false} />}</div></CanvasNodeActionContext.Provider></>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
