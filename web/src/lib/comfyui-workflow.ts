import { defaultModelCapabilityConfig, workflowImageCapabilityConfig, workflowVideoCapabilityConfig, workflowVideoFieldsFromJson, type ModelCapabilityConfig } from "@/lib/model-capabilities";
import { normalizeWorkflowFieldMappings } from "@/stores/use-config-store";
import type { RunningHubCapability, WorkflowFieldMapping } from "@/stores/use-config-store";

export const COMFYUI_WORKFLOW_MAX_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseComfyUIWorkflow(text: string): Record<string, unknown> {
    if (new TextEncoder().encode(text).length > COMFYUI_WORKFLOW_MAX_BYTES) throw new Error("工作流 JSON 不能超过 8 MiB");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("JSON 格式有误，请检查后重新导入"); }
    const workflow = isRecord(parsed) && isRecord(parsed.prompt) ? parsed.prompt : parsed;
    if (!isRecord(workflow) || !Object.keys(workflow).length || Object.keys(workflow).length > 4096) throw new Error("请导入包含 1 至 4096 个节点的 ComfyUI API JSON");
    for (const [id, node] of Object.entries(workflow)) {
        if (!id.trim() || !isRecord(node) || typeof node.class_type !== "string" || !node.class_type.trim() || !isRecord(node.inputs)) {
            throw new Error("请从 ComfyUI 导出 API 格式 JSON，普通界面工作流的 nodes/links 格式无法执行");
        }
        for (const value of Object.values(node.inputs)) {
            if (Array.isArray(value) && value.length === 2 && Number.isInteger(value[1])) {
                if (typeof value[0] !== "string" || !Object.hasOwn(workflow, value[0]) || Number(value[1]) < 0) throw new Error(`节点 ${id} 存在无效连接`);
            }
        }
    }
    return workflow;
}

// Offline imports preserve defaults until the user binds inputs or reads the
// server schema, which can identify positive conditioning without guessing.
export function defaultComfyUIFields(workflow: Record<string, unknown>) {
    return normalizeWorkflowFieldMappings(workflowVideoFieldsFromJson(workflow).map((field) => ({
        ...field,
        source: "",
        fieldType: typeof field.fieldValue === "number" && Number.isInteger(field.fieldValue) ? "INT" : field.fieldType,
    })));
}

export function comfyUICapabilityConfig(capability: RunningHubCapability, fields: WorkflowFieldMapping[], current?: ModelCapabilityConfig): ModelCapabilityConfig | undefined {
    if (capability === "audio") return undefined;
    const fallback = current || defaultModelCapabilityConfig(`comfyui-${capability}`);
    const enabled = fields.filter((field) => field.enabled !== false);
    const slots = (source: string) => enabled.filter((field) => field.source === source).reduce((max, field) => Math.max(max, (source === "referenceImage" ? field.imageOrder : undefined) || (field.sourceIndex || 0) + 1), 0);
    if (capability === "image") {
        const image = workflowImageCapabilityConfig(enabled, fallback.image!);
        image.references = { ...image.references, maxImages: slots("referenceImage"), maskSupported: enabled.some((field) => field.source === "mask") };
        return { ...fallback, image };
    }
    const video = workflowVideoCapabilityConfig(enabled, fallback.video!);
    video.references = { ...video.references, minImages: enabled.some((field) => field.source === "referenceImage" && field.required) ? 1 : 0, maxImages: slots("referenceImage"), maxVideos: slots("referenceVideo"), maxAudios: slots("referenceAudio") };
    return { ...fallback, video };
}
