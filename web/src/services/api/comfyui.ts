import { http } from "@/services/api/request";

export type ComfyUIObjectInput = {
    name: string;
    type: string;
    required: boolean;
    multiline?: boolean;
    /** 只能由上游节点连线提供（CLIP/MODEL/LATENT 等），字段映射必须排除。 */
    link?: boolean;
    options?: unknown[];
    min?: unknown;
    max?: unknown;
    step?: unknown;
    default?: unknown;
};

export type ComfyUIObjectNode = {
    classType: string;
    displayName?: string;
    category?: string;
    inputs: ComfyUIObjectInput[];
};

export type ComfyUIObjectInfo = {
    baseUrl: string;
    nodes: ComfyUIObjectNode[];
};

/**
 * 只读取工作流实际引用的节点定义。上游 /object_info 包含全部节点，
 * 整包回传既慢又超出配置界面所需。
 */
export function fetchComfyUIObjectInfo(baseUrl: string, classTypes: string[]) {
    return http.post<ComfyUIObjectInfo>("/comfyui/object-info", { baseUrl, classTypes });
}
