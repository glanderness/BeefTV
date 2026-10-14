import { workflowFieldCurrentValue, workflowFieldRandomKey, workflowFieldValueError, workflowParameterFields } from "@/lib/model-capabilities";
import type { WorkflowFieldMapping } from "@/stores/use-config-store";
import type { CanvasResourceReference } from "./canvas-resource-references";

export function workflowMediaSlotIndex(field: WorkflowFieldMapping) {
    if (field.source === "referenceImage" && Number(field.imageOrder) > 0) return Number(field.imageOrder) - 1;
    return Math.max(0, Number(field.sourceIndex) || 0);
}

export function workflowSlotReference(field: WorkflowFieldMapping, references: CanvasResourceReference[]) {
    const kind = field.source === "referenceVideo" ? "video" : field.source === "referenceAudio" ? "audio" : "image";
    if (field.source === "mask") return undefined;
    // 工作流角色卡只物化一张主参考图，与普通图片混排且各占一个槽位。
    return references.filter((item) => item.kind === kind || kind === "image" && item.kind === "character")[workflowMediaSlotIndex(field)];
}

export function canvasWorkflowInputError(fields: WorkflowFieldMapping[], references: CanvasResourceReference[], values: Record<string, unknown>) {
    for (const field of fields) {
        if (field.enabled === false || !field.required || !["referenceImage", "referenceVideo", "referenceAudio", "mask"].includes(field.source || "")) continue;
        if (!workflowSlotReference(field, references)) return field.source === "mask" ? "当前节点尚未配置蒙版输入，请使用不需要蒙版的工作流" : `请连接素材：${field.label || field.fieldName}（槽位 ${workflowMediaSlotIndex(field) + 1}）`;
    }
    for (const field of workflowParameterFields(fields)) {
        const random = values[workflowFieldRandomKey(field)] ?? field.randomEnabled;
        if (random === true) continue;
        const error = workflowFieldValueError(field, workflowFieldCurrentValue(field, values) ?? "");
        if (error) return `${field.label || field.fieldName}：${error}`;
    }
    return "";
}
