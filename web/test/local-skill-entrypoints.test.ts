import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillDetailModal } from "../src/pages/skills/skill-detail-drawer";
import type { Skill } from "../src/services/api/skills";

describe("local skill entrypoints", () => {
    test("renders GitHub sync button for owned GitHub skills in local runtime", () => {
        const githubSkill: Skill = {
            skillId: "gh-1",
            skillName: "GitHub 技能",
            description: "来自 GitHub 的技能",
            instruction: "# GitHub 技能",
            tag: "creative",
            isPrivate: true,
            status: 1,
            source: 2,
            sourceType: "github",
            sourceUrl: "https://github.com/example/skills",
            version: "1.0.0",
            versionId: "v1",
            contentHash: "a".repeat(64),
            fileCount: 1,
            totalBytes: 128,
            autoUpdate: true,
            syncStatus: "synced",
            likesCount: 0,
            addedCount: 1,
            createdAt: "2026-11-06T00:00:00Z",
            updatedAt: "2026-11-06T00:00:00Z",
            isLike: false,
            isAdded: true,
            isOwner: true,
        };
        const html = renderToStaticMarkup(
            <SkillDetailModal
                skill={githubSkill}
                loading={false}
                mutating={false}
                categories={[]}
                onClose={() => undefined}
                onAdd={() => undefined}
                onLike={() => undefined}
                onEdit={() => undefined}
                onSync={() => undefined}
            />,
        );
        expect(html).toContain("同步");
        expect(html).toContain("编辑");
    });
});
