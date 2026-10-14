import { expect, test } from "bun:test";
import { isConfigSection, resolveSettingsSection } from "@/pages/settings";

test("direct RunningHub URLs survive opening and reloading web and desktop settings", () => {
    const section = new URL("https://workspace.example/settings?section=runninghub").searchParams.get("section");
    expect(isConfigSection(section)).toBe(true);
    expect(resolveSettingsSection(section, false, true)).toBe("runninghub");
    expect(resolveSettingsSection(section, true, true)).toBe("runninghub");
});

test("settings routes respect capability changes without hiding ordinary model configuration", () => {
    expect(resolveSettingsSection("runninghub", true, false)).toBe("channels");
    expect(resolveSettingsSection("storage", false, true)).toBe("channels");
    expect(resolveSettingsSection("storage", true, false)).toBe("storage");
    expect(resolveSettingsSection("diagnostics", false, false)).toBe("diagnostics");
    for (const section of [null, "unknown", "models", "channels"]) {
        expect(resolveSettingsSection(section, false, true)).toBe("channels");
    }
});
