import { Alert, Button, Input } from "antd";
import { FileUp, KeyRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AppModal } from "@/components/ui/product/app-modal";
import type { ModelProtocolDefinition } from "@/lib/model-protocols";
import { serviceConnectionError, serviceModelProfile } from "@/lib/model-service-presets";
import { serviceCredentialGuide } from "@/lib/service-credentials";
import { fetchPluginProviderCatalog } from "@/services/api/plugin-catalog";
import { useConfigStore, type ModelChannel } from "@/stores/use-config-store";
import { parseSharedChannel, prepareImportedChannel, type SharedChannel } from "./channel-share";

// The guide names the key after the protocol's vendor. A relay that speaks the Ark
// format still takes its own token, so only official Ark hosts keep the Ark wording.
function importCredentialGuide(channel: ModelChannel, protocols: ModelProtocolDefinition[]) {
    const guide = serviceCredentialGuide(channel, protocols);
    if (guide.kind !== "ark-native" && guide.kind !== "ark-agent-plan") return guide;
    let host = "";
    try { host = new URL(channel.baseUrl).hostname; } catch { /* validated before this point */ }
    if (/^ark\.[a-z0-9-]+\.volces\.com$/.test(host) || host === "ark.ap-southeast.bytepluses.com") return guide;
    return { ...guide, apiKeyLabel: "API Key", apiKeyPlaceholder: "粘贴你的 API Key" };
}

