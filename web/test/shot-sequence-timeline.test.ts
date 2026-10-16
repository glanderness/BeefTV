import { describe, expect, test } from "bun:test";

import { buildDeliveryTimeline, type DeliveryTimelineInput } from "../src/lib/timeline/shot-sequence-timeline";
import type { ProjectShot, ShotArtifact, ShotRevision } from "../src/services/api/projects";

const UNIT_ID = "unit-1";

function shot(overrides: Partial<ProjectShot> & { id: string }): ProjectShot {
    return {
        projectId: "project-1",
        unitId: UNIT_ID,
        title: `镜头 ${overrides.id}`,
        description: "",
        position: 0,
        durationMs: 3000,
        status: "ready",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

function videoArtifact(overrides: Partial<ShotArtifact> & { shotId: string }): ShotArtifact {
    return {
        id: `artifact-${overrides.shotId}`,
        projectId: "project-1",
        unitId: UNIT_ID,
        type: "video",
        version: 1,
        resourceId: `res-${overrides.shotId}`,
        status: "ready",
        selected: true,
        metadataJson: "{}",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

function revision(overrides: Partial<ShotRevision> & { shotId: string }): ShotRevision {
    return {
        id: `revision-${overrides.shotId}`,
        version: 1,
        plotDescription: "",
        action: "",
        dialogue: "",
        shotSize: "",
        cameraAngle: "",
        cameraMovement: "",
        durationMs: 3000,
        imagePrompt: "",
        videoPrompt: "",
        negativePrompt: "",
        continuityNotes: "",
        actionBeatsJson: "[]",
        createdAt: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

function detail(input: Partial<DeliveryTimelineInput>): DeliveryTimelineInput {
    return { shots: [], shotArtifacts: [], shotRevisions: [], ...input };
}

describe("buildDeliveryTimeline", () => {
    test("按 position 排序并顺序累积 startMs，不留空隙", () => {
        const { timeline, issues } = buildDeliveryTimeline(
            detail({
                shots: [
                    shot({ id: "shot-c", position: 2, durationMs: 2000 }),
                    shot({ id: "shot-a", position: 0, durationMs: 3000 }),
                    shot({ id: "shot-b", position: 1, durationMs: 1500 }),
                ],
                shotArtifacts: [
                    videoArtifact({ shotId: "shot-a" }),
                    videoArtifact({ shotId: "shot-b" }),
                    videoArtifact({ shotId: "shot-c" }),
                ],
            }),
            UNIT_ID,
        );

        expect(issues).toEqual([]);
        expect(timeline.clips.map((clip) => clip.nodeId)).toEqual(["shot-a", "shot-b", "shot-c"]);
        expect(timeline.clips.map((clip) => clip.startMs)).toEqual([0, 3000, 4500]);
        expect(timeline.durationMs).toBe(6500);
        // 末段末端必须等于总时长，说明没有空隙段。
        const last = timeline.clips[timeline.clips.length - 1];
        expect(last.startMs + last.durationMs).toBe(timeline.durationMs);
    });

    test("只取本章镜头，忽略其他单元", () => {
        const { timeline, shotCount } = buildDeliveryTimeline(
            detail({
                shots: [shot({ id: "shot-a" }), shot({ id: "shot-other", unitId: "unit-2" })],
                shotArtifacts: [videoArtifact({ shotId: "shot-a" }), videoArtifact({ shotId: "shot-other", unitId: "unit-2" })],
            }),
            UNIT_ID,
        );

        expect(shotCount).toBe(1);
        expect(timeline.clips.map((clip) => clip.nodeId)).toEqual(["shot-a"]);
    });

    test("视频片段用 resource: 前缀标识存储键", () => {
        const { timeline } = buildDeliveryTimeline(
            detail({ shots: [shot({ id: "shot-a" })], shotArtifacts: [videoArtifact({ shotId: "shot-a", resourceId: "abc123" })] }),
            UNIT_ID,
        );

        const clip = timeline.clips[0];
        expect(clip.directMedia?.storageKey).toBe("resource:abc123");
        expect(clip.directMedia?.kind).toBe("video");
        expect(timeline.tracks.map((track) => track.kind)).toEqual(["video", "subtitle"]);
    });

    test("台词生成与视频片段对齐的字幕片段", () => {
        const { timeline } = buildDeliveryTimeline(
            detail({
                shots: [shot({ id: "shot-a", durationMs: 4000, currentRevisionId: "revision-shot-a" })],
                shotArtifacts: [videoArtifact({ shotId: "shot-a" })],
                shotRevisions: [revision({ shotId: "shot-a", dialogue: "你好\n世界" })],
            }),
            UNIT_ID,
        );

        const subtitle = timeline.clips.find((clip) => clip.kind === "subtitle");
        expect(subtitle).toBeDefined();
        expect(subtitle?.text).toBe("你好 世界");
        expect(subtitle?.startMs).toBe(0);
        expect(subtitle?.durationMs).toBe(4000);
        expect(subtitle?.trackId).toBe("t-subtitle");
    });

    test("空台词不生成字幕片段", () => {
        const { timeline } = buildDeliveryTimeline(
            detail({
                shots: [shot({ id: "shot-a" })],
                shotArtifacts: [videoArtifact({ shotId: "shot-a" })],
                shotRevisions: [revision({ shotId: "shot-a", dialogue: "   " })],
            }),
            UNIT_ID,
        );

        expect(timeline.clips.some((clip) => clip.kind === "subtitle")).toBe(false);
    });

    test("缺视频产物时报告缺片且不产片段", () => {
        const { timeline, issues } = buildDeliveryTimeline(
            detail({ shots: [shot({ id: "shot-a", title: "开场" })], shotArtifacts: [] }),
            UNIT_ID,
        );

        expect(timeline.clips).toEqual([]);
        expect(issues).toEqual([{ kind: "missing_video", shotId: "shot-a", title: "开场" }]);
        expect(timeline.durationMs).toBe(0);
    });

    test("产物未就绪时报告状态且不产片段", () => {
        const { issues } = buildDeliveryTimeline(
            detail({
                shots: [shot({ id: "shot-a" })],
                shotArtifacts: [videoArtifact({ shotId: "shot-a", status: "running" })],
            }),
            UNIT_ID,
        );

        expect(issues).toEqual([{ kind: "video_not_ready", shotId: "shot-a", title: "镜头 shot-a", status: "running" }]);
    });

    test("产物缺少 resourceId 时按未就绪处理", () => {
        const { issues } = buildDeliveryTimeline(
            detail({
                shots: [shot({ id: "shot-a" })],
                shotArtifacts: [videoArtifact({ shotId: "shot-a", resourceId: "" })],
            }),
            UNIT_ID,
        );

        expect(issues).toHaveLength(1);
        expect(issues[0].kind).toBe("video_not_ready");
    });

    test("优先用产物声明的 durationSeconds，其次回退镜头时长", () => {
        const { timeline } = buildDeliveryTimeline(
            detail({
                shots: [shot({ id: "shot-a", durationMs: 9999 })],
                shotArtifacts: [videoArtifact({ shotId: "shot-a", metadataJson: JSON.stringify({ durationSeconds: 2.5 }) })],
            }),
            UNIT_ID,
        );

        expect(timeline.clips[0].durationMs).toBe(2500);
    });

    test("metadataJson 非法时回退镜头时长", () => {
        const { timeline, issues } = buildDeliveryTimeline(
            detail({
                shots: [shot({ id: "shot-a", durationMs: 3000 })],
                shotArtifacts: [videoArtifact({ shotId: "shot-a", metadataJson: "{ 不是 JSON" })],
            }),
            UNIT_ID,
        );

        expect(issues).toEqual([]);
        expect(timeline.clips[0].durationMs).toBe(3000);
    });

    test("声明时长与镜头时长都无效时报零时长", () => {
        const { timeline, issues } = buildDeliveryTimeline(
            detail({
                shots: [shot({ id: "shot-a", durationMs: 0 })],
                shotArtifacts: [videoArtifact({ shotId: "shot-a", metadataJson: JSON.stringify({ durationSeconds: 0 }) })],
            }),
            UNIT_ID,
        );

        expect(timeline.clips).toEqual([]);
        expect(issues).toEqual([{ kind: "zero_duration", shotId: "shot-a", title: "镜头 shot-a" }]);
    });

    test("有多个版本时优先取 selected 的产物", () => {
        const { timeline } = buildDeliveryTimeline(
            detail({
                shots: [shot({ id: "shot-a" })],
                shotArtifacts: [
                    videoArtifact({ shotId: "shot-a", id: "old", version: 1, selected: false, resourceId: "res-old" }),
                    videoArtifact({ shotId: "shot-a", id: "new", version: 2, selected: true, resourceId: "res-new" }),
                ],
            }),
            UNIT_ID,
        );

        expect(timeline.clips[0].directMedia?.storageKey).toBe("resource:res-new");
    });

    test("缺片镜头被跳过后，后续镜头的 startMs 不受影响", () => {
        const { timeline } = buildDeliveryTimeline(
            detail({
                shots: [
                    shot({ id: "shot-a", position: 0, durationMs: 3000 }),
                    shot({ id: "shot-b", position: 1, durationMs: 2000 }),
                ],
                shotArtifacts: [videoArtifact({ shotId: "shot-b" })],
            }),
            UNIT_ID,
        );

        expect(timeline.clips).toHaveLength(1);
        // 缺片的 shot-a 不占时间轴位置，成片从 0 开始。
        expect(timeline.clips[0].startMs).toBe(0);
        expect(timeline.clips[0].nodeId).toBe("shot-b");
        expect(timeline.durationMs).toBe(2000);
    });
});
