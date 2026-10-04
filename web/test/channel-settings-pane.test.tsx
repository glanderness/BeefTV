import { expect, test } from "bun:test";
import { mergeManagedBeefAPICatalog, modelConfigChannelPresentation, modelConfigChannelStatusLabel, shouldRefreshBeefAPICatalog } from "../src/pages/settings/channel-settings-pane";
import { createModelChannel, defaultConfig } from "../src/stores/use-config-store";

test("pinned BeefAPI is visible and cannot be deleted before models are fetched", () => {
    const channel = createModelChannel({
        id: "beefapi",
        name: "BeefAPI",
        baseUrl: "https://enterprise.beefapi.com",
        apiKey: "",
        models: [],
        pinned: true,
        presetVersion: 1,
    });
    expect(modelConfigChannelPresentation(channel)).toEqual({ builtin: true, deletable: false, adapterLabel: "应用内置适配" });
    expect(modelConfigChannelStatusLabel(channel, { status: "idle", revision: 0, dirty: false, error: "" })).toBe("未连接");
});

test("BeefAPI status copy reflects enterprise connection state", () => {
    const channel = createModelChannel({ id: "beefapi", apiKey: "", pinned: true, presetVersion: 1 });
    expect(modelConfigChannelStatusLabel(channel, { status: "idle", revision: 1, dirty: false, error: "" }, { state: "pending", userCode: "ABCD-EFGH", hasCredential: false })).toBe("请在浏览器中确认 ABCD-EFGH");
    expect(modelConfigChannelStatusLabel(channel, { status: "idle", revision: 2, dirty: false, error: "" }, { state: "connected", account: { id: "acct-1", display_name: "Ender" }, hasCredential: true })).toBe("已连接 Ender");
    expect(modelConfigChannelStatusLabel(channel, { status: "idle", revision: 2, dirty: false, error: "" }, { state: "revoked", hasCredential: true })).toBe("连接已失效，请重新连接");
});

test("BeefAPI connected transition refreshes the managed catalog", () => {
    expect(shouldRefreshBeefAPICatalog("pending", "connected")).toBe(true);
    expect(shouldRefreshBeefAPICatalog(undefined, "connected")).toBe(true);
    expect(shouldRefreshBeefAPICatalog("connected", "connected")).toBe(false);
    expect(shouldRefreshBeefAPICatalog("connected", "disconnected")).toBe(true);
    expect(shouldRefreshBeefAPICatalog("catalog_failed", "disconnected")).toBe(true);
    expect(shouldRefreshBeefAPICatalog("pending", "pending")).toBe(false);
    expect(shouldRefreshBeefAPICatalog(undefined, "disconnected")).toBe(false);
});

test("BeefAPI catalog merge keeps manual providers and user-owned BeefAPI fields", () => {
    const current = {
        ...defaultConfig,
        imageModel: "manual::local-image",
        channels: [
            createModelChannel({
                id: "beefapi",
                name: "BeefAPI",
                pinned: true,
                enabled: false,
                models: ["stale-image"],
                modelProfiles: [{ model: "stale-image", capability: "image" }],
            }),
            createModelChannel({ id: "manual", name: "工作室渠道", apiKey: "manual-key", models: ["local-image"], modelProfiles: [{ model: "local-image", capability: "image" }] }),
        ],
    };
    const server = {
        ...defaultConfig,
        channels: [
            createModelChannel({
                id: "beefapi",
                name: "BeefAPI",
                pinned: true,
                credentialRef: "beefapi-enterprise",
                hasApiKey: true,
                models: ["enterprise-image"],
                modelProfiles: [{ model: "enterprise-image", capability: "image", protocol: "openai-image" }],
            }),
            createModelChannel({ id: "manual", name: "旧名称", apiKey: "old-key", models: ["old-image"] }),
        ],
    };
    const merged = mergeManagedBeefAPICatalog(current, server);
    const beef = merged.channels.find((channel) => channel.id === "beefapi");
    const manual = merged.channels.find((channel) => channel.id === "manual");
    expect(beef?.models).toEqual(["enterprise-image"]);
    expect(beef?.modelProfiles?.[0]?.protocol).toBe("openai-image");
    expect(beef?.credentialRef).toBe("beefapi-enterprise");
    expect(beef?.enabled).toBe(false);
    expect(beef?.apiKey).toBe("");
    expect(manual?.name).toBe("工作室渠道");
    expect(manual?.apiKey).toBe("manual-key");
    expect(manual?.models).toEqual(["local-image"]);
    expect(merged.imageModel).toBe("manual::local-image");
});
