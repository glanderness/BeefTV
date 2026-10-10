import { useEffect, useState } from "react";
import { App, Button, Input, Switch } from "antd";
import { getDesktopAppBinding, type ReferenceStorageConfig } from "@/services/desktop-runtime";

const fields = [
    ["endpoint", "S3 端点", "https://…"],
    ["bucket", "存储桶名称", "例如 beeftv-media"],
    ["region", "区域", "R2 使用 auto；S3 使用存储桶所在区域"],
    ["accessKeyId", "Access Key ID", ""],
    ["publicBaseURL", "存储桶公网地址", "https://media.example.com"],
] as const;

export function ReferenceStoragePane() {
    const binding = getDesktopAppBinding();
    const { message } = App.useApp();
    const [config, setConfig] = useState<ReferenceStorageConfig>({ enabled: false, endpoint: "", bucket: "", region: "auto", accessKeyId: "", publicBaseURL: "", hasSecret: false });
    const [secret, setSecret] = useState("");
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    useEffect(() => {
        let active = true;
        void binding
            ?.ReferenceStorageSettings?.()
            .then((value) => {
                if (active) setConfig(value);
            })
            .catch(() => {
                if (active) setLoadError(true);
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [binding]);
    if (!binding?.SaveReferenceStorage) return null;
    const save = async () => {
        setBusy(true);
        try {
            const value = await binding.SaveReferenceStorage!({ ...config, secretAccessKey: secret });
            setConfig(value);
            setSecret("");
            message.success("对象存储配置已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className="settings-section space-y-4" aria-label="参考素材对象存储">
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>参考素材对象存储</h2>
                    <p>连接你自己的 S3 兼容存储，例如 R2、S3 或 MinIO。</p>
                </div>
            </div>
            <label className="flex items-center justify-between gap-4 text-sm">
                <span>生成时上传需要公网地址的参考素材</span>
                <Switch checked={config.enabled} disabled={loadError || busy} onChange={(enabled) => setConfig((value) => ({ ...value, enabled }))} />
            </label>
            <p className="text-sm leading-6 text-foreground/60">启用后，需要在线素材的渠道会使用上传后的链接。原始素材仍保存在本机；存储及流量由你的存储服务计费。</p>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
                {fields.map(([key, label, placeholder]) => (
                    <label key={key} className="block min-w-0 space-y-2 text-sm">
                        <span>{label}</span>
                        <Input aria-label={label} value={config[key]} placeholder={placeholder} disabled={busy || loadError} autoComplete="off" onChange={(event) => setConfig((value) => ({ ...value, [key]: event.target.value }))} />
                    </label>
                ))}
                <label className="block min-w-0 space-y-2 text-sm">
                    <span>Secret Access Key</span>
                    <Input.Password
                        aria-label="Secret Access Key"
                        value={secret}
                        autoComplete="new-password"
                        placeholder={config.hasSecret ? "已保存，留空保持" : "请输入访问密钥"}
                        disabled={busy || loadError}
                        onChange={(event) => setSecret(event.target.value)}
                    />
                </label>
            </div>
            {loadError ? (
                <p role="alert" className="text-sm text-destructive">
                    已有配置暂时无法读取，请先导出问题记录，避免覆盖。
                </p>
            ) : null}
            <Button onClick={save} loading={busy} disabled={loading || loadError}>
                保存对象存储配置
            </Button>
        </section>
    );
}
