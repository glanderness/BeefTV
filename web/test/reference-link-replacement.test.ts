import { expect, test } from "bun:test";
import { submitBackendGenerationTask } from "../src/services/api/generation-task";
import { ApiError } from "../src/services/api/request";
import { isReferenceHTTPSLink } from "../src/services/api/reference-link-replacement";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";
import { setActiveUserScope } from "../src/lib/user-scope";
import type { GenerationTask } from "../src/services/api/task-center";

const channel = createModelChannel({ id: "test-links", name: "Test", baseUrl: "https://provider.example", apiKey: "fixture", interfaceType: "openai-images", models: ["image-test"] });
const options = { mode: "image" as const, prompt: "test", config: { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "image-test") }, referenceImages: [{ id: "one", name: "local.png", type: "image/png", storageKey: "resource:one", width: 800, height: 600 }] };
const rejected = new ApiError("需要在线素材", { reason: "reference_media_requires_url", status: 400 });

test("HTTPS replacement requires HTTPS without embedded credentials", () => {
    for (const value of ["http://cdn.example/x", "file:///x", "https://user:secret@cdn.example/x", "bad"]) expect(isReferenceHTTPSLink(value)).toBe(false);
    expect(isReferenceHTTPSLink(" https://cdn.example/x?signature=fixture ")).toBe(true);
});

for (const action of ["replace", "cancel", "abort", "switch", "invalid", "upstream-error"] as const) {
    test(`reference admission recovery: ${action}`, async () => {
        setActiveUserScope("link-owner");
        const calls: any[] = [];
        let prompts = 0;
        const controller = new AbortController();
        const promise = submitBackendGenerationTask({ ...options, signal: controller.signal, resolveReferenceLinks: async (refs) => {
            prompts++;
            expect(refs.map((ref) => ref.label)).toEqual(["参考图片 1"]);
            if (action === "cancel") return null;
            if (action === "abort") controller.abort();
            if (action === "switch") { setActiveUserScope("other-owner"); setActiveUserScope("link-owner"); }
            return { "referenceImages:0": action === "invalid" ? "http://cdn.example/x" : "https://cdn.example/x" };
        } }, {
            createTask: async (input) => {
                calls.push(input);
                if (calls.length === 1) throw action === "upstream-error" ? new ApiError("timeout", { status: 504 }) : rejected;
                return { id: "accepted" } as GenerationTask;
            }, waitTask: async () => { throw new Error("must not poll"); }, createId: () => "unused",
        });
        if (action === "replace") {
            expect((await promise).id).toBe("accepted");
            const media = calls[1].input.referenceImages[0];
            expect(media.url).toBe("https://cdn.example/x");
            expect(media.storageKey).toBeUndefined();
            expect(media.width).toBe(800);
            expect(options.referenceImages[0].storageKey).toBe("resource:one");
        } else { await expect(promise).rejects.toThrow(); }
        expect(calls.length).toBe(action === "replace" ? 2 : 1);
        expect(prompts).toBe(action === "upstream-error" ? 0 : 1);
    });
}

test("concurrent submissions retain reference order and replace mask without changing originals", async () => {
    const inputs: any[] = [];
    const references = [options.referenceImages[0], { ...options.referenceImages[0], id: "two", storageKey: "resource:two", name: "two.png" }];
    await Promise.all([0, 1].map(async () => {
        let attempt = 0;
        await submitBackendGenerationTask({ ...options, referenceImages: references, mask: { ...references[0], id: "mask", storageKey: "resource:mask" }, resolveReferenceLinks: async (refs) => {
            expect(refs.map((ref) => ref.key)).toEqual(["referenceImages:0", "referenceImages:1", "mask:0"]);
            return { "referenceImages:0": "https://cdn.example/one", "referenceImages:1": "https://cdn.example/two", "mask:0": "https://cdn.example/mask" };
        } }, {
            createTask: async (input) => { if (attempt++ === 0) throw rejected; inputs.push(input.input); return { id: "accepted" } as GenerationTask; },
            waitTask: async () => { throw new Error("must not poll"); }, createId: () => "unused",
        });
    }));
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
        expect(input.referenceImages.map((media: any) => [media.id, media.url])).toEqual([["one", "https://cdn.example/one"], ["two", "https://cdn.example/two"]]);
        expect(input.mask.url).toBe("https://cdn.example/mask");
        expect(input.mask.storageKey).toBeUndefined();
    }
    expect(references.map((media) => media.storageKey)).toEqual(["resource:one", "resource:two"]);
});

test("second admission rejection propagates without a third submission", async () => {
    let calls = 0;
    await expect(submitBackendGenerationTask({ ...options, resolveReferenceLinks: async () => ({ "referenceImages:0": "https://cdn.example/one" }) }, {
        createTask: async () => { calls++; throw rejected; }, waitTask: async () => { throw new Error("must not poll"); }, createId: () => "unused",
    })).rejects.toBe(rejected);
    expect(calls).toBe(2);
});
