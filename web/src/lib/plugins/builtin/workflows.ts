import { registerPlugin } from "../plugin-registry";
import { PLUGIN_API_VERSION, type PluginManifest, type RegisteredPlugin } from "../plugin-types";

export const RUNNINGHUB_PLUGIN_ID = "runninghub-workflow-provider";
export const COMFYUI_PLUGIN_ID = "comfyui-workflow-provider";

export type WorkflowProvider = "runninghub" | "comfyui";

export function workflowPluginId(provider: WorkflowProvider) {
	return provider === "comfyui" ? COMFYUI_PLUGIN_ID : RUNNINGHUB_PLUGIN_ID;
}

export function workflowProviderPluginEnabled(statuses: Record<string, string>, provider: WorkflowProvider) {
    return statuses[workflowPluginId(provider)] === "enabled";
}

type WorkflowContributionCapability = "image" | "video" | "audio";

// 工作流能力按 provider 实际支持的范围声明，ComfyUI 第一期不含音频。
function workflowContributions(providerId: string, label: string, capabilities: readonly WorkflowContributionCapability[] = ["image", "video", "audio"]) {
    return capabilities.map((capability) => ({
        id: `${providerId}-${capability}`,
        label: `${label} · ${{ image: "图片", video: "视频", audio: "音频" }[capability]}`,
        providerId,
        capability,
        parameters: [],
    }));
}

const runningHubManifest: PluginManifest = {
        id: RUNNINGHUB_PLUGIN_ID,
        name: "RunningHub 工作流",
        version: "1.0.0",
        publishedAt: "2026-08-25",
        updatedAt: "2026-08-25",
        apiVersion: PLUGIN_API_VERSION,
        description: "在画布中拉取并执行 RunningHub Workflow 与 App，按工作流字段生成图片、视频和音频。",
        documentation:
            "# RunningHub 工作流\n\n该插件把 RunningHub 的 Workflow / App 接入画布工作流节点。API Key、工作流参数和字段映射仍由宿主安全保存并提交，插件本身不接触密钥。\n\n在插件设置中可以打开完整的 RunningHub 配置页，拉取工作流、编辑字段映射并测试请求。",
        author: "内置工作流",
        surfaces: ["node", "settings"],
        permissions: ["generation.run", "external.open"],
        trusted: true,
        runtime: { backend: "trusted-backend", web: "trusted-backend" },
        contributes: { workflows: workflowContributions(RUNNINGHUB_PLUGIN_ID, "RunningHub") },
};

const comfyUIManifest: PluginManifest = {
        id: COMFYUI_PLUGIN_ID,
        name: "ComfyUI 工作流",
        version: "1.0.0",
        publishedAt: "2026-09-26",
        updatedAt: "2026-09-26",
        apiVersion: PLUGIN_API_VERSION,
        description: "连接本地或可信网络内的原生 ComfyUI，按工作流字段生成图片和视频。",
        documentation:
            "# ComfyUI 工作流\n\n该插件把原生 ComfyUI 的 /prompt 工作流接入画布工作流节点。工作流 JSON、字段映射和服务地址由宿主保存并提交，插件本身不接触密钥。\n\nComfyUI 通常部署在本机或可信网络内，需要宿主显式放行该地址后才能访问。",
        author: "内置工作流",
        surfaces: ["node", "settings"],
        permissions: ["generation.run", "external.open"],
        trusted: true,
        runtime: { backend: "trusted-backend", web: "trusted-backend" },
        contributes: { workflows: workflowContributions(COMFYUI_PLUGIN_ID, "ComfyUI", ["image", "video"]) },
};

registerPlugin({ manifest: runningHubManifest } satisfies RegisteredPlugin);
registerPlugin({ manifest: comfyUIManifest } satisfies RegisteredPlugin);
