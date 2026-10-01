import { describe, expect, test } from "bun:test";

import { chapterStoryboardApprovalSnapshot, chapterStoryboardRecoveryDecision, chapterTaskIdentity } from "@/pages/projects/detail/project-chapter-ai";
import type { GenerationTask } from "@/services/api/task-center";

describe("章节生成任务刷新恢复", () => {
    test("优先从任务列表的安全客户端上下文识别章节与操作", () => {
        expect(chapterTaskIdentity(task({
            clientContext: {
                domainProjectId: "project-1",
                chapterId: "chapter-1",
                chapterOperation: "characters",
            },
        }))).toEqual({ chapterId: "chapter-1", kind: "characters" });
    });

    test("任务详情可从脱敏输入 metadata 恢复分镜操作", () => {
        expect(chapterTaskIdentity(task({
            inputJson: JSON.stringify({
                metadata: {
                    domainProjectId: "project-1",
                    chapterId: "chapter-2",
                    source: "short-drama-chapter-storyboard",
                },
            }),
        }))).toEqual({ chapterId: "chapter-2", kind: "storyboard" });
    });

    test("无关、缺少章节或损坏的任务输入不会关联章节按钮", () => {
        expect(chapterTaskIdentity(task({ inputJson: "{" }))).toBeNull();
        expect(chapterTaskIdentity(task({ inputJson: JSON.stringify({ metadata: { operation: "chapter_character_breakdown" } }) }))).toBeNull();
        expect(chapterTaskIdentity(task({ inputJson: JSON.stringify({ metadata: { chapterId: "chapter-1", operation: "other" } }) }))).toBeNull();
    });

    test("从任务输入读取原批准快照，拒绝用当前页面版本顶上", () => {
        const current = { revision: 9, shotIds: ["shot-a"] };
        const snapshot = chapterStoryboardApprovalSnapshot(JSON.stringify({
            metadata: {
                domainProjectId: "project-1",
                chapterId: "chapter-1",
                source: "short-drama-chapter-storyboard",
                approvedRevision: 4,
                approvedShotIds: ["shot-a"],
            },
        }));
        expect(snapshot).toEqual({ revision: 4, shotIds: ["shot-a"] });
        expect(snapshot).not.toEqual(current);
    });

    test("刷新后同镜头 ID 内容已改时，仍按原批准快照恢复，不自动改用当前版本", () => {
        const currentAfterEdit = { revision: 6, shotIds: ["shot-a"] };
        const decision = chapterStoryboardRecoveryDecision({
            alreadyApplied: false,
            inputJson: JSON.stringify({
                metadata: {
                    source: "short-drama-chapter-storyboard",
                    approvedRevision: 5,
                    approvedShotIds: ["shot-a"],
                },
            }),
        });
        expect(decision).toEqual({ action: "apply", snapshot: { revision: 5, shotIds: ["shot-a"] } });
        expect(decision.action === "apply" ? decision.snapshot : null).not.toEqual(currentAfterEdit);
    });

    test("原批准版本未变时可以按快照恢复", () => {
        expect(chapterStoryboardRecoveryDecision({
            alreadyApplied: false,
            inputJson: JSON.stringify({
                metadata: {
                    approvedRevision: 3,
                    approvedShotIds: ["shot-a", "shot-b"],
                },
            }),
        })).toEqual({ action: "apply", snapshot: { revision: 3, shotIds: ["shot-a", "shot-b"] } });
    });

    test("缺少批准快照的旧任务不会自动写入", () => {
        expect(chapterStoryboardRecoveryDecision({
            alreadyApplied: false,
            inputJson: JSON.stringify({
                metadata: {
                    domainProjectId: "project-1",
                    chapterId: "chapter-1",
                    source: "short-drama-chapter-storyboard",
                },
            }),
        })).toEqual({ action: "review" });
        expect(chapterStoryboardApprovalSnapshot(JSON.stringify({
            metadata: { approvedRevision: 0, approvedShotIds: ["shot-a"] },
        }))).toBeNull();
        expect(chapterStoryboardRecoveryDecision({
            alreadyApplied: false,
            inputJson: JSON.stringify({ metadata: { approvedRevision: 4 } }),
        })).toEqual({ action: "review" });
    });

    test("已写入的任务不再自动替换", () => {
        expect(chapterStoryboardRecoveryDecision({
            alreadyApplied: true,
            inputJson: JSON.stringify({
                metadata: { approvedRevision: 4, approvedShotIds: ["shot-a"] },
            }),
        })).toEqual({ action: "skip" });
    });

    test("恢复路径使用任务快照，不会把当前页面版本写进自动替换", async () => {
        const source = await Bun.file(new URL("../src/pages/projects/detail/chapters.tsx", import.meta.url)).text();
        const helper = await Bun.file(new URL("../src/pages/projects/detail/project-chapter-ai.ts", import.meta.url)).text();
        expect(helper).toContain("approvedRevision: input.approvedRevision");
        expect(helper).toContain("approvedShotIds: input.approvedShotIds.slice()");
        expect(source).toContain("chapterStoryboardRecoveryDecision");
        expect(source).toContain("decision.snapshot");
        expect(source).toContain("reviewedRevision");
        expect(source).toContain("核对后写入");
        expect(source).not.toContain("revision: detail.project.revision");
        expect(source).not.toMatch(/storeGeneratedStoryboard\([^;]*detail\.project\.revision/);
    });
});

function task(overrides: Partial<GenerationTask>): GenerationTask {
    return {
        id: "task-1",
        type: "text",
        status: "running",
        prompt: "",
        attempts: 1,
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
        ...overrides,
    };
}
