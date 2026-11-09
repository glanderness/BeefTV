import { expect, test } from "bun:test";
import { prepareTimelineRenderSnapshot } from "@/lib/timeline/timeline-render-snapshot";
import { parseTimelineRenderResult } from "@/services/api/timeline-tasks";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineProject } from "@/types/timeline";

const node = { id: "source", type: "video", title: "原视频", metadata: { storageKey: "resource:owned-source", assetId: "asset-source" } } as CanvasNodeData;
function project(): TimelineProject {
    return { version: 2, durationMs: 3000, output: { width: 720, height: 1280, fps: 24 },
        tracks: [{ id: "v", kind: "video", order: 0, label: "视频" }, { id: "s", kind: "subtitle", order: 1, label: "字幕" }],
        clips: [{ id: "video", kind: "video", nodeId: "source", trackId: "v", startMs: 0, durationMs: 3000, sourceStartMs: 200, volume: 0.3, fadeInMs: 50 },
            { id: "sub", kind: "subtitle", nodeId: "source", trackId: "s", startMs: 200, durationMs: 2000, text: "两行\n字幕" }],
    };
}
test("backend snapshot freezes node resources, crop/audio/subtitles/output without mutating draft", () => {
    const draft = project(); const original = structuredClone(draft);
    const source = structuredClone(node);
    const result = prepareTimelineRenderSnapshot(draft, [source]);
    expect(draft).toEqual(original);
    expect(result.clips[0]).toMatchObject({ sourceStartMs: 200, volume: 0.3, fadeInMs: 50, directMedia: { storageKey: "resource:owned-source", assetId: "asset-source" } });
    draft.clips[1].text = "changed"; draft.output!.width = 1920; source.metadata!.storageKey = "resource:changed";
    expect(result.clips[1].text).toBe("两行\n字幕");
    expect(result.output).toEqual({ width: 720, height: 1280, fps: 24 });
    expect(result.clips[0].directMedia?.storageKey).toBe("resource:owned-source");
});
test("direct media takes precedence, hidden media does not block export, missing references identify the clip", () => {
    const draft = project();
    draft.clips[0].directMedia = { id: "asset-direct", title: "直连素材", kind: "video", storageKey: "resource:owned-direct" };
    draft.tracks.push({ id: "hidden", kind: "video", order: 2, label: "隐藏", visible: false });
    draft.clips.push({ id: "hidden", nodeId: "absent", trackId: "hidden", kind: "video", startMs: 0, durationMs: 1000 });
    expect(prepareTimelineRenderSnapshot(draft, [node]).clips[0].directMedia?.storageKey).toBe("resource:owned-direct");
    expect(prepareTimelineRenderSnapshot(draft, [node]).clips[0].directMedia?.assetId).toBeUndefined();
    draft.clips[0].directMedia.storageKey = "blob:local";
    expect(() => prepareTimelineRenderSnapshot(draft, [node])).toThrow("直连素材");
});
test("render result decoding rejects malformed and absent IDs", () => {
    for (const value of ["{", "null", "{}", '{"resourceId":42}', '{"resourceId":" "}']) expect(() => parseTimelineRenderResult(value)).toThrow();
    expect(parseTimelineRenderResult('{"resourceId":"owned-result","fileName":"timeline.mp4"}').resourceId).toBe("owned-result");
});
