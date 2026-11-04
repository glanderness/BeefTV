import { workflowFieldCurrentValue, workflowFieldKey, workflowFieldSource, workflowFieldSubmissionValue, workflowParameterFields, type WorkflowVideoFieldLike } from "@/lib/model-capabilities";
import type { WorkflowVideoControlKey, WorkflowVideoControls } from "@/stores/use-config-store";

export const workflowVideoControlDefinitions: { key: WorkflowVideoControlKey; label: string }[] = [
    { key: "resolution", label: "分辨率" },
    { key: "aspectRatio", label: "长宽比" },
    { key: "duration", label: "时长" },
];

export function resolveWorkflowVideoControls(fields: readonly WorkflowVideoFieldLike[], mapping?: WorkflowVideoControls) {
    const parameters = workflowParameterFields(fields);
    const used = new Set<string>();
    return workflowVideoControlDefinitions.map((definition) => {
        const configured = mapping?.[definition.key];
        // 只自动匹配唯一的语义字段；重复或模糊字段留给用户指定。
        const candidates = parameters.filter((field) => matchesControl(field, definition.key));
        const field = configured ? parameters.find((item) => workflowFieldKey(item) === configured.fieldKey) : candidates.length === 1 ? candidates[0] : undefined;
        const fieldKey = configured?.fieldKey || (field ? workflowFieldKey(field) : "");
        const enabled = Boolean(field && configured?.enabled !== false && !used.has(fieldKey));
        if (enabled) used.add(fieldKey);
        return { ...definition, field, fieldKey, enabled };
    });
}

export function workflowVideoControlFields(fields: readonly WorkflowVideoFieldLike[], mapping?: WorkflowVideoControls) {
    const seen = new Set<string>();
    return resolveWorkflowVideoControls(fields, mapping).flatMap((control) => {
        if (!control.enabled || !control.field || seen.has(control.fieldKey)) return [];
        seen.add(control.fieldKey);
        return [{ ...control.field, label: control.label }];
    });
}

export function workflowVideoControlSummary(fields: readonly WorkflowVideoFieldLike[], mapping: WorkflowVideoControls | undefined, values: Record<string, unknown>) {
    return resolveWorkflowVideoControls(fields, mapping).filter((item) => item.enabled && item.field).map((item) => {
        const value = workflowFieldSubmissionValue(item.field!, workflowFieldCurrentValue(item.field, values));
        const text = String(value ?? "");
        if (item.key === "duration") return `${text}s`;
        if (item.key === "aspectRatio") return text.match(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?/)?.[0] || text;
        return text;
    }).filter(Boolean).join(" · ");
}

export function workflowParameterDefaults(fields: readonly WorkflowVideoFieldLike[], values: Record<string, unknown>) {
    return Object.fromEntries(workflowParameterFields(fields).flatMap((field) => {
        const value = workflowFieldCurrentValue(field, values);
        return value === undefined ? [] : [[workflowFieldKey(field), value]];
    }));
}

function matchesControl(field: WorkflowVideoFieldLike, key: WorkflowVideoControlKey) {
    const source = workflowFieldSource(field);
    const semantic = `${field.fieldName || ""} ${field.label || ""}`.toLowerCase().replace(/[_-]/g, " ");
    if (key === "resolution") return source === "vquality" || /\bresolution\b|\bvquality\b|分辨率|清晰度/.test(semantic) && !/\baspect\b|\bratio\b|比例/.test(semantic);
    if (key === "aspectRatio") return source === "aspectratio" || /\baspect\s*ratio\b|长宽比|宽高比/.test(semantic);
    return source === "videoseconds" || /\bduration\b|\bseconds\b|时长|秒数/.test(semantic);
}
