import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { checkOwnership, checkBudgets } = require("../../scripts/check-outer-ui-contract.cjs");

test("pages cannot override shared page, navigation or form styles", () => {
    for (const selector of [".settings-page .app-page-header", ".skills .app-workspace-nav-link", ".skills .workspace-controls-form .ant-input"]) {
        expect(checkOwnership("web/src/pages/skills/marketplace.css", `${selector} { padding: 1px !important; }`).length).toBeGreaterThan(0);
    }
    expect(checkOwnership("web/src/styles/workspace-page.css", ".app-page-header { padding: 1px; }")).toEqual([]);
});

test("composition exceptions allow only the recorded selector, value and property", () => {
    const selector = ".skill-market-page > .app-section-page-content > .app-page-header";
    expect(checkOwnership("web/src/pages/skills/marketplace.css", `${selector} { flex-shrink: 0; }`)).toEqual([]);
    for (const declaration of ["padding: 1px", "flex-shrink: 1", "flex-shrink: 0 !important"]) {
        expect(checkOwnership("web/src/pages/skills/marketplace.css", `${selector} { ${declaration}; }`).length).toBeGreaterThan(0);
    }
});

test("new important growth is rejected even in a previously clean file", () => {
    expect(checkBudgets({ files: [{ file: "web/src/styles/workspace-controls.css", important: 1 }], groups: [] }).length).toBeGreaterThan(0);
    expect(checkBudgets({ files: [{ file: "web/src/styles/workspace-navigation.css", important: 112 }], groups: [] }).length).toBeGreaterThan(0);
});

test("new same-context duplicate declarations fail while resolved debt is allowed", () => {
    const groups = [{ declarations: [{ file: "web/src/styles/workspace-controls.css" }, { file: "web/src/styles/workspace-controls.css" }] }];
    expect(checkBudgets({ files: [], groups }).length).toBeGreaterThan(0);
    expect(checkBudgets({ files: [{ file: "web/src/styles/workspace-navigation.css", important: 100 }], groups: [] })).toEqual([]);
});

test("the real outer UI tree passes ownership and frozen legacy budgets", () => {
    const result = execFileSync(process.execPath, ["../scripts/check-outer-ui-contract.cjs"], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
    expect(result).toContain("Outer UI contract passed");
});
