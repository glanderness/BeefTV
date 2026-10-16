import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input } from "antd";
import { FileUp, RefreshCw } from "lucide-react";
import { WorkflowGraphEditor } from "@/components/workflow-graph-editor";
import { COMFYUI_WORKFLOW_MAX_BYTES, defaultComfyUIFields, parseComfyUIWorkflow } from "@/lib/comfyui-workflow";
import { inspectComfyUIWorkflow } from "@/services/api/comfyui";
import { mergeWorkflowFieldMappings, normalizeWorkflowFieldMappings, type ModelChannel, type RunningHubCapability } from "@/stores/use-config-store";

type Workflow = NonNullable<NonNullable<ModelChannel["modelProfiles"]>[number]["comfyui"]>;

export function ComfyUIWorkflowEditor({ channel, capability, value, onChange, onBusyChange, disabled = false }: {
    channel: ModelChannel;
    capability: RunningHubCapability;
    value?: Workflow;
    onChange: (value: Workflow) => void;
    onBusyChange?: (busy: boolean) => void;
    disabled?: boolean;
}) {
    const [json, setJSON] = useState(() => value ? JSON.stringify(value.workflowJson, null, 2) : "");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [loading, setLoading] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const mounted = useRef(true);
    const request = useRef<AbortController | null>(null);
    const headersSignature = JSON.stringify(channel.headers || []);
    useEffect(() => { onBusyChange?.(loading); return () => { onBusyChange?.(false); }; }, [loading, onBusyChange]);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
    useEffect(() => {
        request.current?.abort();
        setLoading(false);
        setNotice("");
    }, [channel.baseUrl, channel.apiKey, headersSignature, capability]);

    const inspect = async (workflow: Workflow, imported: boolean) => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setLoading(true);
        setError("");
        setNotice("");
        try {
            const result = await inspectComfyUIWorkflow(channel, workflow.workflowJson, capability, controller.signal);
            if (controller.signal.aborted) return;
            const fields = imported ? normalizeWorkflowFieldMappings(result.fields, capability) : mergeWorkflowFieldMappings(workflow.fields, result.fields, capability);
            onChange({ workflowJson: workflow.workflowJson, fields });
            setNotice("连接成功，已读取节点与模型选项。请确认正向提示词、参考素材和输出节点。");
        } catch (failure) {
            if (!controller.signal.aborted) setError(`${failure instanceof Error ? failure.message : "连接失败"}${imported ? "。JSON 已导入，可手动设置字段来源后保存，或修复连接后重新应用 JSON。" : ""}`);
        } finally {
            if (!controller.signal.aborted) setLoading(false);
        }
    };
    const applyJSON = (text: string) => {
        if (!mounted.current) return;
        setError("");
        try {
            const workflowJson = parseComfyUIWorkflow(text);
            const workflow = { workflowJson, fields: defaultComfyUIFields(workflowJson) };
            setJSON(JSON.stringify(workflowJson, null, 2));
            onChange(workflow);
            void inspect(workflow, true);
        } catch (failure) { setError(failure instanceof Error ? failure.message : "工作流导入失败"); }
    };

    return <div className="space-y-4">
        <p className="text-xs leading-5 text-foreground/60">在 ComfyUI 中导出「API 格式」工作流，每个工作流保存为一个模型。导入时会验证连接并读取节点、checkpoint 和 LoRA 选项；修改字段来源可绑定任务提示词、参考素材和生成参数。</p>
        <div className="flex flex-wrap gap-2">
            <input ref={fileInput} type="file" accept=".json,application/json" hidden disabled={disabled || loading} onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                if (file.size > COMFYUI_WORKFLOW_MAX_BYTES) { setError("工作流文件不能超过 8 MiB"); return; }
                try { applyJSON(await file.text()); } catch { if (mounted.current) setError("无法读取工作流文件，请重试"); }
            }} />
            <Button icon={<FileUp className="size-4" />} disabled={disabled || loading} onClick={() => fileInput.current?.click()}>导入 API JSON 文件</Button>
            <Button icon={<RefreshCw className="size-4" />} loading={loading} disabled={disabled || !value} onClick={() => { if (value) void inspect(value, false); }}>验证连接并刷新选项</Button>
        </div>
        <Input.TextArea aria-label="ComfyUI API 工作流 JSON" value={json} onChange={(event) => setJSON(event.target.value)} placeholder="粘贴 ComfyUI API 格式工作流 JSON" autoSize={{ minRows: 5, maxRows: 12 }} disabled={disabled || loading} />
        <Button disabled={disabled || loading || !json.trim()} onClick={() => applyJSON(json)}>应用 JSON 并识别输入</Button>
        {error && <Alert type="error" title={error} showIcon />}
        {notice && <Alert type="success" title={notice} showIcon />}
        {value && <WorkflowGraphEditor workflowJson={value.workflowJson} fields={value.fields} disabled={disabled || loading} onChange={(fields) => onChange({ ...value, fields: normalizeWorkflowFieldMappings(fields, capability) })} />}
    </div>;
}
