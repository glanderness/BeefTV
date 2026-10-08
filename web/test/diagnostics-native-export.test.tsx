import { afterEach, expect, test } from "bun:test";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import SettingsPage from "@/pages/settings";
import { downloadDiagnosticBundle } from "@/services/diagnostics/diagnostics-api";

const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; });

test("the existing task diagnostic URL opens the diagnostic pane", () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={["/settings?section=diagnostics&taskId=task-1&projectId=canvas-1"]}><App><SettingsPage /></App></MemoryRouter>);
    expect(html).toContain("导出诊断包");
    expect(html).toContain("返回模型配置");
    expect(html).not.toContain("默认生图模型");
});

test("native diagnostic ZIP bytes reach the chosen-file binding and cancellation is preserved", async () => {
    const calls: Array<[string, string]> = [];
    Object.assign(globalThis, { window: { location: { protocol: "wails:" }, go: { main: { DesktopApp: { SaveOwnedArtifact: async (name: string, bytes: string) => { calls.push([name, bytes]); return false; } } } } } });
    const data = new Uint8Array([80, 75, 3, 4, 0, 255]);
    const result = await downloadDiagnosticBundle({ blob: new Blob([data], { type: "application/zip" }), fileName: "beeftv-diagnostics.zip", bundleId: "DIAG_TEST" });
    expect(result).toBe("cancelled");
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe("beeftv-diagnostics.zip");
    expect(new Uint8Array(Buffer.from(calls[0][1], "base64"))).toEqual(data);
});
