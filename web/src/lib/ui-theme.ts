import type { SkinAntOverrides } from "@/lib/skin-themes";
import { workspaceControlMetrics } from "@/lib/workspace-control-metrics";

type UIThemeContext = {
    scope: "workspace" | "canvas";
    skin: Partial<SkinAntOverrides>;
};

type UIControlMetrics = {
    height: number;
    heightSmall: number;
    heightLarge: number;
    buttonRadius: number;
    inputRadius: number;
    buttonFontWeight: number;
};

/** Resolves the existing AntD control geometry; raw skin CSS retains its own zero values. */
export function resolveUIControlMetrics({ scope, skin }: UIThemeContext): UIControlMetrics {
    if (scope === "workspace") {
        return {
            height: workspaceControlMetrics.height.normal,
            heightSmall: workspaceControlMetrics.height.small,
            heightLarge: workspaceControlMetrics.height.large,
            buttonRadius: workspaceControlMetrics.radius.normal,
            inputRadius: workspaceControlMetrics.radius.normal,
            buttonFontWeight: workspaceControlMetrics.buttonWeight,
        };
    }

    // Preserve the current falsy fallback, including custom skins with radius/height 0.
    return {
        height: skin.controlHeight || 36,
        heightSmall: skin.controlHeightSmall || 30,
        heightLarge: skin.controlHeightLarge || 42,
        buttonRadius: skin.buttonRadius || skin.borderRadius || 6,
        inputRadius: skin.inputRadius || skin.borderRadiusSM || 5,
        buttonFontWeight: skin.buttonFontWeight || 500,
    };
}
