import { afterEach, describe, expect, test } from "bun:test";
import { createBeefTVPluginHost } from "../src/lib/plugins/plugin-host-runtime";
import { PLUGIN_API_VERSION } from "../src/lib/plugins/plugin-types";
import { apiClient } from "../src/services/api/request";
import { commitModelConfig, createModelConfigRepository, hydrateModelConfig } from "../src/services/model-config-repository";
import { createModelChannel, defaultConfig, useConfigStore, type AiConfig } from "../src/stores/use-config-store";

const originalApiRequest = apiClient.request;

function createServerConfigFixture(): AiConfig {
    return {
        ...defaultConfig,
        channels: [
            createModelChannel({
                id: "beeftv",
                name: "BeefTV 官方算力",
                baseUrl: "https://beeftv.app",
                scope: "user",
                pinned: true,
                credentialRef: "beeftv",
                legacyIds: ["beefapi"],
                models: ["gpt-image-2"],
            }),
            createModelChannel({
                id: "stale-hosted-system",
                name: "历史托管系统渠道",
                baseUrl: "https://hosted-system.example",
                scope: "system",
                models: ["hosted-chat"],
            }),
            createModelChannel({
                id: "user-private-gateway",
                name: "个人私网中转",
                baseUrl: "https://private.internal.example/v1",
                apiKey: "sk-user-private-secret",
                secretKey: "sec-user-private",
                headers: [{ name: "X-Internal-Auth", value: "top-secret" }],
                models: ["gpt-4.1-mini"],
            }),
        ],
    };
}

function installMockBackend(
    initialConfig: AiConfig,
    options?: {
        holdInitialRead?: () => Promise<void>;
        holdFirstWrite?: () => Promise<void>;
        failReads?: boolean;
    },
) {
    let persistedRevision = 1;
    let persistedConfig = structuredClone(initialConfig);
    let firstRead = true;
    let firstWrite = true;
    let writeCount = 0;

    apiClient.request = (async (request) => {
        const method = String(request.method || "GET").toUpperCase();
        if (request.url === "/workspace/model-config" && method === "GET") {
            if (options?.failReads) {
                throw new Error("本地模型配置读取失败（磁盘不可用）");
            }
            if (firstRead && options?.holdInitialRead) {
                firstRead = false;
                await options.holdInitialRead();
            }
            return {
                status: 200,
                data: {
                    code: 0,
                    data: {
                        schemaVersion: 1,
                        revision: persistedRevision,
                        health: "ready",
                        config: structuredClone(persistedConfig),
                    },
                    msg: "",
                },
            };
        }
        if (request.url === "/workspace/model-config" && method === "PUT") {
            writeCount += 1;
            if (firstWrite && options?.holdFirstWrite) {
                firstWrite = false;
                await options.holdFirstWrite();
            }
            const payload = typeof request.data === "string" ? JSON.parse(request.data) : request.data;
            persistedRevision += 1;
            persistedConfig = structuredClone(payload.config);
            return {
                status: 200,
                data: {
                    code: 0,
                    data: { saved: true, revision: persistedRevision },
                    msg: "",
                },
            };
        }
        if (request.url === "/ai/models" && method === "POST") {
            return {
                status: 200,
                data: {
                    code: 0,
                    data: { models: [{ id: "acme-video-pro" }, "acme-chat-v1"] },
                    msg: "",
                },
            };
        }
        throw new Error(`Unexpected request: ${method} ${String(request.url)}`);
    }) as typeof apiClient.request;

    return {
        getPersistedConfig: () => persistedConfig,
        getPersistedRevision: () => persistedRevision,
        getWriteCount: () => writeCount,
    };
}

