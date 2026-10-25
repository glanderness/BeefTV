import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import type { CanvasNodeData } from "@/types/canvas";

const COPY_SUFFIX = /(_copy\d+|\s+Copy)$/i;
const VERSION_SUFFIX = /\s*·\s*([A-Z])\s*$/;
const PROMPT_TITLE_LENGTH = 32;

export function buildImageGenerationNodeTitle(prompt: string, sourceNode?: CanvasNodeData, outputIndex?: number, outputCount = 1) {
    let title = prompt.trim().slice(0, PROMPT_TITLE_LENGTH) || "Generated Image";
    if (sourceNode) {
        const sourceTitleWithoutVersion = sourceNode.title.replace(VERSION_SUFFIX, "");
        const copySuffix = sourceTitleWithoutVersion.match(COPY_SUFFIX)?.[1] || "";
        const versionLabel = validVersionLabel(sourceNode.metadata?.versionLabel) || sourceNode.title.match(VERSION_SUFFIX)?.[1] || "";
        const titleWithoutVersion = title.replace(VERSION_SUFFIX, "");
        if (copySuffix && !titleWithoutVersion.toLowerCase().endsWith(copySuffix.toLowerCase())) title += copySuffix;
        if (versionLabel && !title.endsWith(` · ${versionLabel}`)) title += ` · ${versionLabel}`;
    }
    if (outputCount > 1 && outputIndex !== undefined) title += ` · ${outputIndex + 1}`;
    return title;
}

function validVersionLabel(value?: string) {
    const normalized = value?.trim().toUpperCase() || "";
    return /^[A-Z]$/.test(normalized) ? normalized : "";
}

/**
 * 把提示词写进一个已存在的节点（例如从文本节点发起点生成图片）时，决定这个节点叫什么。
 *
 * 飞书需求 #66：生成完成后不要替换对应节点上面的名称。只有当节点还没有名字、
 * 名称仍是该类型的默认名，或者名称就是上一次按提示词自动生成的，才跟着提示词改名；
 * 用户或工作流起过的名字保持不动。返回值里的 autoTitle 需要在写回节点时一起保存，
 * 下次生成才能认出「这个名字是我自己起的」还是「这个名字是用户起的」。
 */
export function resolvePromptNodeTitle(node: CanvasNodeData, prompt: string): { title: string; autoTitle?: string } {
    const promptTitle = prompt.trim().slice(0, PROMPT_TITLE_LENGTH) || "Prompt";
    const currentTitle = node.title?.trim() || "";
    const previousAutoTitle = node.metadata?.autoTitle || undefined;
    if (!currentTitle) return { title: promptTitle, autoTitle: promptTitle };
    const defaultTitle = defaultNodeTitle(node.type);
    const systemOwned = currentTitle === previousAutoTitle || (defaultTitle !== undefined && currentTitle === defaultTitle);
    return systemOwned ? { title: promptTitle, autoTitle: promptTitle } : { title: node.title, autoTitle: previousAutoTitle };
}

function defaultNodeTitle(type: CanvasNodeData["type"]) {
    const defaults = NODE_DEFAULT_SIZE as Record<string, { title?: string } | undefined>;
    return defaults[type]?.title;
}
