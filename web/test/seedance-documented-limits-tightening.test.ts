import { expect, test } from "bun:test";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor, tightenDocumentedOutputDuration } from "../src/lib/model-capabilities";
import { assertVideoCapability } from "../src/services/api/video-validation";

const image = (id: string) => ({ id, name: id, type: "image/png", dataUrl: "", width: 512, height: 512 });
const audio = (id: string) => ({ id, name: id, type: "audio/mpeg", url: `https://example.com/${id}.mp3`, durationMs: 3000 });

function savedProfile(model: string, mutate: (config: ReturnType<typeof defaultModelCapabilityConfig>) => void, baseUrl = "https://enterprise.beefapi.com", protocol: "newapi" | "volcengine-ark-video" = "newapi") {
    const capabilityConfig = defaultModelCapabilityConfig(protocol, model);
    mutate(capabilityConfig);
    const channel = { id: "test", models: [model], baseUrl, modelProfiles: [{ model, protocol, capability: "video" as const, capabilityConfig }] };
    return modelCapabilityConfigFor({ channels: [channel] }, `test::${model}`).video!;
}

test("保存的枚举时长配置也按 4 秒下限收紧并保留自动时长", () => {
    const enumProfile = savedProfile("seedance-2.0", (config) => {
        config.video!.duration = { selection: "enum", values: [-1, 1, 2, 3, 4, 5], default: 5 };
    });
    expect(enumProfile.duration.values).toEqual([-1, 4, 5]);
    expect(enumProfile.duration.default).toBe(5);
    expect(() => assertVideoCapability(enumProfile, [image("i0")], [], [], "1")).toThrow("输出时长为 1 秒");
    expect(() => assertVideoCapability(enumProfile, [image("i0")], [], [], "4")).not.toThrow();
});

test("保存的连续时长配置把 fractionalMin 也抬到 4 秒", () => {
    const continuous = savedProfile("seedance-2.0", (config) => {
        config.video!.duration = { selection: "range", min: 1, fractionalMin: 0.92, max: 15, step: 1, default: 5, continuous: true };
    });
    expect(continuous.duration.min).toBe(4);
    expect(continuous.duration.fractionalMin).toBe(4);
    expect(() => assertVideoCapability(continuous, [image("i0")], [], [], "1")).toThrow("输出时长为 1 秒");
    expect(() => assertVideoCapability(continuous, [image("i0")], [], [], "4")).not.toThrow();
});

test("更严格的参考音频下限保留", () => {
    const strict = savedProfile("seedance-2.0", (config) => { config.video!.references.minAudioDurationSeconds = 5; });
    expect(strict.references.minAudioDurationSeconds).toBe(5);
    const loose = savedProfile("seedance-2.0", (config) => { config.video!.references.minAudioDurationSeconds = 1.8; });
    expect(loose.references.minAudioDurationSeconds).toBe(2);
});

test("枚举里没有任何合法时长时拒绝提交，而不是退回低于 4 秒的值", () => {
    for (const values of [[1], [1, 2, 3]]) {
        const profile = savedProfile("seedance-2.0", (config) => {
            config.video!.duration = { selection: "enum", values: [...values], default: 1 };
        });
        expect(profile.duration.values).toEqual([]);
        for (const seconds of ["1", "2", "3", "4"]) {
            expect(() => assertVideoCapability(profile, [image("i0")], [], [], seconds)).toThrow("当前模型没有可用的输出时长");
        }
        expect(tightenDocumentedOutputDuration({ selection: "enum", values: [...values], default: 1 })).toEqual({ selection: "enum", values: [], default: 1 });
    }
});

test("时长收紧函数本身对三种配置都只收紧不放宽", () => {
    expect(tightenDocumentedOutputDuration({ selection: "range", min: 5, max: 15, step: 1, default: 5 })).toEqual({ selection: "range", min: 5, max: 15, step: 1, default: 5 });
    expect(tightenDocumentedOutputDuration({ selection: "enum", values: [5, 10], default: 5 })).toEqual({ selection: "enum", values: [5, 10], default: 5 });
    expect(tightenDocumentedOutputDuration({ selection: "enum", values: [-1, 1, 2, 3, 4, 5], default: 1 })).toEqual({ selection: "enum", values: [-1, 4, 5], default: 4 });
});

test("参考音频下限同样作用于参考音频校验", () => {
    const profile = savedProfile("seedance-2.0", () => {});
    expect(() => assertVideoCapability(profile, [image("i0")], [], [audio("a0"), { ...audio("a1"), durationMs: 1800 }], "5")).toThrow("1.80");
});