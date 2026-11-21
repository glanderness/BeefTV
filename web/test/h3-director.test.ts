import { expect, test } from "bun:test";
import { H3DirectorControl, h3DirectorConfigure } from "../src/lib/h3-director";

test("Director requires matching configure acknowledgement and never replays terminal sessions", () => {
    const sent: object[] = [];
    const session = new H3DirectorControl((m) => sent.push(m));
    session.configure({ prompt: "Continuous scene", seed: 0, audio_bitrate: 192000, memory: 50 });
    expect(sent[0]).toMatchObject({ type: "configure", prompt_version: 1, seed: 0 });
    expect(() => session.update({ prompt: "Turn left" })).toThrow();
    session.accept({ type: "configured", prompt_version: 2 });
    expect(() => session.update({ prompt: "Turn left" })).toThrow();
    session.accept({ type: "configured", prompt_version: 1 });
    session.update({ prompt: "Turn left", replan: false });
    session.update({ audio_url: "https://example.com/audio", audio_behavior: "queue" });
    expect(sent[1]).toMatchObject({ prompt_version: 2, replan: false });
    expect(sent[2]).toMatchObject({ prompt_version: 3, audio_behavior: "queue" });
    session.accept({ type: "stream_exhausted", reason: "session_limit" });
    expect(() => session.update({ prompt: "Continue" })).toThrow();
    expect(sent).toHaveLength(3);
});

test("Director scripts validate exclusivity, offsets and endpoint spacing", () => {
    expect(
        h3DirectorConfigure({
            prompt: "Story",
            script: [
                { offset: 0, prompt: "Opening" },
                { offset: 3, end_image_url: "https://example.com/end" },
            ],
        }),
    ).toMatchObject({
        script: [
            { offset: 0, prompt: "Opening" },
            { offset: 3, end_image_url: "https://example.com/end" },
        ],
    });
    expect(() => h3DirectorConfigure({ prompt: "Story", script: [{ offset: 0, prompt: "Opening" }], audio_url: "https://example.com/audio" })).toThrow();
    expect(() =>
        h3DirectorConfigure({
            prompt: "Story",
            script: [
                { offset: 2, prompt: "A" },
                { offset: 1, prompt: "B" },
            ],
        }),
    ).toThrow();
    expect(() =>
        h3DirectorConfigure({
            prompt: "Story",
            script: [
                { offset: 0, end_image_url: "https://example.com/a" },
                { offset: 2, end_image_url: "https://example.com/b" },
            ],
        }),
    ).toThrow();
});
