import { afterEach, expect, test } from "bun:test";
import { isBackendURL, setHubSession } from "../src/integrations/aihubkit/api";
import { hubModelProtocol, importHubModels } from "../src/integrations/aihubkit/catalog";
import { initializeWorkspaceState } from "../src/components/workspace/workspace-bootstrap-hydrator";
import { channelRequest } from "../src/services/api/custom-channel-relay";
import { createModelChannel, defaultConfig } from "../src/stores/use-config-store";
import type { ModelProtocolDefinition } from "../src/lib/model-protocols";

afterEach(() => setHubSession());

test("account headers are limited to the backend origin and API path", () => {
    const location = "https://workbench.example/project";
    expect(isBackendURL("https://workbench.example/api/tasks", "/api", location)).toBe(true);
    for (const target of ["https://workbench.example/api-evil/tasks", "https://other.example/api/tasks", "https://workbench.example:8443/api/tasks", "http://workbench.example/api/tasks"]) {
        expect(isBackendURL(target, "/api", location)).toBe(false);
    }
});

test("managed requests carry a credential reference through the local relay", () => {
    setHubSession("local-session");
    const request = channelRequest({ baseUrl: "https://apimodel.aihubkit.com", apiKey: "", apiFormat: "openai", credentialRef: "aihubkit:video" }, "https://apimodel.aihubkit.com/v1/videos");
    expect(request.url).toBe("/api/ai/custom");
    expect(request.headers.authorization).toBe("Bearer aihubkit:video");
    expect(request.headers["x-aihubkit-session"]).toBe("local-session");
});

test("failed account bootstrap cannot restore another namespace or model snapshot", async () => {
    const calls: string[] = [];
    await expect(initializeWorkspaceState({
        allowLocalFallback: false,
        loadWorkspace: async () => { throw new Error("session expired"); },
        createLocalWorkspace: () => { calls.push("fallback"); return {}; },
        applySession: async () => { calls.push("apply"); },
        restoreModelConfig: async () => { calls.push("restore"); },
    })).rejects.toThrow("session expired");
    expect(calls).toEqual([]);
});

test("catalog imports preserve custom channels, defaults and explicit protocols", () => {
    const custom = createModelChannel({ id: "custom", models: ["existing"] });
    const config = { ...defaultConfig, textModel: "custom::existing", channels: [custom] };
    const definitions = [{ value: "aihubkit-video", capability: "video", enabled: true }] as ModelProtocolDefinition[];
    const next = importHubModels(config, "video", [{ id: "opaque", supported_endpoint_types: ["openai-video"] }], {}, definitions);
    expect(next.channels[0]).toEqual(custom);
    expect(next.textModel).toBe("custom::existing");
    expect(next.channels[1]!.credentialRef).toBe("aihubkit:video");
    expect(next.channels[1]!.apiKey).toBe("");
    expect(hubModelProtocol({ id: "unknown-video" })).toBeUndefined();
    expect(() => importHubModels(config, "video", [{ id: "unknown" }], {}, definitions)).toThrow("选择已安装的协议");
});

test("the active workspace sidebar exposes the aihubkit account entry", async () => {
    const source = await Bun.file(new URL("../src/components/layout/workspace-sidebar-nav.tsx", import.meta.url)).text();
    expect(source).toContain('<HubAccountMenu variant="sidebar" collapsed={collapsed} />');
});

test("development startup waits for the embedded backend instead of trapping the page", async () => {
    const source = await Bun.file(new URL("../src/integrations/aihubkit/gate.tsx", import.meta.url)).text();
    expect(source).toContain("import.meta.env.DEV");
    expect(source).toContain("等待本地后端完成编译");
    expect(source).not.toContain("onRetry={() => window.location.reload()}");
});