describe("plugin host channels capability", () => {
    afterEach(() => {
        apiClient.request = originalApiRequest;
    });

    test("fails closed on both initial and post-success refresh hydration failures, and waits for in-flight hydration without dropping channels", async () => {
        // 1) Initial hydration read fails while browser store has cached channels: 0 writes
        const failingMock = installMockBackend(createServerConfigFixture(), { failReads: true });
        useConfigStore.getState().replaceConfig({
            ...defaultConfig,
            channels: [createModelChannel({ id: "browser-cached", baseUrl: "https://cached.example", apiKey: "", models: ["m"] })],
        });
        await expect(hydrateModelConfig()).rejects.toThrow("本地模型配置读取失败");

        const pluginAlpha = createBeefTVPluginHost("beeftv-plugin-alpha", {
            apiVersion: PLUGIN_API_VERSION,
            id: "beeftv-plugin-alpha",
            name: "Alpha",
            version: "1.0.0",
            description: "Alpha channel",
            trusted: false,
            permissions: ["settings.write"],
            contributes: {},
        });
        await expect(
            pluginAlpha.channels!.upsert({
                id: "alpha",
                name: "Alpha 渠道",
                baseUrl: "https://api.alpha.example",
                apiKey: "sk-alpha",
                models: ["alpha-1"],
            }),
        ).rejects.toThrow("本地模型配置读取失败");
        expect(failingMock.getWriteCount()).toBe(0);

        // 2) Retry hydration in-flight + concurrent upserts: waits for canonical config and strips scope=system from local store
        let releaseRead: (() => void) | null = null;
        const recoveryMock = installMockBackend(createServerConfigFixture(), {
            holdInitialRead: () => new Promise<void>((resolve) => { releaseRead = resolve; }),
        });
        const pluginBeta = createBeefTVPluginHost("beeftv-plugin-beta", {
            apiVersion: PLUGIN_API_VERSION,
            id: "beeftv-plugin-beta",
            name: "Beta",
            version: "1.0.0",
            description: "Beta channel",
            trusted: false,
            permissions: ["settings.write"],
            contributes: {},
        });

        const hydration = hydrateModelConfig();
        const concurrentWrites = Promise.all([
            pluginAlpha.channels!.upsert({
                id: "alpha",
                name: "Alpha 渠道",
                baseUrl: "https://api.alpha.example",
                apiKey: "sk-alpha",
                models: ["alpha-1"],
            }),
            pluginBeta.channels!.upsert({
                id: "beta-channel",
                name: "Beta 渠道",
                baseUrl: "https://api.beta.example",
                apiKey: "sk-beta",
                models: ["beta-1"],
            }),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseRead?.();
        await hydration;
        await concurrentWrites;

        expect(recoveryMock.getPersistedConfig().channels.find((c) => c.id === "user-private-gateway")?.apiKey).toBe("sk-user-private-secret");
        expect(useConfigStore.getState().config.channels.map((item) => item.id)).toEqual([
            "beeftv",
            "user-private-gateway",
            "alpha",
            "beta-channel",
        ]);

        // 3) Post-success refresh hydration failure invalidates canonicalReady -> subsequent upsert must also fail closed with 0 writes
        const refreshFailMock = installMockBackend(createServerConfigFixture(), { failReads: true });
        await expect(hydrateModelConfig()).rejects.toThrow("本地模型配置读取失败");
        await expect(
            pluginAlpha.channels!.upsert({
                id: "alpha",
                name: "Alpha 渠道",
                baseUrl: "https://api.alpha.example",
                apiKey: "sk-alpha-2",
                models: ["alpha-1"],
            }),
        ).rejects.toThrow("本地模型配置读取失败");
        expect(refreshFailMock.getWriteCount()).toBe(0);
    });

    test("commitModelConfig arriving while plugin upsert write is held in-flight preserves both UI edits and plugin channel (including on 409 conflict)", async () => {
        let releaseFirstWrite: (() => void) | null = null;
        const baseFixture = createServerConfigFixture();
        const mock = installMockBackend(baseFixture, {
            holdFirstWrite: () => new Promise<void>((resolve) => { releaseFirstWrite = resolve; }),
        });
        await hydrateModelConfig();

        const pluginGamma = createBeefTVPluginHost("beeftv-plugin-gamma", {
            apiVersion: PLUGIN_API_VERSION,
            id: "beeftv-plugin-gamma",
            name: "Gamma",
            version: "1.0.0",
            description: "Gamma channel",
            trusted: false,
            permissions: ["settings.write"],
            contributes: {},
        });

        // Start plugin upsert; its network PUT is held in-flight
        const upsertPromise = pluginGamma.channels!.upsert({
            id: "gamma",
            name: "Gamma 渠道",
            baseUrl: "https://api.gamma.example",
            apiKey: "sk-gamma",
            models: ["gamma-1"],
        });
        await new Promise((resolve) => setTimeout(resolve, 15));

        // While PUT #1 is still in-flight, Settings UI commits a full snapshot built from pre-upsert baseFixture
        const uiSnapshot: AiConfig = {
            ...baseFixture,
            channels: [
                ...baseFixture.channels,
                createModelChannel({
                    id: "ui-concurrent-manual",
                    name: "并发手建渠道",
                    baseUrl: "https://ui-concurrent.example",
                    apiKey: "sk-ui-concurrent",
                    models: ["ui-m1"],
                }),
            ],
        };
        const uiCommitPromise = commitModelConfig(uiSnapshot);

        releaseFirstWrite?.();
        await Promise.all([upsertPromise, uiCommitPromise]);

        // Both persisted backend config AND local store must contain BOTH ui-concurrent-manual AND gamma
        const persistedIds = mock.getPersistedConfig().channels.map((c) => c.id);
        expect(persistedIds).toContain("ui-concurrent-manual");
        expect(persistedIds).toContain("gamma");
        const storeIds = useConfigStore.getState().config.channels.map((c) => c.id);
        expect(storeIds).toContain("ui-concurrent-manual");
        expect(storeIds).toContain("gamma");

        // Also verify superseded + 409 conflict on isolated repository: commit arrives during held write AND held write rejects with 409
        let serverRev = 3;
        let serverSnapshot: AiConfig = {
            ...defaultConfig,
            channels: [createModelChannel({ id: "seed", apiKey: "k-seed", models: ["m-seed"] })],
        };
        let releaseConflictWrite: (() => void) | null = null;
        let firstAttempt = true;
        const repo = createModelConfigRepository({
            read: async () => ({ config: structuredClone(serverSnapshot), revision: serverRev, health: "ready", source: "builtin+local" }),
            write: async (cfg, expected) => {
                if (firstAttempt) {
                    firstAttempt = false;
                    await new Promise<void>((resolve) => { releaseConflictWrite = resolve; });
                    serverRev = 9;
                    throw Object.assign(new Error("conflict"), { status: 409 });
                }
                expect(expected).toBe(9);
                serverSnapshot = structuredClone(cfg);
                return { saved: true, revision: ++serverRev };
            },
        });
        await repo.hydrate();

        const mutPromise = repo.mutate((base) => ({
            config: {
                ...base,
                channels: [...base.channels, createModelChannel({ id: "mut-channel", apiKey: "k-mut", models: ["m-mut"] })],
            },
            result: "merged",
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Concurrent full-snapshot commit arrives while mutPromise's first write is suspended before throwing 409
        const concurrentCommit = repo.commit({
            ...defaultConfig,
            channels: [
                createModelChannel({ id: "seed", apiKey: "k-seed", models: ["m-seed"] }),
                createModelChannel({ id: "ui-during-409", apiKey: "k-ui", models: ["m-ui"] }),
            ],
        });
        releaseConflictWrite?.();

        const mutOutcome = await mutPromise;
        await concurrentCommit;
        expect(mutOutcome.config.channels.map((c) => c.id)).toEqual(["seed", "ui-during-409", "mut-channel"]);
        expect(serverSnapshot.channels.map((c) => c.id)).toEqual(["seed", "ui-during-409", "mut-channel"]);
    });

    test("external plugin supports all 4 owned ID forms, survives re-hydration with ownerPluginId/sortOrder/modelAliases, and clears secrets/headers across origins", async () => {
        const mock = installMockBackend(createServerConfigFixture());
        await hydrateModelConfig();

        const externalHost = createBeefTVPluginHost("beeftv-plugin-acme-relay", {
            apiVersion: PLUGIN_API_VERSION,
            id: "beeftv-plugin-acme-relay",
            name: "Acme 一键配置",
            version: "1.0.0",
            description: "Third-party channel plugin",
            trusted: false,
            permissions: ["settings.write"],
            contributes: {},
        });

        expect(externalHost.channels?.list()).toEqual([]);

        const catalog = await externalHost.channels?.fetchCatalog?.({
            baseUrl: "https://api.acme-relay.example#",
            apiKey: "sk-acme-live",
        });
        expect(catalog).toEqual({ models: ["acme-video-pro", "acme-chat-v1"] });

        const saved = await externalHost.channels?.upsert({
            id: "acme-relay",
            name: "Acme 算力渠道",
            baseUrl: "https://api.acme-relay.example#",
            referenceAssetOrigin: "https://assets.acme-relay.example",
            apiKey: "sk-acme-live",
            secretKey: "sec-acme-live",
            headers: [{ name: "X-Acme-Project", value: "proj-1" }],
            concurrencyLimit: 4,
            models: ["acme-video-pro", "acme-chat-v1"],
        });
        expect(saved).toMatchObject({
            id: "acme-relay",
            apiKey: "",
            secretKey: "",
            headers: undefined,
            hasApiKey: true,
            hasSecretKey: true,
            ownerPluginId: "beeftv-plugin-acme-relay",
        });

        for (const extraId of ["acme-relay-channel", "beeftv-plugin-acme-relay", "beeftv-plugin-acme-relay:backup"]) {
            await externalHost.channels?.upsert({
                id: extraId,
                name: extraId,
                baseUrl: "https://api.acme-relay.example",
                apiKey: "sk-sub",
                models: ["acme-chat-v1"],
            });
        }

        const enrichedPersisted: AiConfig = {
            ...mock.getPersistedConfig(),
            channels: mock.getPersistedConfig().channels.map((ch) =>
                ch.id === "acme-relay"
                    ? {
                          ...ch,
                          sortOrder: 7,
                          modelAliases: { "acme-old-sku": "acme-video-pro" },
                          legacyIds: ["acme-old"],
                          publicAlias: "Acme Alias",
                          presetVersion: 2,
                      }
                    : ch,
            ),
        };
        installMockBackend(enrichedPersisted);
        await hydrateModelConfig();

        const listed = externalHost.channels?.list() ?? [];
        expect(listed.map((item) => item.id)).toEqual([
            "acme-relay",
            "acme-relay-channel",
            "beeftv-plugin-acme-relay",
            "beeftv-plugin-acme-relay:backup",
        ]);
        expect(listed[0]).toMatchObject({
            id: "acme-relay",
            apiKey: "",
            secretKey: "",
            headers: undefined,
            hasApiKey: true,
            hasSecretKey: true,
        });

        await externalHost.channels?.upsert({
            id: "acme-relay",
            name: "Acme 算力渠道",
            baseUrl: "https://api.acme-relay.example/v1",
            models: ["acme-video-pro"],
        });
        const preserved = useConfigStore.getState().config.channels.find((c) => c.id === "acme-relay");
        expect(preserved).toMatchObject({
            ownerPluginId: "beeftv-plugin-acme-relay",
            sortOrder: 7,
            modelAliases: { "acme-old-sku": "acme-video-pro" },
            apiKey: "sk-acme-live",
            secretKey: "sec-acme-live",
            headers: [{ name: "X-Acme-Project", value: "proj-1" }],
            referenceAssetOrigin: "https://assets.acme-relay.example",
            legacyIds: ["acme-old"],
            publicAlias: "Acme Alias",
            presetVersion: 2,
            concurrencyLimit: 4,
        });

        await externalHost.channels?.upsert({
            id: "acme-relay",
            name: "Acme 算力渠道",
            baseUrl: "https://other-host.example/v1",
            models: ["acme-video-pro"],
        });
        const switched = useConfigStore.getState().config.channels.find((c) => c.id === "acme-relay");
        expect(switched?.apiKey).toBe("");
        expect(switched?.hasApiKey).toBe(false);
        expect(switched?.secretKey).toBe("");
        expect(switched?.hasSecretKey).toBe(false);
        expect(switched?.headers).toEqual([]);
    });

    test("ownerless same-ID same-origin channel is adopted only when user submits non-empty API key, while cross-origin manual channels stay protected", async () => {
        const fixture = createServerConfigFixture();
        fixture.channels.push(
            createModelChannel({
                id: "legacy-vendor",
                name: "存量同源同名渠道",
                baseUrl: "https://api.legacy-vendor.example/v1",
                apiKey: "sk-v225-key",
                sortOrder: 3,
                models: ["legacy-m1"],
            }),
            createModelChannel({
                id: "manual-collide",
                name: "用户手建异源渠道",
                baseUrl: "https://manual.user.example",
                apiKey: "sk-manual-owner",
                models: ["manual-model"],
            }),
        );
        const mock = installMockBackend(fixture);
        await hydrateModelConfig();

        const upgradedVendorPlugin = createBeefTVPluginHost("beeftv-plugin-legacy-vendor", {
            apiVersion: PLUGIN_API_VERSION,
            id: "beeftv-plugin-legacy-vendor",
            name: "Legacy Vendor v2.3",
            version: "2.0.0",
            description: "Upgraded vendor plugin",
            trusted: false,
            permissions: ["settings.write"],
            contributes: {},
        });

        expect(upgradedVendorPlugin.channels?.list()).toEqual([]);

        await expect(
            upgradedVendorPlugin.channels?.upsert({
                id: "legacy-vendor",
                baseUrl: "https://api.legacy-vendor.example/v1",
                models: ["probe"],
            }),
        ).rejects.toThrow("不允许覆盖非本插件创建的已有模型渠道");

        await expect(
            upgradedVendorPlugin.channels?.upsert({
                id: "legacy-vendor",
                baseUrl: "https://evil.example/v1",
                apiKey: "sk-evil",
                models: ["probe"],
            }),
        ).rejects.toThrow("不允许覆盖非本插件创建的已有模型渠道");

        await upgradedVendorPlugin.channels?.upsert({
            id: "legacy-vendor",
            name: "Legacy Vendor 升级版",
            baseUrl: "https://api.legacy-vendor.example/v1",
            apiKey: "sk-v230-key",
            models: ["legacy-m1", "legacy-m2"],
        });
        expect(mock.getPersistedConfig().channels.find((c) => c.id === "legacy-vendor")).toMatchObject({
            ownerPluginId: "beeftv-plugin-legacy-vendor",
            apiKey: "sk-v230-key",
            sortOrder: 3,
            models: ["legacy-m1", "legacy-m2"],
        });
        expect(upgradedVendorPlugin.channels?.list()).toHaveLength(1);

        const collidingPlugin = createBeefTVPluginHost("beeftv-plugin-manual-collide", {
            apiVersion: PLUGIN_API_VERSION,
            id: "beeftv-plugin-manual-collide",
            name: "Colliding Plugin",
            version: "1.0.0",
            description: "Collides with user channel ID",
            trusted: false,
            permissions: ["settings.write"],
            contributes: {},
        });
        await expect(
            collidingPlugin.channels?.upsert({
                id: "manual-collide",
                baseUrl: "https://plugin.other.example",
                apiKey: "sk-try",
                models: ["hijacked"],
            }),
        ).rejects.toThrow("不允许覆盖非本插件创建的已有模型渠道");
        expect(mock.getPersistedConfig().channels.find((c) => c.id === "manual-collide")?.apiKey).toBe("sk-manual-owner");
    });

    test("blocks official legacyIds, reserved presets, trusted preset fallback, permission gates, and scoped packages", async () => {
        const fixture = createServerConfigFixture();
        fixture.channels.push(
            createModelChannel({
                id: "channel-random-ll2",
                name: "用户已建 LL2",
                baseUrl: "https://api.ll2.cn",
                apiKey: "sk-old-ll2",
                models: ["deepseek-v4.1-flash"],
            }),
        );
        const mock = installMockBackend(fixture);
        await hydrateModelConfig();

        const sneakyLegacyOfficial = createBeefTVPluginHost("beeftv-plugin-beefapi", {
            apiVersion: PLUGIN_API_VERSION,
            id: "beeftv-plugin-beefapi",
            name: "Sneaky Legacy Official",
            version: "1.0.0",
            description: "Attempts official legacyIds hijack",
            trusted: false,
            permissions: ["settings.write"],
            contributes: {},
        });
        await expect(
            sneakyLegacyOfficial.channels?.upsert({ id: "beefapi", baseUrl: "https://attacker.example", apiKey: "sk-x" }),
        ).rejects.toThrow("仅允许写入自身命名空间下的模型渠道");

        const sneakyCompatible = createBeefTVPluginHost("beeftv-plugin-compatible", {
            apiVersion: PLUGIN_API_VERSION,
            id: "beeftv-plugin-compatible",
            name: "Sneaky Compatible",
            version: "1.0.0",
            description: "Attempts preset collision",
            trusted: false,
            permissions: ["settings.write"],
            contributes: {},
        });
        await expect(
            sneakyCompatible.channels?.upsert({ id: "compatible", baseUrl: "https://attacker.example" }),
        ).rejects.toThrow("仅允许写入自身命名空间下的模型渠道");

        const scopedHost = createBeefTVPluginHost("@vendor/beeftv-plugin", {
            apiVersion: PLUGIN_API_VERSION,
            id: "@vendor/beeftv-plugin",
            name: "Vendor Plugin",
            version: "1.0.0",
            description: "Scoped plugin",
            trusted: false,
            permissions: ["settings.write"],
            contributes: {},
        });
        await scopedHost.channels?.upsert({
            id: "@vendor/beeftv-plugin",
            name: "Vendor 渠道",
            baseUrl: "https://api.vendor.example",
            apiKey: "sk-vendor",
            models: ["vendor-model"],
        });
        expect(scopedHost.channels?.list()).toHaveLength(1);

        const trustedLL2 = createBeefTVPluginHost("beeftv-plugin-ll2", {
            apiVersion: PLUGIN_API_VERSION,
            id: "beeftv-plugin-ll2",
            name: "LL2",
            version: "1.0.2",
            description: "Built-in LL2",
            trusted: true,
            permissions: ["settings.write"],
            contributes: {},
        });
        const updated = await trustedLL2.channels?.upsert({
            id: "ll2",
            name: "LL2 (DMC)",
            baseUrl: "https://api.ll2.cn",
            apiKey: "sk-new-ll2",
            models: ["MiniMax-H3"],
        });
        expect(updated?.id).toBe("channel-random-ll2");
        expect(mock.getPersistedConfig().channels.find((c) => c.id === "channel-random-ll2")?.apiKey).toBe("sk-new-ll2");

        const noPermHost = createBeefTVPluginHost("beeftv-plugin-readonly", {
            apiVersion: PLUGIN_API_VERSION,
            id: "beeftv-plugin-readonly",
            name: "Readonly",
            version: "1.0.0",
            description: "No settings.write",
            trusted: true,
            permissions: ["canvas.read"],
            contributes: {},
        });
        expect(() => noPermHost.channels?.list()).toThrow("缺少 settings.write 权限");
    });

    test("settles every mutation promise across same-tick sync failure, non-409 write failure with queued mutations, and in-flight refresh success/failure", async () => {
        let rev = 1;
        let server: AiConfig = {
            ...defaultConfig,
            channels: [createModelChannel({ id: "base", apiKey: "k-base", models: ["m-base"] })],
        };
        let holdWrite: (() => Promise<void>) | null = null;
        let failWriteMessage = "";
        let holdRead: (() => Promise<void>) | null = null;
        let failReadMessage = "";

        const repo = createModelConfigRepository({
            read: async () => {
                if (holdRead) {
                    const wait = holdRead;
                    holdRead = null;
                    await wait();
                }
                if (failReadMessage) {
                    throw new Error(failReadMessage);
                }
                return { config: structuredClone(server), revision: rev, health: "ready", source: "builtin+local" };
            },
            write: async (cfg, expected) => {
                if (holdWrite) {
                    const wait = holdWrite;
                    holdWrite = null;
                    await wait();
                }
                if (failWriteMessage) {
                    throw new Error(failWriteMessage);
                }
                expect(expected).toBe(rev);
                server = structuredClone(cfg);
                return { saved: true, revision: ++rev };
            },
        });
        await repo.hydrate();

        const captureError = (promise: Promise<unknown>) =>
            promise.then(
                () => "",
                (err: unknown) => (err instanceof Error ? err.message : String(err)),
            );

        // 1) Failing mutator + same-tick valid mutator: valid mutator must not stall behind stale drainPromise
        const badSameTick = captureError(
            repo.mutate(() => {
                throw new Error("invalid mutation");
            }),
        );
        const goodSameTick = repo.mutate((base) => ({
            config: {
                ...base,
                channels: [...base.channels, createModelChannel({ id: "after-sync-throw", apiKey: "k1", models: ["m1"] })],
            },
            result: "persisted",
        }));
        const [badErr, goodOutcome] = await Promise.all([badSameTick, goodSameTick]);
        expect(badErr).toContain("invalid mutation");
        expect(goodOutcome.result).toBe("persisted");
        expect(server.channels.map((c) => c.id)).toEqual(["base", "after-sync-throw"]);
        expect(repo.getState().dirty).toBe(false);

        // 2) Held write failing with non-409 error while a second mutation is enqueued: both reject cleanly without hanging
        let releaseFailedWrite!: () => void;
        holdWrite = () => new Promise<void>((resolve) => { releaseFailedWrite = resolve; });
        failWriteMessage = "磁盘空间不足";

        const firstFail = captureError(
            repo.mutate((base) => ({
                config: { ...base, channels: [...base.channels, createModelChannel({ id: "fail-1", apiKey: "k", models: ["m"] })] },
                result: 1,
            })),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        const queuedDuringFail = captureError(
            repo.mutate((base) => ({
                config: { ...base, channels: [...base.channels, createModelChannel({ id: "fail-2", apiKey: "k", models: ["m"] })] },
                result: 2,
            })),
        );
        releaseFailedWrite();
        const [err1, err2] = await Promise.all([firstFail, queuedDuringFail]);
        expect(err1).toContain("磁盘空间不足");
        expect(err2).toContain("磁盘空间不足");
        failWriteMessage = "";

        // 3) Refresh hydrate succeeding while a mutation was queued during inFlightHydration: merges onto fresh server config
        server = {
            ...server,
            channels: [...server.channels, createModelChannel({ id: "server-fresh-during-refresh", apiKey: "k-srv", models: ["m-srv"] })],
        };
        let releaseRefreshRead!: () => void;
        holdRead = () => new Promise<void>((resolve) => { releaseRefreshRead = resolve; });
        const refreshing = repo.hydrate();
        const queuedDuringRefresh = repo.mutate((base) => ({
            config: { ...base, channels: [...base.channels, createModelChannel({ id: "queued-on-refresh", apiKey: "k-q", models: ["m-q"] })] },
            result: "merged-fresh",
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseRefreshRead();
        await refreshing;
        expect((await queuedDuringRefresh).result).toBe("merged-fresh");
        expect(server.channels.map((c) => c.id)).toEqual([
            "base",
            "after-sync-throw",
            "server-fresh-during-refresh",
            "queued-on-refresh",
        ]);

        // 4) Refresh hydrate failing while a mutation was already queued during inFlightHydration: rejects queued mutation with 0 writes
        let releaseFailRefresh!: () => void;
        holdRead = () => new Promise<void>((resolve) => { releaseFailRefresh = resolve; });
        failReadMessage = "刷新读取超时";
        const revBeforeFailRefresh = rev;
        const failingRefresh = captureError(repo.hydrate());
        const queuedBeforeRefreshFail = captureError(
            repo.mutate((base) => ({
                config: { ...base, channels: [...base.channels, createModelChannel({ id: "never-written", apiKey: "k", models: ["m"] })] },
                result: "unreachable",
            })),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseFailRefresh();
        const [refreshErr, queuedErr] = await Promise.all([failingRefresh, queuedBeforeRefreshFail]);
        expect(refreshErr).toContain("刷新读取超时");
        expect(queuedErr).toContain("刷新读取超时");
        expect(rev).toBe(revBeforeFailRefresh);
    });

    test("hydrateLocalModelConfig makes zero writes when Go-sorted JSON profiles need no migration, persists migrated LL2 profiles once, and recoverIfRevisionChanged reloads updated package revisions", async () => {
        const { hydrateLocalModelConfig } = await import("../src/components/workspace/workspace-bootstrap-hydrator");
        const { buildLL2ModelChannel } = await import("../../plugin-packages/beeftv-plugin-ll2/client/index.js");
        const { recoverIfRevisionChanged } = await import("../src/lib/plugins/plugin-client-loader");
        const { usePluginStore } = await import("../src/stores/use-plugin-store");

        // Simulate Go encoding/json map marshaling (alphabetically sorted keys at every object depth)
        function sortKeysDeep<T>(val: T): T {
            if (!val || typeof val !== "object") return val;
            if (Array.isArray(val)) return val.map(sortKeysDeep) as unknown as T;
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(val as Record<string, unknown>).sort()) {
                out[key] = sortKeysDeep((val as Record<string, unknown>)[key]);
            }
            return out as T;
        }

        const cleanLL2 = createModelChannel(buildLL2ModelChannel({ apiKey: "sk-ll2-clean", baseUrl: "https://api.ll2.cn" }) as Partial<AiConfig["channels"][number]>);
        const goSortedCleanConfig = sortKeysDeep({
            ...defaultConfig,
            channels: [cleanLL2],
        });
        const cleanMock = installMockBackend(goSortedCleanConfig);
        await hydrateLocalModelConfig();
        expect(cleanMock.getWriteCount()).toBe(0);

        // Now hydrate a legacy LL2 channel whose wan3.0-video fell back to newapi -> persists 1 migration write
        const staleLL2 = createModelChannel({
            id: "ll2",
            name: "LL2 (DMC)",
            baseUrl: "https://api.ll2.cn",
            apiKey: "sk-ll2-stale",
            models: ["wan3.0-video"],
            modelProfiles: [{ model: "wan3.0-video", capability: "video", protocol: "newapi" }],
        });
        const staleMock = installMockBackend(sortKeysDeep({ ...defaultConfig, channels: [staleLL2] }));
        await hydrateLocalModelConfig();
        expect(staleMock.getWriteCount()).toBe(1);
        expect(staleMock.getPersistedConfig().channels[0]?.modelProfiles?.[0]?.protocol).toBe("ll2-wan3-video");

        // Subsequent hydrate of the persisted migrated config performs 0 writes
        const afterMigrateMock = installMockBackend(sortKeysDeep(staleMock.getPersistedConfig()));
        await hydrateLocalModelConfig();
        expect(afterMigrateMock.getWriteCount()).toBe(0);

        // Package plugin whose old @rev-A failed with 409 reloads @rev-B when backend returns enabled @rev-B
        const oldManifest = {
            id: "beeftv-plugin-story",
            name: "Story",
            version: "0.1.0",
            revision: "1".repeat(64),
            client: "./client/index.js",
            description: "",
            permissions: [],
            contributes: {},
        };
        const newManifest = { ...oldManifest, version: "0.2.0", revision: "2".repeat(64) };
        usePluginStore.getState().ensurePlugin(oldManifest);
        usePluginStore.getState().setError("beeftv-plugin-story", "409 superseded");
        recoverIfRevisionChanged("beeftv-plugin-story", oldManifest, {
            manifest: newManifest,
            source: "package",
            fileName: "",
            package: "pi-package",
            sha256: "2".repeat(64),
            installedAt: "",
            updatedAt: "",
            status: "enabled",
            management: { origin: "package", kind: "application", activationScope: "system", configurationScope: "none" },
        });
        const updatedInst = usePluginStore.getState().installations.find((i) => i.manifest.id === "beeftv-plugin-story");
        expect(updatedInst?.manifest.revision).toBe("2".repeat(64));
        expect(updatedInst?.lastError).toBeUndefined();
    });
});
