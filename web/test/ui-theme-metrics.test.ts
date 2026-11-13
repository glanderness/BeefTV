import { expect, test } from "bun:test";
import { getAntThemeConfig, getWorkspaceAntThemeConfig } from "../src/lib/app-theme";
import { cloneSkinDefinition, DEFAULT_CLASSIC_SKIN, getSkinAntOverrides, skinCSSVariables } from "../src/lib/skin-themes";

const custom = cloneSkinDefinition(DEFAULT_CLASSIC_SKIN);
custom.id = "metrics-test";
Object.assign(custom.tokens.components, { buttonRadius: 17, inputRadius: 9, cardRadius: 23, overlayRadius: 29, controlHeight: 41, controlHeightSmall: 27, controlHeightLarge: 53, buttonFontWeight: 640 });

for (const dark of [false, true]) {
    for (const skin of ["classic", custom]) {
        test(`current ${dark ? "dark" : "light"}/${typeof skin === "string" ? skin : skin.id} geometry remains exact`, () => {
            const config = getAntThemeConfig(dark, skin);
            const isClassic = typeof skin === "string";
            expect({ height: config.token?.controlHeight, small: config.token?.controlHeightSM, large: config.token?.controlHeightLG }).toEqual(isClassic ? { height: 36, small: 30, large: 42 } : { height: 41, small: 27, large: 53 });
            expect([config.token?.borderRadius, config.token?.borderRadiusSM, config.token?.borderRadiusLG]).toEqual(isClassic ? [6, 5, 8] : [17, 9, 23]);
            expect(config.components?.Button?.borderRadius).toBe(isClassic ? 6 : 17);
            expect(config.components?.Button?.fontWeight).toBe(isClassic ? 500 : 640);
            for (const component of ["Input", "InputNumber", "Select", "Segmented"] as const) expect(config.components?.[component]?.borderRadius).toBe(isClassic ? 5 : 9);
            expect(config.components?.Modal?.borderRadiusLG).toBe(isClassic ? 8 : 29);
            const workspace = getWorkspaceAntThemeConfig();
            expect([workspace.token?.controlHeight, workspace.token?.controlHeightSM, workspace.token?.controlHeightLG]).toEqual([38, 30, 44]);
            expect([workspace.token?.borderRadius, workspace.token?.borderRadiusSM, workspace.token?.borderRadiusLG]).toEqual([12, 8, 16]);
            expect([workspace.components?.Button?.borderRadius, workspace.components?.Button?.borderRadiusSM, workspace.components?.Button?.borderRadiusLG, workspace.components?.Button?.fontWeight]).toEqual([12, 8, 14, 550]);
            expect(workspace.components?.Input?.borderRadius).toBe(12);
            expect(workspace.components?.Select?.borderRadius).toBe(12);
            expect(workspace.components?.Modal?.borderRadiusLG).toBe(20);
        });
    }
}

test("zero skin geometry keeps the existing AntD fallback and raw CSS distinction", () => {
    const zero = cloneSkinDefinition(custom);
    Object.assign(zero.tokens.components, { buttonRadius: 0, inputRadius: 0, cardRadius: 0, overlayRadius: 0, controlHeight: 0, controlHeightSmall: 0, controlHeightLarge: 0, buttonFontWeight: 0 });
    const config = getAntThemeConfig(false, zero);
    expect([config.token?.controlHeight, config.token?.controlHeightSM, config.token?.controlHeightLG]).toEqual([36, 30, 42]);
    expect([config.components?.Button?.borderRadius, config.components?.Input?.borderRadius, config.components?.Modal?.borderRadiusLG, config.components?.Button?.fontWeight]).toEqual([6, 5, 8, 500]);
    expect(skinCSSVariables(zero, "light")["--button-radius"]).toBe("0px");
    expect(skinCSSVariables(zero, "light")["--input-radius"]).toBe("0px");
    expect(getSkinAntOverrides("classic", "light")).toEqual({});
});

test("shared control metrics resolve scope without mutating skin overrides", async () => {
    const { resolveUIControlMetrics } = await import("../src/lib/ui-theme");
    const overrides = Object.freeze(getSkinAntOverrides(custom, "light"));
    expect(resolveUIControlMetrics({ scope: "canvas", skin: overrides })).toEqual({ height: 41, heightSmall: 27, heightLarge: 53, buttonRadius: 17, inputRadius: 9, buttonFontWeight: 640 });
    expect(resolveUIControlMetrics({ scope: "workspace", skin: overrides })).toEqual({ height: 38, heightSmall: 30, heightLarge: 44, buttonRadius: 12, inputRadius: 12, buttonFontWeight: 550 });
    expect(resolveUIControlMetrics({ scope: "canvas", skin: { buttonRadius: 0, borderRadius: 11, inputRadius: 0, borderRadiusSM: 7, controlHeight: 0, buttonFontWeight: 0 } })).toEqual({
        height: 36,
        heightSmall: 30,
        heightLarge: 42,
        buttonRadius: 11,
        inputRadius: 7,
        buttonFontWeight: 500,
    });
});
