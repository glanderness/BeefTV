import { expect, test } from "bun:test";
import { canSubmitPublication, needsPublicationTargetCorrection, requirementLabel, publicationStatus, unsupportedRequirements } from "../src/pages/skills/market-copy";
import { SKILL_MARKET_RISK_ACCEPTED_KEY, acceptSkillMarketRisk, hasAcceptedSkillMarketRisk, isOfficialBuiltinMarketSkill } from "../src/pages/skills/skill-market-install-confirm-modal";

async function source(path: string) {
    return Bun.file(new URL(path, import.meta.url)).text();
}

test("implemented skill route is discoverable while reference experiments remain hidden", async () => {
    const [router, sidebar] = await Promise.all([
        source("../src/router.tsx"),
        source("../src/components/layout/workspace-sidebar-nav.tsx"),
    ]);
    expect(router).toContain('{ path: "/skill", element: <Navigate to="/skills" replace /> }');
    expect(router).toContain('{ path: "/skills", element: deferred(<SkillsPage />) }');
    expect(router).not.toContain("SkillsReferencePage");
    expect(sidebar).toContain('toolItem("skills", "/skills")');
});

test("public submission requires this preview and a separate user confirmation", () => {
    for (const status of ["awaiting_upload_confirmation", "uploading", "needs_preview", "submitted", "published", "rejected"]) {
        expect(canSubmitPublication({ status, preview: { revision: 2 } }, true)).toBe(false);
    }
    expect(canSubmitPublication({ status: "awaiting_submit_confirmation" }, true)).toBe(false);
    expect(canSubmitPublication({ status: "awaiting_submit_confirmation", preview: {} }, false)).toBe(false);
    expect(canSubmitPublication({ status: "awaiting_submit_confirmation", preview: {} }, true)).toBe(true);
});

test("unknown capabilities and publication states never look accepted", () => {
    expect(requirementLabel("model.audio")).toBe("音频理解模型");
    expect(requirementLabel("needs secret")).toContain("未确认");
    expect(publicationStatus("new-unknown-state")).toBe("状态待刷新");
    expect(publicationStatus("ready_to_submit")).toBe("等待确认发布");
    expect(publicationStatus("awaiting_submit_confirmation")).toBe("等待确认发布");
    expect(publicationStatus("published")).toBe("已发布");
    expect(publicationStatus("rejected")).toBe("需要修改");
});

test("third-party market skills require one-time risk acceptance while official built-in skills do not", () => {
    const store = new Map<string, string>();
    const prevStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => { store.set(key, value); },
        },
    });
    try {
        expect(isOfficialBuiltinMarketSkill({ skillId: "novel-to-manju-agent" })).toBe(true);
        expect(isOfficialBuiltinMarketSkill({ skillId: "community-skill" }, [{ skillId: "community-skill", sourceType: "builtin" }])).toBe(true);
        expect(isOfficialBuiltinMarketSkill({ skillId: "community-skill" })).toBe(false);
        expect(hasAcceptedSkillMarketRisk()).toBe(false);
        acceptSkillMarketRisk();
        expect(store.get(SKILL_MARKET_RISK_ACCEPTED_KEY)).toBe("true");
        expect(hasAcceptedSkillMarketRisk()).toBe(true);
    } finally {
        Object.defineProperty(globalThis, "localStorage", { configurable: true, value: prevStorage });
    }
});

test("legacy publication requirements stay visible until the author explicitly removes them", () => {
    const original = ["text", "model.audio", "future"];
    expect(unsupportedRequirements(original)).toEqual(["text", "future"]);
    expect(original).toEqual(["text", "model.audio", "future"]);
    expect(unsupportedRequirements([])).toEqual([]);
    expect(unsupportedRequirements(["beeftv.canvas", "model.image", "model.video", "model.audio"])).toEqual([]);
});

test("ambiguous legacy publication IDs require explicit correction before upload", () => {
    const base = { skillId: "local-one", metadata: { name: "text", description: "text", versionLabel: "1.0.0", license: "MIT", sourceUrl: "", requirements: [], showcase: [] } };
    expect(needsPublicationTargetCorrection(base)).toBe(false);
    expect(needsPublicationTargetCorrection({ ...base, metadata: { ...base.metadata, skillId: "local-one" } })).toBe(true);
    expect(needsPublicationTargetCorrection({ ...base, metadata: { ...base.metadata, skillId: "real-cloud-one" } })).toBe(true);
    expect(needsPublicationTargetCorrection({ ...base, publicationTarget: "existing", marketSkillId: "real-cloud-one", metadata: { ...base.metadata, skillId: "real-cloud-one" } })).toBe(false);
    expect(needsPublicationTargetCorrection({ ...base, publicationTarget: "existing", marketSkillId: "local-one", metadata: { ...base.metadata, skillId: "local-one" } })).toBe(true);
    expect(needsPublicationTargetCorrection({ ...base, publicationTarget: "new", submissionId: "draft-one", metadata: { ...base.metadata, skillId: "assigned-cloud-one" } })).toBe(false);
});
