import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { getAntThemeConfig } from "../../src/lib/app-theme";
import { ModelServiceEditor } from "../../src/pages/settings/model-service-editor";
import { createModelChannel, type ModelChannel } from "../../src/stores/use-config-store";

// 场景用 query 切换，避免为每种凭证类型重复一份构建。
const scenario = new URLSearchParams(location.search).get("scenario") || "ark-none";

function initialChannel(): ModelChannel {
    if (scenario === "jimeng") {
        return createModelChannel({
            name: "即梦视频",
            baseUrl: "https://visual.volcengineapi.com",
            models: ["jimeng_t2v_v30"],
            modelProfiles: [{ model: "jimeng_t2v_v30", capability: "video", protocol: "volcengine-jimeng-video", authType: "volcengine-v4" }],
        });
    }
    if (scenario === "jimeng-saved") {
        // 登录态工作区只回读「已保存」标记，不返回密钥本体。
        return createModelChannel({
            name: "即梦视频",
            baseUrl: "https://visual.volcengineapi.com",
            models: ["jimeng_t2v_v30"],
            modelProfiles: [{ model: "jimeng_t2v_v30", capability: "video", protocol: "volcengine-jimeng-video", authType: "volcengine-v4" }],
            hasApiKey: true,
            hasSecretKey: true,
        });
    }
    if (scenario === "agent-plan") {
        return createModelChannel({
            name: "方舟 Agent Plan",
            baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
            models: ["doubao-seedance-2.5"],
            modelProfiles: [{ model: "doubao-seedance-2.5", capability: "video", protocol: "volcengine-ark-agent-plan-video", authType: "bearer" }],
        });
    }
    if (scenario === "ark-mixed") {
        return createModelChannel({
            name: "火山方舟",
            baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
            models: ["doubao-seedance-2.5", "doubao-seedance-2.0"],
            modelProfiles: [
                { model: "doubao-seedance-2.5", capability: "video", protocol: "volcengine-ark-video", authType: "bearer" },
                { model: "doubao-seedance-2.0", capability: "video", protocol: "volcengine-ark-agent-plan-video", authType: "bearer" },
            ],
        });
    }
    if (scenario === "ark-native") {
        return createModelChannel({
            name: "火山方舟",
            baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
            models: ["doubao-seedance-2.5"],
            modelProfiles: [{ model: "doubao-seedance-2.5", capability: "video", protocol: "volcengine-ark-video", authType: "bearer" }],
        });
    }
    return createModelChannel({ name: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: [] });
}

const dark = new URLSearchParams(location.search).get("theme") === "dark";
// 保存结果回写给测试：没有这一步，浏览器用例只能证明文字出现，证明不了行为。
const saved: Array<{ apiKey: string; secretKey?: string; models: string[] }> = [];
(globalThis as unknown as { __saved: typeof saved }).__saved = saved;

createRoot(document.getElementById("root")!).render(
    <ConfigProvider theme={getAntThemeConfig(dark)}>
        <App>
            <ModelServiceEditor initial={initialChannel()} onClose={() => {}} onSave={async (channel) => { saved.push({ apiKey: channel.apiKey, secretKey: channel.secretKey, models: channel.models }); }} />
        </App>
    </ConfigProvider>,
);