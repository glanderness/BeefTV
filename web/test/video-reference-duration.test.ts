import { expect, test } from "bun:test";
import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { assertVideoCapability } from "../src/services/api/video-validation";
import { explainGenerationError } from "../src/lib/generation-error";

for (const protocol of ["newapi-channel-2", "newapi", "openai"] as const) {
    for (const model of ["seedance-2.5", "provider/seedance-2.0-fast"]) {
        test(`${protocol} ${model}: real profiles reject short and unknown reference duration`, () => {
            const profile = modelCapabilityConfigFor(
                { channels: [{ id: "test", models: [model], baseUrl: protocol === "openai" ? "https://legacy.example.com" : "https://enterprise.beefapi.com", modelProfiles: [{ model, protocol }] }] },
                `test::${model}`,
            ).video!;
            const audio = (durationMs: number) => ({ id: "audio", name: "声音", type: "audio/mpeg", url: "https://example.com/a.mp3", durationMs });
            expect(() => assertVideoCapability(profile, [], [], [audio(2500), audio(900)], "5")).toThrow("第 2 段参考音频时长为 0.90 秒");
            expect(() => assertVideoCapability(profile, [], [], [audio(0)], "5")).toThrow("时长无法读取");
            expect(() => assertVideoCapability(profile, [], [], [audio(2000)], "5")).not.toThrow();
            const failure = explainGenerationError("第 2 段参考音频时长为 0.90 秒，需要 2–30 秒；请裁剪或更换这段素材后再提交");
            expect(failure.category).toBe("invalid_params");
            expect(failure.reason).toContain("第 2 段");
            expect(failure.action).toContain("2–30");
        });
    }
}

test("persisted material duration explanation keeps actionable limits", () => {
    const text = "参考素材时长不符合模型要求。请检查每段参考音频和视频，将不符合要求的素材调整为 1.8–30.2 秒后重新提交。";
    expect(explainGenerationError({ code: "invalid_params", message: text }).action).toContain("1.8–30.2");
});

test("legacy channel protocol without model profiles still applies Seedance duration limits", () => {
    const profile = modelCapabilityConfigFor({ channels: [{ id: "legacy", interfaceType: "openai", models: ["seedance-2.5"] }] }, "legacy::seedance-2.5").video!;
    expect(profile.references.minAudioDurationSeconds).toBe(2);
    expect(profile.references.maxAudioDurationSeconds).toBe(30);
});

for (const [model, maximum] of [
    ["seedance-2.0", 15],
    ["seedance-2.5", 30],
    ["provider/seedance-2.5", 30],
    ["seedance-2.5-self-developed", 30],
] as const) {
    test(`${model}: total audio duration is checked before submission`, () => {
        const profile = modelCapabilityConfigFor({ channels: [{ id: "test", interfaceType: "openai", models: [model] }] }, `test::${model}`).video!;
        const audio = (duration: number) => ({ id: "audio", name: "声音", type: "audio/mpeg", url: "https://example.com/a.mp3", durationMs: duration * 1000 });
        expect(() => assertVideoCapability(profile, [], [], [audio(maximum / 2), audio(maximum / 2)], "5")).not.toThrow();
        expect(() => assertVideoCapability(profile, [], [], [audio(maximum / 2), audio(maximum / 2 + 1)], "5")).toThrow(`最多支持 ${maximum} 秒`);
    });
}
