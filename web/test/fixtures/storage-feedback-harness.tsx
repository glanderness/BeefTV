import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme } from "antd";
import { StorageSettingsPane } from "../../src/pages/settings/storage-settings-pane";
import { ReferenceStoragePane } from "../../src/pages/settings/reference-storage-pane";
import { CanvasUploadModal } from "../../src/components/canvas/canvas-upload-modal";
import { createReferenceLinkResolver } from "../../src/pages/canvas/canvas-reference-links";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark",params.has("dark"));
document.body.style.background="var(--background)";
document.body.style.color="var(--foreground)";
const initial = { dataDir: "C:\\Users\\Creator\\AppData\\Roaming\\BeefTV", usedBytes: 1024 ** 3, freeBytes: 40 * 1024 ** 3 };
let usage = JSON.parse(localStorage.getItem("fixture-usage") || JSON.stringify(initial));
const config = { enabled: false, endpoint: "", bucket: "", region: "auto", accessKeyId: "", publicBaseURL: "", hasSecret: false };
window.go = {
    main: {
        DesktopApp: {
            RuntimeConfig: async () => ({ baseURL: "http://127.0.0.1:9999/api", launchToken: "fixture" }),
            StorageSettings: async () => usage,
            ChooseStorageDirectory: async () => "D:\\BeefTV",
            MigrateStorage: async (path) => {
                usage = { ...usage, dataDir: path, previousDir: initial.dataDir, previousBytes: initial.usedBytes };
                localStorage.setItem("fixture-usage", JSON.stringify(usage));
                return usage;
            },
            CleanupPreviousStorage: async () => {
                usage = { ...usage, previousDir: undefined };
                localStorage.setItem("fixture-usage", JSON.stringify(usage));
                return usage;
            },
            ReferenceStorageSettings: async () => ({ ...config, enabled: params.has("auto") }),
            SaveReferenceStorage: async (value) => {
                Object.assign(config, value, { hasSecret: Boolean(value.secretAccessKey) });
                return config;
            },
            UploadReferenceMedia: async (ids) => {
                if (params.has("reject")) throw new Error("公网地址不可读取");
                return Object.fromEntries(ids.map((id) => [id, `https://cdn.example.com/${id}`]));
            },
        },
    },
};
function Harness() {
    const [open, setOpen] = useState(false);
    const [result, setResult] = useState("");
    const { modal } = App.useApp();
    const generate = async () => {
        try {
            const resolve = createReferenceLinkResolver(modal);
            const value = await resolve([{ key: "image", label: "参考图片", resourceID: "owned-image" }]);
            setResult(value?.image || "cancelled");
        } catch (error) {
            setResult(String(error));
        }
    };
    return (
        <main style={{ padding: 16, maxWidth: 900, margin: "auto" }}>
            <StorageSettingsPane />
            <ReferenceStoragePane />
            <button onClick={() => setOpen(true)}>添加测试素材</button>
            <button onClick={() => void generate()}>生成测试</button>
            <output>{result}</output>
            <CanvasUploadModal
                open={open}
                onClose={() => setOpen(false)}
                onUpload={async () => true}
                onImportUrl={async (url, kind) => {
                    setResult(kind + ":" + url);
                    return true;
                }}
            />
        </main>
    );
}
createRoot(document.getElementById("root")!).render(
    <ConfigProvider theme={{ algorithm: params.has("dark") ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { motion: false } }}>
        <App>
            <Harness />
        </App>
    </ConfigProvider>,
);
