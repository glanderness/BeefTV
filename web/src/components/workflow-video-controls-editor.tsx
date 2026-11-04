import { Select } from "antd";
import { Switch } from "@/components/ui/base/switch";
import { workflowFieldKey, workflowParameterFields } from "@/lib/model-capabilities";
import { resolveWorkflowVideoControls } from "@/lib/workflow-video-controls";
import type { WorkflowFieldMapping, WorkflowVideoControls } from "@/stores/use-config-store";

export function WorkflowVideoControlsEditor({ fields, value, disabled, onChange }: {
    fields: WorkflowFieldMapping[]; value?: WorkflowVideoControls; disabled?: boolean; onChange: (value: WorkflowVideoControls) => void;
}) {
    const options = workflowParameterFields(fields).map((field) => ({ value: workflowFieldKey(field), label: `${field.label || field.fieldName} · ${field.nodeId}.${field.fieldName}` }));
    const controls = resolveWorkflowVideoControls(fields, value);
    return <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="text-sm font-medium">视频底栏参数映射</div>
        <p className="text-xs text-muted-foreground">将分辨率、长宽比、时长绑定到工作流字段。开启后在视频底栏调整；关闭后仍可在“参数”中填写。未指定的项目仅在找到唯一对应字段时自动匹配。</p>
        {controls.map((control) => <div key={control.key} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs">{control.label}</span>
            <Select className="min-w-0 flex-1" aria-label={`${control.label}映射字段`} showSearch optionFilterProp="label" allowClear placeholder="未映射" value={control.fieldKey || undefined} disabled={disabled} options={options.filter((option) => !controls.some((item) => item.key !== control.key && item.enabled && item.fieldKey === option.value))} onChange={(fieldKey) => onChange({ ...value, [control.key]: { fieldKey: fieldKey || "", enabled: Boolean(fieldKey) } })} />
            <Switch checked={control.enabled} disabled={disabled || !control.field} aria-label={`在视频底栏显示${control.label}`} onChange={(enabled) => onChange({ ...value, [control.key]: { fieldKey: control.fieldKey, enabled } })} />
        </div>)}
    </div>;
}