export function ChannelImportDialog({ onClose, onImport, onSave }: { onClose: () => void; onImport: (channel: ModelChannel) => void; onSave: (channel: ModelChannel) => Promise<void> }) {
    const [json, setJson] = useState("");
    const [protocols, setProtocols] = useState<ModelProtocolDefinition[] | null>(null);
    const [catalogError, setCatalogError] = useState("");
    const [catalogAttempt, setCatalogAttempt] = useState(0);
    const [error, setError] = useState("");
    const [reading, setReading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [prepared, setPrepared] = useState<SharedChannel | null>(null);
    const [apiKey, setApiKey] = useState("");
    const [secretKey, setSecretKey] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);
    const alive = useRef(true);
    const channels = useConfigStore((state) => state.config.channels);
    const existing = prepared ? channels.find((channel) => channel.id === prepared.id) : undefined;
    const credential = prepared && protocols ? importCredentialGuide(prepareImportedChannel(prepared, channels), protocols) : null;

    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
    }, []);
    useEffect(() => {
        let active = true;
        setCatalogError("");
        void fetchPluginProviderCatalog("user.custom-channel")
            .then((items) => { if (active) setProtocols(items); })
            .catch(() => { if (active) setCatalogError("无法读取可用协议，请重试"); });
        return () => { active = false; };
    }, [catalogAttempt]);

    const changeJson = (value: string) => {
        setJson(value);
        setPrepared(null);
        setError("");
    };
    const readFile = async (file: File) => {
        setReading(true);
        setPrepared(null);
        setError("");
        try {
            if (!file.name.toLowerCase().endsWith(".json")) throw new Error("请选择 JSON 文件");
            const value = await file.text();
            if (alive.current) changeJson(value);
        } catch (failure) {
            if (alive.current) setError(failure instanceof Error ? failure.message : "无法读取 JSON 文件，请重试");
        } finally {
            if (alive.current) setReading(false);
        }
    };
    const validate = () => {
        if (!protocols) return;
        try {
            const shared = parseSharedChannel(json, protocols);
            prepareImportedChannel(shared, useConfigStore.getState().config.channels);
            setPrepared(shared);
            setError("");
        } catch (failure) {
            setPrepared(null);
            setError(failure instanceof Error ? failure.message : "渠道配置校验失败");
        }
    };
    const openEditor = () => {
        if (!prepared) return;
        try { onImport(prepareImportedChannel(prepared, useConfigStore.getState().config.channels)); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "渠道配置校验失败"); }
    };
    // The file already carries models and protocols, so a key is all that is
    // needed; reading the model catalog is skipped (Ark-style hosts have none).
    const save = async () => {
        if (!prepared || !protocols) return;
        try {
            const base = prepareImportedChannel(prepared, useConfigStore.getState().config.channels);
            const draft: ModelChannel = { ...base, apiKey: apiKey.trim() || base.apiKey, secretKey: secretKey.trim() || base.secretKey };
            // Same profile derivation as the editor's save, so authType follows the protocol.
            const modelProfiles = draft.models.map((id) => serviceModelProfile(draft, { id }, protocols));
            const missing = modelProfiles.find((profile) => !profile.protocol);
            if (missing) throw new Error(`${missing.model} 缺少请求协议，请点「打开编辑器」补齐`);
            const channel = { ...draft, modelProfiles };
            const problem = serviceConnectionError(channel, { protocols });
            if (problem) throw new Error(problem);
            setSaving(true);
            setError("");
            await onSave(channel);
            onClose();
        } catch (failure) {
            if (alive.current) setError(failure instanceof Error ? failure.message : "导入失败");
        } finally {
            if (alive.current) setSaving(false);
        }
    };
    const keyPlaceholder = (saved: boolean | undefined, fallback: string) => saved ? "已保存密钥；填写以替换" : fallback;

    return <AppModal open flush width={640} title={null} footer={null} closable={false} keyboard={!saving} onCancel={saving ? undefined : onClose}>
        <div className="space-y-4 p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">导入模型渠道</h2>
                <Button type="text" aria-label="关闭导入模型渠道" icon={<X className="size-4" />} disabled={saving} onClick={onClose} />
            </div>
            <div className="max-h-[65dvh] space-y-4 overflow-y-auto">
                <p className="text-sm text-foreground/65">粘贴单个渠道的 JSON，或选择配置文件。文件中的密钥和请求头会被丢弃。</p>
                <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" aria-label="选择渠道 JSON 文件" onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void readFile(file);
                }} />
                <Button icon={<FileUp className="size-4" />} loading={reading} disabled={saving} onClick={() => fileInput.current?.click()}>选择 JSON 文件</Button>
                <label htmlFor="channel-import-json" className="block text-sm font-medium">渠道 JSON</label>
                <Input.TextArea id="channel-import-json" value={json} onChange={(event) => changeJson(event.target.value)} disabled={reading || saving} rows={9} spellCheck={false} placeholder="粘贴 beeftv.channel 格式的 JSON" />
                {catalogError ? <Alert type="error" showIcon title={catalogError} action={<Button size="small" onClick={() => setCatalogAttempt((value) => value + 1)}>重试</Button>} /> : null}
                {prepared ? <div className="space-y-3 text-sm" role="status">
                    <div className="space-y-1">
                        <p className="font-medium">{prepared.name} · {prepared.models.length} 个模型</p>
                        <p className="break-all text-foreground/65">{prepared.baseUrl}</p>
                    </div>
                    {existing ? <Alert type="warning" showIcon title="同 ID 渠道已存在：保存后更新地址、模型和协议，保留本地密钥和请求头。" /> : null}
                    {existing && existing.baseUrl !== prepared.baseUrl ? <Alert type="warning" showIcon title="服务地址将更改，后续请求会向新地址发送保留的本地凭证。" description={<div className="space-y-1 break-all"><p>{existing.baseUrl}</p><p>→ {prepared.baseUrl}</p></div>} /> : null}
                    {credential?.conflict ? <Alert type="error" showIcon title={credential.conflict} /> : null}
                    {credential ? <div className="space-y-1.5">
                        <label htmlFor="channel-import-api-key" className="block font-medium">{credential.apiKeyLabel}</label>
                        <Input.Password id="channel-import-api-key" prefix={<KeyRound size={15} />} autoComplete="new-password" disabled={saving} placeholder={keyPlaceholder(existing?.hasApiKey || Boolean(existing?.apiKey), credential.apiKeyPlaceholder)} value={apiKey} onChange={(event) => { setApiKey(event.target.value); setError(""); }} onPressEnter={() => void save()} />
                    </div> : null}
                    {credential?.secretKeyRequired ? <div className="space-y-1.5">
                        <label htmlFor="channel-import-secret-key" className="block font-medium">{credential.secretKeyLabel}</label>
                        <Input.Password id="channel-import-secret-key" prefix={<KeyRound size={15} />} autoComplete="new-password" disabled={saving} placeholder={keyPlaceholder(existing?.hasSecretKey || Boolean(existing?.secretKey), `粘贴 ${credential.secretKeyLabel}`)} value={secretKey} onChange={(event) => { setSecretKey(event.target.value); setError(""); }} />
                    </div> : null}
                </div> : null}
                {error ? <Alert type="error" showIcon title={error} /> : null}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
                <Button disabled={saving} onClick={onClose}>取消</Button>
                {prepared ? <>
                    <Button disabled={saving} onClick={openEditor}>打开编辑器</Button>
                    <Button type="primary" loading={saving} onClick={() => void save()}>导入并保存</Button>
                </> : <Button type="primary" disabled={!json.trim() || reading || !protocols} loading={!protocols && !catalogError} onClick={validate}>校验配置</Button>}
            </div>
        </div>
    </AppModal>;
}
