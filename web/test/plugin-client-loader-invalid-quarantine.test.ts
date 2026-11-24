import { beforeEach, describe, expect, test } from "bun:test";
import {
    activateClientPluginModule,
    deactivateAllClientPlugins,
    loadAndActivateClientPlugin,
    syncActiveClientPlugins,
} from "../src/lib/plugins/plugin-client-loader";
import { clearAllPluginContributions } from "../src/lib/plugins/slot-registry";
import {
    isPluginEffectivelyEnabled,
    onPluginStoreLifecycleChange,
    usePluginStore,
} from "../src/stores/use-plugin-store";

describe("plugin client loader invalid quarantine (#641)", () => {
    const pluginId = "broken-market-plugin";
    const manifestV1 = {
        id: pluginId,
        name: "Broken Market Plugin",
        version: "1.0.0",
        revision: "rev-1",
        description: "Reproduces OOM reload loop",
        client: "./dist/nonexistent-client.js",
        permissions: [] as string[],
        contributes: {},
    };
    const enabledServerState = {
        pluginId,
        platformAvailable: true,
        userEnabled: true,
        userConfigured: true,
        effectiveEnabled: true,
        canToggle: true,
        canConfigure: false,
    };

    beforeEach(() => {
        deactivateAllClientPlugins();
        clearAllPluginContributions();
        usePluginStore.setState({
            hydrated: true,
            installations: [],
            runtimeStatuses: {},
            pluginStates: {},
        });
    });

    test("marks plugin invalid after failed client load and stops syncActiveClientPlugins from retrying while revision is unchanged", async () => {
        usePluginStore.getState().syncBackendPlugins(
            [{ manifest: manifestV1, enabled: true }],
            { [pluginId]: enabledServerState },
        );

        let lifecycleEvents = 0;
        const unsubscribe = onPluginStoreLifecycleChange(() => {
            lifecycleEvents += 1;
        });

        try {
            const loaded = await loadAndActivateClientPlugin(pluginId, { manifest: manifestV1 });
            expect(loaded).toBe(false);
            expect(usePluginStore.getState().runtimeStatuses[pluginId]).toBe("invalid");
            // Even while server pluginStates still says effectiveEnabled=true, invalid runtime status must suppress activation.
            expect(isPluginEffectivelyEnabled(pluginId, true)).toBe(false);

            const eventsAfterFirstFailure = lifecycleEvents;
            // Repeated syncs (e.g. React route/sidebar effects) must not trigger another load/failure cycle.
            for (let i = 0; i < 5; i += 1) {
                syncActiveClientPlugins();
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(lifecycleEvents).toBe(eventsAfterFirstFailure);
            expect(usePluginStore.getState().runtimeStatuses[pluginId]).toBe("invalid");

            // Backend re-sync with the SAME version/revision must not clear quarantine into another retry loop.
            usePluginStore.getState().syncBackendPlugins(
                [{ manifest: manifestV1, enabled: true }],
                { [pluginId]: enabledServerState },
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(usePluginStore.getState().runtimeStatuses[pluginId]).toBe("invalid");
            expect(isPluginEffectivelyEnabled(pluginId, true)).toBe(false);
        } finally {
            unsubscribe();
        }
    });

    test("quarantines modules without an activate export so they cannot spin on repeated sync", async () => {
        usePluginStore.getState().syncBackendPlugins(
            [{ manifest: manifestV1, enabled: true }],
            { [pluginId]: enabledServerState },
        );

        const ok = await activateClientPluginModule(pluginId, {}, { manifest: manifestV1, reportBackendError: false });
        expect(ok).toBe(false);
        expect(usePluginStore.getState().runtimeStatuses[pluginId]).toBe("invalid");
        expect(isPluginEffectivelyEnabled(pluginId, true)).toBe(false);
    });

    test("clears invalid quarantine when manifest version/revision changes or user re-enables the plugin", async () => {
        usePluginStore.getState().syncBackendPlugins(
            [{ manifest: manifestV1, enabled: true }],
            { [pluginId]: enabledServerState },
        );
        await loadAndActivateClientPlugin(pluginId, { manifest: manifestV1 });
        expect(isPluginEffectivelyEnabled(pluginId, true)).toBe(false);

        // Case 1: new version/revision clears quarantine.
        const manifestV2 = { ...manifestV1, version: "1.0.1", revision: "rev-2" };
        usePluginStore.getState().syncBackendPlugins(
            [{ manifest: manifestV2, enabled: true }],
            { [pluginId]: enabledServerState },
        );
        expect(usePluginStore.getState().runtimeStatuses[pluginId]).not.toBe("invalid");
        expect(isPluginEffectivelyEnabled(pluginId, true)).toBe(true);

        // Fail v2, then re-enable explicitly to allow manual retry.
        await loadAndActivateClientPlugin(pluginId, { manifest: manifestV2 });
        expect(isPluginEffectivelyEnabled(pluginId, true)).toBe(false);

        usePluginStore.getState().setEnabled(pluginId, false);
        usePluginStore.getState().setEnabled(pluginId, true);
        expect(usePluginStore.getState().runtimeStatuses[pluginId]).not.toBe("invalid");
        expect(isPluginEffectivelyEnabled(pluginId, true)).toBe(true);
    });
});
