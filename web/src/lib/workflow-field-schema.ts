import { workflowVideoFieldsFromJson } from "@/lib/model-capabilities";
import type { WorkflowFieldMapping } from "@/stores/use-config-store";

export type WorkflowVideoControlKey = "resolution" | "aspectRatio" | "duration";
export type WorkflowVideoControls = Partial<Record<WorkflowVideoControlKey, { fieldKey: string; enabled: boolean }>>;

// Preserve the media schema returned by the provider when merging raw JSON.
export function workflowSchemaWithSavedMetadata(workflowJson: Record<string, unknown> | undefined, savedFields: WorkflowFieldMapping[]) {
    const savedByKey = new Map(savedFields.map((field) => [`${field.nodeId}::${field.fieldName}`, field]));
    const schemaFields = workflowVideoFieldsFromJson(workflowJson).map((field) => {
        const saved = savedByKey.get(`${field.nodeId}::${field.fieldName}`);
        // JSON 中的文件名只是字符串，不能用它覆盖拉取接口或用户配置的素材类型与角色。
        return saved ? { ...field, fieldType: saved.fieldType || field.fieldType, role: saved.role || field.role } : field;
    });

return schemaFields;
}

export function workflowFieldRange(value: unknown) {
    const candidates: Record<string, unknown>[] = [];
    const add = (item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return;
        const record = item as Record<string, unknown>;
        candidates.push(record);
        add(record.range);
    };
    add(value);
    if (Array.isArray(value)) value.forEach(add);
    const read = (keys: string[]) => candidates.map((item) => keys.map((key) => item[key]).find((candidate) => candidate !== undefined)).find((candidate) => candidate !== undefined);
    return { min: read(["min", "minValue", "min_value"]), max: read(["max", "maxValue", "max_value"]), step: read(["step", "stepValue", "step_value"]) };
}
