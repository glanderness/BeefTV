import { useEffect, useState } from "react";
import { Cloud } from "lucide-react";
import { DetailDrawer } from "@/components/ui/product/app-drawer";
import { StorageRow } from "./storage-layout";
import { Alert, App, Button, Input, Switch } from "antd";
import { getDesktopAppBinding, type ReferenceStorageConfig } from "@/services/desktop-runtime";

const fields = [
    ["endpoint", "S3 端点", "例如 https://cos.ap-guangzhou.myqcloud.com 或 R2 S3 地址"],
    ["bucket", "存储桶名称", "例如 beeftv-media（腾讯云含 -APPID）"],
    ["region", "区域", "R2 填 auto；COS 如 ap-guangzhou；OSS 如 cn-hangzhou"],
    ["accessKeyId", "Access Key ID", ""],
    ["publicBaseURL", "存储桶公网地址", "例如 https://media.example.com 或存储桶公网默认域名"],
] as const;

export function ReferenceStoragePane() {
    const binding = getDesktopAppBinding();
    const { message } = App.useApp();
    const [config, setConfig] = useState<ReferenceStorageConfig>({ enabled: false, endpoint: "", bucket: "", region: "auto", accessKeyId: "", publicBaseURL: "", hasSecret: false });
    const [open, setOpen] = useState(false);
    const [saved, setSaved] = useState(config);
    const [secret, setSecret] = useState("");
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; detail: string } | null>(null);
    useEffect(() => {
        let active = true;
        void binding
            ?.ReferenceStorageSettings?.()
            .then((value) => {
                if (active) { setConfig(value); setSaved(value); }
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
    const save = async (test = false) => {
        setBusy(true);
        setTestResult(null);
        try {
            const value = await binding.SaveReferenceStorage!({ ...config, secretAccessKey: secret });
            setConfig(value);
            setSaved(value);
            setLoadError(false);
            setSecret("");
            if (test) {
                await binding.TestReferenceStorage!();
                setTestResult({ success: true, detail: "上传、公开读取和测试文件清理均已通过" });
            } else message.success("对象存储配置已保存");
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (test) setTestResult({ success: false, detail });
            else message.error(detail);
        } finally {
            setBusy(false);
        }
    };
    return (
        <>
            <StorageRow name="参考素材对象存储" value={loading ? "读取中…" : loadError ? "配置读取失败" : saved.enabled ? saved.bucket || "已启用" : "未启用"}
                action={<Button size="small" aria-label="配置参考素材对象存储" onClick={() => setOpen(true)}>配置</Button>} />
            <DetailDrawer rootClassName="storage-drawer" icon={<Cloud size={22} />} title="参考素材对象存储" open={open} busy={busy} onClose={() => {
                setOpen(false);
                setConfig(saved);
                setSecret("");
                setTestResult(null);
            }} footer={<div className="storage-buttons">
                {binding.TestReferenceStorage && <Button onClick={() => void save(true)} loading={busy} disabled={loading || !config.enabled}>保存并测试上传</Button>}
                <Button type="primary" aria-label="保存对象存储配置" onClick={() => void save()} loading={busy} disabled={loading}>保存配置</Button>
            </div>}>
                <div className="storage-detail-sections">
                    <section className="storage-detail-card">
                        <label className="storage-detail-heading">
                            <span>生成时上传参考素材</span>
                            <Switch aria-label="生成时上传参考素材" checked={config.enabled} disabled={busy || loading} onChange={(enabled) => { setTestResult(null); setConfig((value) => ({ ...value, enabled })); }} />
                        </label>
                        <p className="storage-detail-note">仅在渠道需要公网地址时上传。原始素材保留在本机，存储和流量由服务商计费。</p>
                    </section>
                    <section className="storage-fields">
                        <h3>S3 兼容存储</h3>
                        {fields.map(([key, label, placeholder]) => (
                            <label key={key} className="block min-w-0 space-y-2 text-sm">
                                <span>{label}</span>
                                <Input aria-label={label} value={config[key]} placeholder={placeholder} disabled={busy || loading} autoComplete="off" onChange={(event) => { setTestResult(null); setConfig((value) => ({ ...value, [key]: event.target.value })); }} />
                            </label>
                        ))}
                        <label className="block min-w-0 space-y-2 text-sm">
                            <span>Secret Access Key</span>
                            <Input.Password
                                aria-label="Secret Access Key"
                                value={secret}
                                autoComplete="new-password"
                                placeholder={config.hasSecret ? "已保存，留空保持" : "请输入访问密钥"}
                                disabled={busy || loading}
                                onChange={(event) => { setTestResult(null); setSecret(event.target.value); }}
                            />
                        </label>
                    </section>
                    {loadError ? (
                        <p role="alert" className="text-sm text-destructive">
                            已有对象存储配置无法读取（如本机密钥已重置），可直接保存关闭对象存储，或重新填写完整配置与 Secret Key 后保存覆盖。
                        </p>
                    ) : null}
                    {testResult && <Alert showIcon type={testResult.success ? "success" : "error"} title={testResult.success ? "存储测试通过" : "存储测试未通过"} description={testResult.detail} />}
                    <p className="storage-detail-note">测试会上传图片，验证公开读取后删除，可能产生少量请求费用。</p>
                </div>
            </DetailDrawer>
        </>
    );
}
