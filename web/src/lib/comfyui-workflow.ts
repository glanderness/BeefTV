import type { ComfyUIObjectInfo, ComfyUIObjectNode } from "@/services/api/comfyui";
import type { WorkflowFieldMapping } from "@/stores/use-config-store";

export type ComfyUIWorkflowJson = Record<string, unknown>;

/** 从 API 格式工作流里取出引用的节点类型，供 /object_info 做裁剪查询。 */
export function comfyUIWorkflowClassTypes(workflowJson: ComfyUIWorkflowJson): string[] {
    const classTypes = new Set<string>();
    for (const node of comfyUIWorkflowNodes(workflowJson)) {
        const classType = String(node.class_type || "").trim();
        if (classType) classTypes.add(classType);
    }
    return Array.from(classTypes).sort();
}

/** 判断工作流里的值是否为上游连线，形如 ["4", 0]。 */
export function isComfyUILinkValue(value: unknown): boolean {
    return Array.isArray(value) && value.length === 2 && String(value[0] ?? "").trim() !== "" && typeof value[1] === "number";
}

/**
 * 用 /object_info 补全工作流的可配置字段。
 *
 * 连线输入不进入字段映射：它们属于工作流拓扑，写成字面量会断开上游节点
 * 并让 /prompt 校验失败。
 */
export function comfyUIWorkflowFields(workflowJson: ComfyUIWorkflowJson, objectInfo: ComfyUIObjectInfo | undefined): WorkflowFieldMapping[] {
    const nodesByClass = new Map<string, ComfyUIObjectNode>((objectInfo?.nodes || []).map((node) => [node.classType, node]));
    const fields: WorkflowFieldMapping[] = [];
    for (const [nodeId, raw] of Object.entries(workflowJson || {})) {
        if (!isComfyUINode(raw)) continue;
        const classType = String(raw.class_type || "").trim();
        const inputs = raw.inputs;
        if (!classType || !inputs || typeof inputs !== "object" || Array.isArray(inputs)) continue;
        const definition = nodesByClass.get(classType);
        for (const [fieldName, value] of Object.entries(inputs as Record<string, unknown>)) {
            // 上游没有该节点定义时按连线形态判断，避免把连线当字面量写回。
            if (isComfyUILinkValue(value)) continue;
            const spec = definition?.inputs.find((input) => input.name === fieldName);
            if (spec?.link) continue;
            fields.push({
                id: `${nodeId}::${fieldName}`,
                nodeId,
                classType,
                fieldName,
                fieldValue: value,
                fieldType: spec?.type,
                label: `${classType} · ${fieldName}`,
                options: spec?.options,
                min: spec?.min,
                max: spec?.max,
                step: spec?.step,
                required: spec?.required,
                enabled: true,
            });
        }
    }
    return fields;
}

/**
 * 推断提示词槽位。ComfyUI 的文本节点通常成对出现（正向 + 负向），
 * 负向提示词往往带着默认模板文本，必须排除，否则画布提示词会被写进负向槽位。
 */
export function inferComfyUIPromptField(fields: WorkflowFieldMapping[]): WorkflowFieldMapping[] {
    const candidates = fields.filter((field) => String(field.fieldType || "").toUpperCase() === "STRING" && typeof field.fieldValue === "string");
    if (candidates.length === 0) return fields;
    const scored = candidates.map((field) => ({ field, score: comfyUIPromptScore(field) })).sort((left, right) => right.score - left.score);
    const best = scored[0];
    if (!best || best.score <= 0) return fields;
    return fields.map((field) => (field.id === best.field.id ? { ...field, source: "prompt", required: true, sourceAutomatic: true } : field));
}

function comfyUIPromptScore(field: WorkflowFieldMapping): number {
    const classType = String(field.classType || "").toLowerCase();
    const name = String(field.fieldName || "").toLowerCase();
    const value = String(field.fieldValue ?? "").toLowerCase();
    let score = 0;
    if (classType.includes("cliptextencode")) score += 5;
    if (name === "text" || name === "prompt") score += 2;
    if (score === 0) return 0;
    // 负向提示词带有固定的质量词模板；空文本也不是可用的正向槽位。
    if (value.includes("worst quality") || value.includes("negative") || value.includes("embedding:")) score -= 100;
    if (!value.trim()) score -= 10;
    return score;
}

/**
 * ComfyUI 用 `LoadImage` 节点接收参考图，其 `image` 字段是 input 目录的文件名枚举。
 *
 * 该字段的类型是 COMBO 而不是 IMAGE，不会走通用的动态来源推断，因此按节点类型
 * 显式识别，并按字段出现顺序分配图片槽位（从 1 起）。多个 LoadImage 依次成为
 * 首帧、尾帧等槽位，用户可在字段面板中改写顺序。
 */
export function inferComfyUIReferenceImageFields(fields: WorkflowFieldMapping[]): WorkflowFieldMapping[] {
    let order = 0;
    return fields.map((field) => {
        if (!isComfyUILoadImageField(field)) return field;
        order += 1;
        return { ...field, source: "referenceImage", required: true, sourceAutomatic: true, imageOrder: order };
    });
}

function isComfyUILoadImageField(field: WorkflowFieldMapping) {
    const classType = String(field.classType || "").trim().toLowerCase();
    const fieldName = String(field.fieldName || "").trim().toLowerCase();
    return classType === "loadimage" && fieldName === "image";
}

function comfyUIWorkflowNodes(workflowJson: ComfyUIWorkflowJson): Array<Record<string, unknown>> {
    const nodes: Array<Record<string, unknown>> = [];
    for (const raw of Object.values(workflowJson || {})) {
        if (isComfyUINode(raw)) nodes.push(raw);
    }
    return nodes;
}

function isComfyUINode(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
