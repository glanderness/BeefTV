import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { VideoSettingsPanel } from "../src/components/video-settings-panel";
import { canvasThemes } from "../src/lib/canvas-theme";
import { normalizeSeedanceResolution } from "../src/lib/seedance-video";
import { createModelChannel, defaultConfig, type AiConfig } from "../src/stores/use-config-store";

function configFor(model: string): AiConfig {
    const channel = createModelChannel({
        id: "seedance-test",
        name: "Seedance Test",
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-key",
        apiFormat: "openai",
        models: [model],
    });
    return {
        ...defaultConfig,
        channels: [channel],
        model: `seedance-test::${model}`,
        videoModel: `seedance-test::${model}`,
        vquality: "480p",
    };
}

describe("Seedance 2.0 limited-resolution models", () => {
    for (const model of ["seedance-2.0-mini", "seedance-2.0-fast"]) {
        test(`${model} disables every resolution above 720P`, () => {
            const html = renderToStaticMarkup(
                <VideoSettingsPanel config={configFor(model)} onConfigChange={() => undefined} theme={canvasThemes.dark} />,
            );

            for (const resolution of ["1080P", "1440P", "2160P"]) {
                expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${resolution}</button>`));
            }
            expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>720P<\/button>/);
        });

        test(`${model} normalizes every unsupported higher resolution to 720P`, () => {
            expect(normalizeSeedanceResolution("1080p", model)).toBe("720p");
            expect(normalizeSeedanceResolution("1440p", model)).toBe("720p");
            expect(normalizeSeedanceResolution("2160p", model)).toBe("720p");
        });
    }
});
