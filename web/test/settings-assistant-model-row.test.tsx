import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ModelDefaultGrid } from "@/pages/settings/model-default-grid";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, type AiConfig } from "@/stores/use-config-store";

function configWithTextChannel(overrides: Partial<AiConfig> = {}): AiConfig {
    const channels = [
        createModelChannel({
            id: "a",
            name: "本地渠道",
            models: ["chat-1", "chat-2"],
            modelProfiles: [
                { model: "chat-1", capability: "text", protocol: "chat-completion" },
                { model: "chat-2", capability: "text", protocol: "claude-api" },
            ],
        }),
    ];
    return normalizeConfigSnapshot({ config: { ...defaultConfig, channels, textModel: "a::chat-1", ...overrides } }).config;
}

/** 取出助手一行内各个选项的选中态，顺序即渲染顺序。 */
function assistantChecked(config: AiConfig) {
    const markup = renderToStaticMarkup(<ModelDefaultGrid config={config} onChange={() => {}} />);
    const start = markup.indexOf('id="default-assistant-title"');
    const end = markup.indexOf('id="default-audio-title"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return [...markup.slice(start, end).matchAll(/aria-checked="(true|false)"/g)].map((match) => match[1] === "true");
}

describe("模型配置页的助手模型一行", () => {
    test("排在默认文本模型之后、默认音频模型之前", () => {
        const markup = renderToStaticMarkup(<ModelDefaultGrid config={configWithTextChannel()} onChange={() => {}} />);
        const textIndex = markup.indexOf("默认文本模型");
        const assistantIndex = markup.indexOf("助手模型");
        const audioIndex = markup.indexOf("默认音频模型");
        expect(textIndex).toBeGreaterThan(-1);
        expect(assistantIndex).toBeGreaterThan(textIndex);
        expect(audioIndex).toBeGreaterThan(assistantIndex);
    });

    test("默认选中跟随默认文本模型，并说明助手会做什么", () => {
        const markup = renderToStaticMarkup(<ModelDefaultGrid config={configWithTextChannel()} onChange={() => {}} />);
        expect(markup).toContain("跟随默认文本模型");
        expect(markup).toContain("画布助手用这个模型理解你的要求并修改画布。");
        expect(markup).toContain("chat-1");
        expect(markup).toContain("chat-2");
    });

    test("选中态跟着 assistantModel 走：为空选中跟随项，有值选中对应模型", () => {
        // 助手一行的三个选项顺序固定为：跟随默认文本模型、chat-1、chat-2。
        expect(assistantChecked(configWithTextChannel())).toEqual([true, false, false]);
        expect(assistantChecked(configWithTextChannel({ assistantModel: "a::chat-2" }))).toEqual([false, false, true]);
        // 失效的显式选择不能悄悄改用默认模型。
        expect(assistantChecked(configWithTextChannel({ assistantModel: "gone::chat-1" }))).toEqual([false, false, false]);
    });
});
