import { App, Button, Radio } from "antd";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { AppModal } from "@/components/ui/product/app-modal";
import { useCopyText } from "@/hooks/use-copy-text";
import { createAgentClient, type AgentClientKind, type AgentClientMode, type AgentClientRegistration } from "@/services/api/agent-clients";

import { agentClientKindLabel, agentClientModeLabel, agentClientModeSummary, agentClientSetupBlock } from "./agent-client-presentation";

const modes: AgentClientMode[] = ["read-only", "read-write"];

export function AgentConnectModal({ kind, onClose, onConnected }: { kind: AgentClientKind | null; onClose: () => void; onConnected: () => void }) {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const [mode, setMode] = useState<AgentClientMode>("read-only");
    const [submitting, setSubmitting] = useState(false);
    const [registration, setRegistration] = useState<AgentClientRegistration | null>(null);

    useEffect(() => {
        if (!kind) return;
        setMode("read-only");
        setSubmitting(false);
        setRegistration(null);
    }, [kind]);

    const connect = async () => {
        if (!kind) return;
        setSubmitting(true);
        try {
            const result = await createAgentClient({ kind, mode });
            setRegistration(result);
            onConnected();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "连接失败，请稍后重试");
        } finally {
            setSubmitting(false);
        }
    };

    const setup = agentClientSetupBlock(registration?.setup);

    return (
        <AppModal
            open={Boolean(kind)}
            onCancel={onClose}
            title={`连接 ${agentClientKindLabel(kind || "other")}`}
            width={registration ? 560 : 440}
            footer={
                registration ? (
                    <Button type="primary" onClick={onClose}>我已粘贴好</Button>
                ) : (
                    <>
                        <Button onClick={onClose}>取消</Button>
                        <Button type="primary" loading={submitting} onClick={() => void connect()}>连接</Button>
                    </>
                )
            }
        >
            {registration && setup ? (
                <div className="flex flex-col gap-3 py-1">
                    <p className="text-xs leading-5 text-foreground/60">{setup.instruction}</p>
                    <pre className="max-h-64 overflow-auto rounded-md bg-surface-active px-3.5 py-3 text-[12px] leading-5 font-mono whitespace-pre-wrap break-all text-foreground/85">{setup.text}</pre>
                    <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 text-xs leading-5 text-foreground/50">这段内容只显示一次，关掉后需要重新连接。</p>
                        <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copyText(setup.text)}>复制</Button>
                    </div>
                </div>
            ) : registration ? (
                <p className="py-2 text-xs leading-5 text-foreground/60">没有拿到接入内容，请断开后重新连接。</p>
            ) : (
                <div className="flex flex-col gap-3 py-1">
                    <p className="text-xs leading-5 text-foreground/60">选择它在你的画布上能做什么。</p>
                    <Radio.Group value={mode} onChange={(event) => setMode(event.target.value as AgentClientMode)} className="flex flex-col gap-2.5">
                        {modes.map((item) => (
                            <Radio key={item} value={item} className="items-start">
                                <span className="block pl-0.5">
                                    <span className="block text-[13px] leading-5 font-medium">{agentClientModeLabel(item)}</span>
                                    <span className="mt-0.5 block text-xs leading-5 text-foreground/50">{agentClientModeSummary(item)}</span>
                                </span>
                            </Radio>
                        ))}
                    </Radio.Group>
                </div>
            )}
        </AppModal>
    );
}
